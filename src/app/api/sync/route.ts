import { NextRequest } from "next/server";
import { dbGet, dbPut } from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth";
import zlib from "node:zlib";

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

/** 拉取云端快照（大快照自动 gzip，绕开 4.5MB 响应限制） */
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
    const body = JSON.stringify({ data: rest.data ?? rest, updatedAt: rest.updatedAt });
    if (body.length > 1024 * 1024) {
      const gz = zlib.gzipSync(Buffer.from(body, "utf8"), { level: 9 });
      return new Response(gz, {
        headers: { "Content-Type": "application/x-gzip", "Cache-Control": "no-store" },
      });
    }
    return new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "云端读取失败" }, { status: 503 });
  }
}

/** 上传本地快照（last-write-wins；大快照以 application/x-gzip 原始 gzip 上传） */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });

  let parsed: Record<string, unknown> | null = null;
  try {
    if (req.headers.get("content-type") === "application/x-gzip") {
      const buf = Buffer.from(await req.arrayBuffer());
      parsed = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
    } else {
      parsed = await req.json();
    }
  } catch {
    parsed = null;
  }
  if (!parsed?.data) return Response.json({ error: "缺少 data" }, { status: 400 });

  const payload = { data: sanitize(parsed.data as Record<string, unknown>), updatedAt: new Date().toISOString(), userId: user.userId };
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
