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

export async function runWikiCompile(limit = 3): Promise<CompileResult> {
  const res: CompileResult = { linked: 0, merges: [], conflicts: [], processed: 0, failed: 0 };
  const notes = useAppStore
    .getState()
    .knowledge.filter((k) => !(k.tags ?? []).includes("MOC") && !k.unresolved);
  const targets = notes.filter((k) => (k.links ?? []).length === 0).slice(0, limit);

  for (const t of targets) {
    const others = notes.filter((k) => k.id !== t.id);
    if (others.length === 0) continue;
    const seeds = bm25Search(
      `${t.title} ${t.body.slice(0, 300)}`,
      others.map((k) => ({ id: k.id, title: k.title, body: k.body })),
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
      full = await streamChat({
        task: "wiki-compile",
        args: { target: `${t.title}\n${t.body.slice(0, 1500)}`, candidates: cand },
        messages: [{ role: "user", content: "编译。" }],
        temperature: 0.2,
        onDelta: () => {},
      });
    } catch (e) {
      /* 失败不再静默：BYOK 失效/配额/网络故障全失败时不能被呈现成"没有笔记需要编译"的假空态 */
      res.failed++;
      res.lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    let ops: CompileOps;
    try {
      ops = extractJson<CompileOps>(full);
    } catch (e) {
      res.failed++;
      res.lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    res.processed++;

    const byTitle = new Map(notes.map((k) => [k.title, k.id]));
    const addIds = (ops.links ?? [])
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
