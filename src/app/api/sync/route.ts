import { NextRequest } from "next/server";
import { dbGet, dbPut, dbList, dbDelete } from "@/lib/server/db";
import { verifySession } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";
import zlib from "node:zlib";

export const runtime = "nodejs";
export const maxDuration = 60;

const FIELDS = ["goals", "knowledge", "books", "sessions", "customPersonas"] as const;

/* v17 数据生命线加固：
 * ① 体积闸：请求体上限 4.2MB（Vercel 4.5MB 前的自我裁决，给 413 一个明确文案）；
 *    gzip 解压后上限 64MB——堵死"压缩炸弹直通 gunzipSync"。
 * ② 版本快照：每次覆盖写之前，把**上一份**云端快照存档到 versions/<ts>.json，
 *    滚动保留最近 10 份。此前云端永远只有一份 last-write-wins 快照，
 *    多设备互相覆盖/误删之后无任何可回滚点（历史两次"数据消失"事故的根因模型）。
 * ③ 存档失败不阻断本次写入（可用性优先），但绝不静默吞——logEvent 记一条。 */

const MAX_BODY_BYTES = 4.2 * 1024 * 1024;
const MAX_DECOMPRESSED = 64 * 1024 * 1024;
const KEEP_VERSIONS = 10;

function sanitize(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) out[k] = data[k] ?? [];
  const settings = (data.settings ?? {}) as Record<string, unknown>;
  // apiKey 永不上云
  out.settings = { ...settings, apiKey: "" };
  return out;
}

const snapPath = (userId: string) => `data/${userId}.json`;
const verDir = (userId: string) => `versions/${userId}`;

/** 把当前云端快照存档为历史版本，并裁剪到最近 KEEP_VERSIONS 份（尽力而为，失败只记日志） */
async function archivePrevious(userId: string, prev: { data?: unknown; updatedAt?: string } | null) {
  if (!prev?.data || !prev.updatedAt) {
    logEvent({ ev: "sync", msg: "archive-skip", userId, hasData: Boolean(prev?.data), hasTs: Boolean(prev?.updatedAt) });
    return;
  }
  const ts = Date.parse(prev.updatedAt);
  if (Number.isNaN(ts)) return;
  try {
    const existing = (await dbList(verDir(userId)))
      .map((f) => Number(f.name.replace(".json", "")))
      .filter((n) => !Number.isNaN(n));
    if (existing.some((n) => n >= ts)) return; // 该版本已存档过
    await dbPut(`${verDir(userId)}/${ts}.json`, prev, { encrypted: true });
    logEvent({ ev: "sync", msg: "archived", userId, ts });
    const all = (await dbList(verDir(userId)))
      .map((f) => Number(f.name.replace(".json", "")))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    while (all.length > KEEP_VERSIONS) {
      const oldest = all.shift();
      await dbDelete(`${verDir(userId)}/${oldest}.json`, null).catch(() => {});
    }
  } catch (e) {
    logEvent({ ev: "sync", msg: "archive-failed", userId, err: e instanceof Error ? e.message : String(e) });
  }
}

/** 拉取云端快照（大快照自动 gzip，绕开 4.5MB 响应限制）。
 *  查询参数：?versions=1 列出历史版本时间戳；?v=<ts> 拉取指定历史版本。 */
