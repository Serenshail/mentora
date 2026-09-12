import { NextRequest } from "next/server";
import { dbGet, dbPut } from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const FIELDS = ["goals", "knowledge", "books", "sessions", "customPersonas"] as const;

function sanitize(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = data[k] ?? [];
  const settings = (data.settings ?? {}) as Record<string, unknown>;
  // apiKey 永不上云
  out.settings = { ...settings, apiKey: "" };
  return out;
}

/** 拉取云端快照 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const file = await dbGet<{ data: Record<string, unknown>; updatedAt: string }>(
      `data/${user.userId}.json`,
      { encrypted: true }
    );
    if (!file) return Response.json({ data: null });
    const { _sha, ...rest } = file;
    return Response.json({ data: rest.data ?? rest, updatedAt: rest.updatedAt });
  } catch {
    return Response.json({ error: "云端读取失败" }, { status: 503 });
  }
}

/** 上传本地快照（last-write-wins） */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body?.data) return Response.json({ error: "缺少 data" }, { status: 400 });

  const payload = { data: sanitize(body.data), updatedAt: new Date().toISOString(), userId: user.userId };
  try {
    const cur = await dbGet<{ userId: string }>(`data/${user.userId}.json`, { encrypted: true });
    // 覆盖他人/旧数据前确认归属（userId 不同视为新快照仍可写——同用户唯一）
    await dbPut(`data/${user.userId}.json`, payload, {
      encrypted: true,
      sha: cur?._sha ?? null,
      overwriteOnConflict: true,
    });
    return Response.json({ ok: true, updatedAt: payload.updatedAt });
  } catch {
    return Response.json({ error: "云端写入失败" }, { status: 503 });
  }
}
