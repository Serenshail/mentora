import { NextRequest } from "next/server";
import { verifyAnyAuth } from "@/lib/server/device-auth";
import { rateLimitPersistent } from "@/lib/server/rate-limit";
import { isDeployed } from "@/lib/server/deploy-env";
import {
  addMemory,
  deleteMemory,
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
  void isDeployed();
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
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 0) || 0, 200);
  const all = await listMemory(g.userId).catch(() => []);
  const filtered = q ? all.filter((m) => matches(`${m.text} ${m.tags.join(" ")}`, q)) : all;
  return Response.json({ entries: limit ? filtered.slice(0, limit) : filtered, total: all.length });
}

export async function POST(req: NextRequest) {
  const g = await guard("memory-write", req);
  if (g.error) return g.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const clean = sanitizeMemoryInput(body);
  if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
  const out = await addMemory(g.userId, clean);
  if ("error" in out) return Response.json({ error: out.error }, { status: 400 });
  return Response.json({ entry: out });
}

export async function DELETE(req: NextRequest) {
  const g = await guard("memory-write", req);
  if (g.error) return g.error;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
  await deleteMemory(g.userId, id);
  return Response.json({ ok: true });
}
