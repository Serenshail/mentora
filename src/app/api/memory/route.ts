import { NextRequest } from "next/server";
import { verifyAnyAuth } from "@/lib/server/device-auth";
import { rateLimitPersistent } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";
import {
  addMemory,
  deleteMemory,
  isValidItemId,
  listMemory,
  sanitizeMemoryInput,
} from "@/lib/server/personal";

export const runtime = "nodejs";

/* 长期记忆（v24.0 二期）：用户级事实，条目化存加密 KV；
 * 检索 = 关键词/标签匹配（不做向量），注入时取最近若干条摘要。
 * v27：鉴权扩展为会话 cookie 或设备令牌（Obsidian 插件的记忆工具走后者）。 */

async function guard(bucket: string, req: NextRequest) {
  const session = await verifyAnyAuth(req);
  if (!session) return { error: Response.json({ error: "请先登录" }, { status: 401 }) };
  const ok = await rateLimitPersistent(`${bucket}:${session.userId}`, { capacity: 40, refillPerSec: 40 / 60 });
  if (!ok) return { error: Response.json({ error: "操作太频繁，稍后再试" }, { status: 429 }) };
  return { userId: session.userId };
}

/** 简单相关性：文本/标签是否包含查询词（中文按 2-gram 命中即可用） */
function matches(text: string, q: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  const needle = q.toLowerCase().trim();
  if (t.includes(needle)) return true;
  /* 中文长查询拆词：逐字窗口 2 字命中一半以上即算相关 */
  if (needle.length >= 4) {
    let hit = 0;
    const total = needle.length - 1;
    for (let i = 0; i < total; i++) if (t.includes(needle.slice(i, i + 2))) hit++;
    return hit / total >= 0.5;
  }
  return false;
}

export async function GET(req: NextRequest) {
  const g = await guard("memory-read", req);
  if (g.error) return g.error;
  const q = (req.nextUrl.searchParams.get("q") || "").slice(0, 60);
  const limit = Math.max(0, Math.min(Number(req.nextUrl.searchParams.get("limit") || 0) || 0, 200));
  /* 读失败必须与"真的没有记忆"可区分（与 GET /api/reminders 同纪律）：
   * 旧实现 .catch(() => []) 把通道故障折叠成 200 + 空数组，前端数据结构里根本没有
   * 错误通道，永远只能渲染"暂无记忆"的空态，无法区分失败也无重试引导。 */
  let all: Awaited<ReturnType<typeof listMemory>>;
  try {
    all = await listMemory(g.userId);
  } catch (e) {
    logEvent({ route: "memory", ev: "list-read-fail", userId: g.userId, msg: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "记忆列表暂时读取失败，稍后再试" }, { status: 503 });
  }
  const filtered = q ? all.filter((m) => matches(`${m.text} ${m.tags.join(" ")}`, q)) : all;
  return Response.json({ entries: limit ? filtered.slice(0, limit) : filtered, total: all.length });
}

export async function POST(req: NextRequest) {
  const g = await guard("memory-write", req);
  if (g.error) return g.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const clean = sanitizeMemoryInput(body);
  if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
  /* addMemory 内部走 listMemory→dbList 与 dbPut，通道故障按数据层纪律直接 throw。
   * 必须与本文件 GET/DELETE 同口径包住：裸异常穿透到 Next 兜底 = 非 JSON 的裸 500，
   * 既没有本文件承诺的错误语义，也没有 logEvent 留痕（GET/DELETE 故障均有记录可查）。 */
  let out: Awaited<ReturnType<typeof addMemory>>;
  try {
    out = await addMemory(g.userId, clean);
  } catch (e) {
    logEvent({ route: "memory", ev: "add-fail", userId: g.userId, msg: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "写入失败，请稍后再试" }, { status: 503 });
  }
  if ("error" in out) return Response.json({ error: out.error }, { status: 400 });
  return Response.json({ entry: out });
}

export async function DELETE(req: NextRequest) {
  const g = await guard("memory-write", req);
  if (g.error) return g.error;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
  if (!isValidItemId(id)) return Response.json({ error: "id 不合法" }, { status: 400 });
  /* 删除失败必须如实回 503：旧实现 deleteMemory 吞掉失败、这里无条件 ok:true，
   * 用户看到"删成功"但条目仍在（刷新后"复活"），失败全程不可见。 */
  try {
    await deleteMemory(g.userId, id);
  } catch (e) {
    logEvent({ route: "memory", ev: "delete-fail", userId: g.userId, id, msg: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "删除失败，请稍后再试" }, { status: 503 });
  }
  return Response.json({ ok: true });
}
