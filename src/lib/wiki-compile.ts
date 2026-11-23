"use client";

/* LLMWiki 编译 pass：把孤立/新增笔记"编译"进双链 wiki。
 * 对每个目标笔记,服务端 WIKI_COMPILE 返回 ops(建链/合并建议/冲突标记/摘要),
 * 客户端应用"建链"(图导航的基础),合并与冲突作为建议 surfaced 给用户确认(不自动删改)。
 * 链接越密 → wikiRetrieve 导航越准 → 知识库随使用复利,构成技术护城河。 */

import { streamChat, extractJson } from "@/lib/ai/client";
import { useAppStore } from "@/lib/store";
import { bm25Search } from "@/lib/rag";

interface CompileOps {
  links?: string[];
  mergeInto?: string | null;
  conflict?: { with: string; reason: string } | null;
  summary?: string;
}

export interface CompileResult {
  linked: number;
  merges: string[];
  conflicts: string[];
  processed: number;
  /** 逐笔记编译失败数与最后一个错误：全失败时调用方必须能区分"没活干"和"干不了" */
  failed: number;
  lastError?: string;
}

/** 竞速用户取消：signal 一旦中止立即以 "cancelled" 胜出，调用方据此停止后续篇目。
 * 不把外部 signal 并进 fetch（AbortSignal.any）是有意的：本文件的回归锁
 * wiki-compile-timeout.test.ts 要求每处 streamChat 实参字面持有
 * signal: AbortSignal.timeout(45_000)，45s 预算防线不得移形。取消胜出时，在途
 * 请求按自己的 45s 预算自行收尾、结果弃置不落库（raceWithCancel 已为被弃的
 * promise 挂 no-op catch，不会有 unhandled rejection）；UI 立即解锁。 */
function raceWithCancel<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | "cancelled"> {
  void p.catch(() => {}); // 取消胜出时原 promise 无人 await：防 unhandled rejection
  if (!signal) return p;
  return new Promise<T | "cancelled">((resolve, reject) => {
    if (signal.aborted) {
      resolve("cancelled");
      return;
    }
    const onAbort = () => resolve("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

export async function runWikiCompile(limit = 3, signal?: AbortSignal): Promise<CompileResult> {
  const res: CompileResult = { linked: 0, merges: [], conflicts: [], processed: 0, failed: 0 };
  const notes = useAppStore
    .getState()
    .knowledge.filter((k) => !(k.tags ?? []).includes("MOC") && !k.unresolved);
  const targets = notes.filter((k) => (k.links ?? []).length === 0).slice(0, limit);

  for (const t of targets) {
    /* 调用方「取消」（note-workspace 的 AI 中断态）：篇与篇之间检查点，中止不再计为失败 */
    if (signal?.aborted) break;
    const others = notes.filter((k) => k.id !== t.id);
    if (others.length === 0) continue;
    const seeds = bm25Search(
      `${t.title} ${t.body.slice(0, 300)}`,
      /* 带上 version/updatedAt：bm25Search 的分词/词频缓存以 id+版本+时间戳做键，
       * 这里若只传 id/title/body，笔记改完正文后仍会命中旧分词（其余调用方都已传）。 */
      others.map((k) => ({ id: k.id, title: k.title, body: k.body, version: k.version, updatedAt: k.updatedAt })),
      8
    );
    const cand = seeds
      .map((h) => {
        const n = others.find((k) => k.id === h.doc.id);
        if (!n) return "";
        return `- ${n.title}：${n.body.slice(0, 80)}`;
      })
      .filter(Boolean)
      .join("\n");

    let full: string;
    try {
      /* 串行 AI 调用必须带超时：调用方「AI 整理」按钮期间 aiBusy=true 会锁定其余 AI
       * 按钮，弱网下不设超时会让按钮永久停在「AI 中…」（与同页 aiNote/autolink
       * 的 AbortSignal.timeout(45_000) 既有标准一致）。每篇独立 45s 预算、串行最多 3 篇，
       * 总等待有上界；超时走下方既有 catch 计入 failed/lastError，不会呈现成假空态。
       * signal 参数（调用方「取消」按钮）不并入 fetch signal，经 raceWithCancel 竞速：
       * 用户取消立即停止后续篇目（见函数头注释）。 */
      full = await raceWithCancel(
        streamChat({
          task: "wiki-compile",
          args: { target: `${t.title}\n${t.body.slice(0, 1500)}`, candidates: cand },
          messages: [{ role: "user", content: "编译。" }],
          temperature: 0.2,
          signal: AbortSignal.timeout(45_000),
          onDelta: () => {},
        }),
        signal
      );
    } catch (e) {
      /* 用户主动取消：不算失败，直接退出循环（篇间检查点也会兜住） */
      if (signal?.aborted) break;
      /* 失败不再静默：BYOK 失效/配额/网络故障全失败时不能被呈现成"没有笔记需要编译"的假空态 */
      res.failed++;
      res.lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    /* 取消胜出：本篇结果弃置（不应用 ops），停止后续篇目 */
    if (full === "cancelled") break;
    let ops: CompileOps;
    try {
      const parsed = extractJson<CompileOps | null>(full);
      /* extractJson 对模型输出字面量 "null" 是"成功"的（JSON.parse("null") 不抛错），
       * 数组/标量同理。旧实现把解引用 ops.links 放在 try 之外，ops 为 null 时 TypeError
       * 冲出本函数，把已累计的 linked/merges/conflicts 一并冲掉并中断剩余目标
       * （调用方只看到「wiki 编译失败」）。非对象一律按单篇失败计：既不假成功也不中断。 */
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("模型未返回可用的编译结果");
      }
      ops = parsed;
    } catch (e) {
      res.failed++;
      res.lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    res.processed++;

    const byTitle = new Map(notes.map((k) => [k.title, k.id]));
    /* links 也按"模型可能乱输出"设防：非数组（字符串/对象/数字）不能进 .map，
     * 数组里的非字符串条目也不能进 ti.trim()——两者都会在 try 外抛 TypeError。 */
    const addIds = (Array.isArray(ops.links) ? ops.links : [])
      .filter((ti) => typeof ti === "string")
      .map((ti) => byTitle.get(ti.trim()))
      .filter((x): x is string => !!x && x !== t.id);
    if (addIds.length) {
      useAppStore.getState().updateKnowledge(t.id, {
        links: [...new Set([...(t.links ?? []), ...addIds])],
      });
      res.linked += addIds.length;
    }
    if (ops.mergeInto) res.merges.push(`${t.title} → ${ops.mergeInto}`);
    if (ops.conflict?.with) {
      res.conflicts.push(`${t.title} ↔ ${ops.conflict.with}（${ops.conflict.reason}）`);
      useAppStore.getState().updateKnowledge(t.id, {
        tags: [...new Set([...(t.tags ?? []), "conflict"])],
      });
    }
  }
  return res;
}