export async function GET(req: NextRequest) {
  const user = await verifySession();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  /* GET 也要分桶：插件/多端轮询会反复全量读。与 POST 分开计数，
   * 避免正常写同步把读配额挤掉（反之亦然）。 */
  if (!(await rateLimitPersistent(`sync:get:${clientIp(req)}`, { capacity: 30, refillPerSec: 30 / 60 }))) {
    return Response.json({ error: "请求过于频繁" }, { status: 429 });
  }
  const { searchParams } = new URL(req.url);

  try {
    if (searchParams.has("versions")) {
      const ts = (await dbList(verDir(user.userId)))
        .map((f) => Number(f.name.replace(".json", "")))
        .filter((n) => !Number.isNaN(n))
        .sort((a, b) => b - a);
      return Response.json({ versions: ts });
    }

    const v = searchParams.get("v");
    const path = v && /^\d+$/.test(v) ? `${verDir(user.userId)}/${v}.json` : snapPath(user.userId);
    const file = await dbGet<{ data: Record<string, unknown>; updatedAt: string }>(path, {
      encrypted: true,
    });
    if (!file) return Response.json({ data: null });
    const { _sha, ...rest } = file;
    const body = JSON.stringify({ data: rest.data ?? rest, updatedAt: rest.updatedAt });
    /* 读侧体积闸：写侧虽有 64MB 解压闸，但响应侧此前只靠 Vercel 平台 4.5MB 硬失败兜底——
     * 自托管连平台闸都没有，明文通道会原样吐几十 MB。超限给明确 413，不静默截断。 */
    // plain=1：客户端（微信小程序等）无法解压 x-gzip，显式要明文 JSON。
    const plain = searchParams.has("plain");
    if (plain && body.length > MAX_BODY_BYTES) {
      return Response.json(
        { error: "云端快照过大，明文通道无法下发（请用支持 gzip 的端同步，或精简第二大脑内容）" },
        { status: 413 }
      );
    }
    if (!plain && body.length > 1024 * 1024) {
      const gz = zlib.gzipSync(Buffer.from(body, "utf8"), { level: 9 });
      if (gz.length > MAX_BODY_BYTES) {
        return Response.json({ error: "云端快照过大，无法下发，请精简第二大脑内容" }, { status: 413 });
      }
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

/** 上传本地快照（last-write-wins，但覆盖前自动存档上一份；大快照以 application/x-gzip 上传） */
export async function POST(req: NextRequest) {
  const user = await verifySession();
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  /* 写放大最重的端点（读旧快照+归档+分块写）：自动同步 2.5s 防抖正常上限约 24 次/分，
   * 给到 60 次/分只拦重试风暴/脚本刷写，不影响真实编辑节奏。 */
  if (!(await rateLimitPersistent(`sync:post:${clientIp(req)}`, { capacity: 60, refillPerSec: 1 }))) {
    return Response.json({ error: "同步太频繁，请稍后再试" }, { status: 429 });
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return Response.json({ error: "同步包过大，请清理第二大脑后重试" }, { status: 413 });
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    if ((req.headers.get("content-type") ?? "").includes("application/x-gzip")) {
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length > MAX_BODY_BYTES) {
        return Response.json({ error: "同步包过大，请清理第二大脑后重试" }, { status: 413 });
      }
      // maxOutputLength 让 gunzip 在内存里撑爆之前就失败（解压炸弹在此闸死，而不是解完 4GB 才被拒）
      let plain: Buffer;
      try {
        plain = zlib.gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED });
      } catch {
        return Response.json({ error: "解压后数据过大，已拒绝" }, { status: 413 });
      }
      if (plain.length > MAX_DECOMPRESSED) {
        return Response.json({ error: "解压后数据过大，已拒绝" }, { status: 413 });
      }
      parsed = JSON.parse(plain.toString("utf8"));
    } else {
      /* JSON 分支同样过体积闸：content-length 可被省略（chunked），必须读出来量 */
      const txt = await req.text();
      if (Buffer.byteLength(txt) > MAX_BODY_BYTES) {
        return Response.json({ error: "同步包过大，请清理第二大脑后重试" }, { status: 413 });
      }
      parsed = JSON.parse(txt);
    }
  } catch {
    parsed = null;
  }
  if (!parsed?.data || typeof parsed.data !== "object") {
    return Response.json({ error: "缺少 data" }, { status: 400 });
  }

  const payload = {
    data: sanitize(parsed.data as Record<string, unknown>),
    updatedAt: new Date().toISOString(),
    userId: user.userId,
  };
  try {
    const cur = await dbGet<{ userId: string; data?: unknown; updatedAt?: string }>(
      snapPath(user.userId),
      { encrypted: true }
    );
    // 先存档、再覆盖：云端自此有回滚点
    await archivePrevious(user.userId, cur);
    await dbPut(snapPath(user.userId), payload, {
      encrypted: true,
      sha: cur?._sha ?? null,
      overwriteOnConflict: true,
    });
    return Response.json({ ok: true, updatedAt: payload.updatedAt });
  } catch {
    return Response.json({ error: "云端写入失败" }, { status: 503 });
  }
}
