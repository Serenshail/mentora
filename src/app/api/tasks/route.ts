import { NextRequest } from "next/server";
import { verifySession } from "@/lib/server/auth";
import { dbPut, dbGet, dbList } from "@/lib/server/db";
import { isDeployed } from "@/lib/server/deploy-env";

export const runtime = "nodejs";

/* 计划生成任务状态持久化（V26.1 P0：整页刷新后仍可查询任务发生过）。
 * KV：tasks/<userId>/<taskId>.json（加密，userId 取自会话）。
 * 客户端 fire-and-forget 写入；这里只做归属校验与读写，不做执行。 */

interface TaskRecord {
  taskId: string;
  goalId: string;
  kind: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  error?: string;
}

const VALID_STATUS = new Set(["running", "completed", "failed", "interrupted"]);

export async function GET(req: NextRequest) {
  const session = await verifySession();
  if (!session) return Response.json({ error: "请先登录" }, { status: 401 });
  const goalId = req.nextUrl.searchParams.get("goalId") || "";
  if (goalId) {
    const items = await dbList(`tasks/${session.userId}`).catch(() => []);
    const out: TaskRecord[] = [];
    for (const it of items.slice(0, 50)) {
      if (!it.name.endsWith(".json")) continue;
      const t = await dbGet<TaskRecord>(`tasks/${session.userId}/${it.name}`, { encrypted: true }).catch(() => null);
      if (t && t.goalId === goalId) out.push(t);
    }
    return Response.json({ tasks: out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) });
  }
  const items = await dbList(`tasks/${session.userId}`).catch(() => []);
  const out: TaskRecord[] = [];
  for (const it of items.slice(0, 100)) {
    if (!it.name.endsWith(".json")) continue;
    const t = await dbGet<TaskRecord>(`tasks/${session.userId}/${it.name}`, { encrypted: true }).catch(() => null);
    if (t) out.push(t);
  }
  return Response.json({ tasks: out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)) });
}

export async function POST(req: NextRequest) {
  const session = await verifySession();
  if (!session) return Response.json({ error: "请先登录" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Partial<TaskRecord>;
  const taskId = String(body.taskId ?? "").slice(0, 64);
  const goalId = String(body.goalId ?? "").slice(0, 64);
  const status = String(body.status ?? "");
  if (!taskId || !goalId || !VALID_STATUS.has(status)) {
    return Response.json({ error: "参数不完整" }, { status: 400 });
  }
  const prev = await dbGet<TaskRecord>(`tasks/${session.userId}/${taskId}.json`, { encrypted: true }).catch(() => null);
  const record: TaskRecord = {
    taskId,
    goalId,
    kind: String(body.kind ?? "master").slice(0, 20),
    status: status as TaskRecord["status"],
    startedAt: prev?.startedAt || String(body.startedAt ?? "") || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: body.error ? String(body.error).slice(0, 200) : undefined,
  };
  await dbPut(`tasks/${session.userId}/${taskId}.json`, record, { encrypted: true }).catch(() => {});
  return Response.json({ ok: true });
}
