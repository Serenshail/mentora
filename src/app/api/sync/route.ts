import { NextRequest } from "next/server";
import { dbGet, dbPut, dbList, dbDelete, dbChannel, encrypt } from "@/lib/server/db";
import { commitSnapshot } from "@/lib/server/snapshot-store";
import { isConcurrentWriteError, type Expectation, type SnapshotPayload, type VersionToken } from "@/lib/server/snapshot-types";
import { verifyAnyAuth } from "@/lib/server/device-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";
import zlib from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { readBytesBodyWithLimit, readTextBodyWithLimit } from "@/lib/server/body-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

/* agentSessions（主对话框多会话，v27 加入）：
 * 此前仅 localStorage——换设备丢全部主对话历史（AUDIT-V26.1 C2 债）。
 * 入云后插件端（设备令牌）与 Web 端共享会话，PRD 场景 C「其他端验证会话」成立。
 * agentActiveId 仍不同步：那是 UI 焦点状态，跨端回写会拽动视图（v26.1.5 教训）。 */
const FIELDS = ["goals", "knowledge", "books", "sessions", "customPersonas", "agentSessions"] as const;

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
  if (Array.isArray(data.folders)) out.folders = data.folders.filter((name): name is string => typeof name === "string").slice(0, 10000);
  const settings = (data.settings ?? {}) as Record<string, unknown>;
  // apiKey 永不上云
  out.settings = { ...settings, apiKey: "" };
  return out;
}

const snapPath = (userId: string) => `data/${userId}.json`;
const verDir = (userId: string) => `versions/${userId}`;

/** 把当前云端快照存档为历史版本，并裁剪到最近 KEEP_VERSIONS 份（尽力而为，失败只记日志） */
async function archivePrevious(
  userId: string,
  prev: { data?: unknown; updatedAt?: string } | null
): Promise<"archived" | "exists" | "failed"> {
  if (!prev?.data || !prev.updatedAt) {
    logEvent({ ev: "sync", msg: "archive-skip", userId, hasData: Boolean(prev?.data), hasTs: Boolean(prev?.updatedAt) });
    return "exists";
  }
  const ts = Date.parse(prev.updatedAt);
  if (Number.isNaN(ts)) return "exists";
  try {
    const existing = (await dbList(verDir(userId)))
      .map((f) => Number(f.name.replace(".json", "")))
      .filter((n) => !Number.isNaN(n));
    if (existing.some((n) => n >= ts)) return "exists"; // 该版本已存档过
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
    return "archived";
  } catch (e) {
    logEvent({ ev: "sync", msg: "archive-failed", userId, err: e instanceof Error ? e.message : String(e) });
    return "failed";
  }
}

/** 拉取云端快照（大快照自动 gzip，绕开 4.5MB 响应限制）。
 *  查询参数：?versions=1 列出历史版本时间戳；?v=<ts> 拉取指定历史版本。 */
export async function GET(req: NextRequest) {
  const user = await verifyAnyAuth(req); // 会话 cookie（Web/小程序）或设备令牌（插件）
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const expectedUser = req.headers.get("x-mentora-user-id");
  if (expectedUser && expectedUser !== user.userId) return Response.json({ error: "账户已切换，请重新同步", code: "ACCOUNT_MISMATCH" }, { status: 403 });
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
    const file = await dbGet<{ data: Record<string, unknown>; updatedAt: string; uploadId?: string }>(path, {
      encrypted: true,
    });
    if (!file) return Response.json({ data: null });
    const { _sha, ...rest } = file;
    /**
     * 把**服务端算出的版本哈希**返回给客户端（复核 REVIEW-TENCENT §3）。
     * 客户端下次提交时带 `baseSha`，服务端做原子条件写——
     * 「GET 后本地比对再写」在跨设备场景没有原子性，必须由服务端把关。
     *
     * 注意：PG 通道的 dbGet 返回的 _sha 是占位符（"rds"），不是真哈希；
     * 所以这里用 `updatedAt` 作为版本标识——它每份快照都有、单调递增、且客户端拿得到。
     */
    const version = rest.updatedAt ?? _sha ?? null;
    const body = JSON.stringify({ data: rest.data ?? rest, updatedAt: rest.updatedAt, version, uploadId: rest.uploadId });
    /* 读侧体积闸：写侧虽有 64MB 解压闸，但响应侧此前只靠 Vercel 平台 4.5MB 硬失败兜底——
     * 自托管连平台闸都没有，明文通道会原样吐几十 MB。超限给明确 413，不静默截断。 */
    // plain=1：客户端（微信小程序等）无法解压 x-gzip，显式要明文 JSON。
    const plain = searchParams.has("plain");
    /* 按 UTF-8 字节计量（与写侧 :164 的 Buffer.byteLength 同口径）：body.length 是 UTF-16
     * 码元数，中文为主的快照在 UTF-8 下每字 3 字节，用码元数当字节闸会实际放行 1-3 倍体积。 */
    if (plain && Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return Response.json(
        { error: "云端快照过大，明文通道无法下发（请用支持 gzip 的端同步，或精简第二大脑内容）" },
        { status: 413 }
      );
    }
    if (!plain && body.length > 1024 * 1024) {
      /* level 6 而非 9：快照最大可存 64MB（MAX_DECOMPRESSED），level 9 同步压缩可达数十秒级，
       * 冻结事件循环——插件/多端轮询期间全服务停摆。与 db.ts encrypt 的既有工程结论一致
       * （level 9 对 9MB 明文约秒级；level 6 CPU 约降至 1/4），解压端无损兼容。 */
      const gz = zlib.gzipSync(Buffer.from(body, "utf8"), { level: 6 });
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
  } catch (e) {
    if (e instanceof Error && e.name === "SnapshotIncompleteError") {
      return Response.json({ error: "云端快照不完整，请刷新后重试", code: "SNAPSHOT_INCOMPLETE" }, { status: 503 });
    }
    if (e instanceof Error && e.name === "DbUnavailableError") {
      return Response.json({ error: "云端存储暂不可用，请稍后重试", code: "DB_UNAVAILABLE" }, { status: 503 });
    }
    return Response.json({ error: "云端读取失败" }, { status: 503 });
  }
}

/** 上传本地快照（last-write-wins，但覆盖前自动存档上一份；大快照以 application/x-gzip 上传） */
export async function POST(req: NextRequest) {
  const user = await verifyAnyAuth(req);
  if (!user) return Response.json({ error: "未登录" }, { status: 401 });
  const expectedUser = req.headers.get("x-mentora-user-id");
  if (expectedUser && expectedUser !== user.userId) return Response.json({ error: "账户已切换，请重新同步", code: "ACCOUNT_MISMATCH" }, { status: 403 });
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
      const bytes = await readBytesBodyWithLimit(req, MAX_BODY_BYTES);
      if (bytes === null) {
        return Response.json({ error: "同步包过大，请清理第二大脑后重试" }, { status: 413 });
      }
      const buf = Buffer.from(bytes);
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
      const txt = await readTextBodyWithLimit(req, MAX_BODY_BYTES);
      if (txt === null || Buffer.byteLength(txt) > MAX_BODY_BYTES) {
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
    ...(typeof parsed.uploadId === "string" && /^[a-z0-9-]{8,80}$/i.test(parsed.uploadId) ? { uploadId: parsed.uploadId } : {}),
  };
  try {
    const cur = await dbGet<{ userId: string; data?: unknown; updatedAt?: string }>(
      snapPath(user.userId),
      { encrypted: true, forSnapshotWrite: true }
    );
    // Older clients never sent folders. Keep the current folder list when it is omitted.
    const previousData = cur?.data as { folders?: unknown } | undefined;
    if (!("folders" in payload.data) && Array.isArray(previousData?.folders)) payload.data.folders = previousData.folders;
    const declaredBaseVersion = typeof parsed.baseVersion === "string" || parsed.baseVersion === null ? parsed.baseVersion : undefined;
    const previousTime = Date.parse(cur?.updatedAt ?? "") || 0;
    payload.updatedAt = new Date(Math.max(Date.now(), previousTime + 1)).toISOString();

    /* 华为云 RDS 通道：唯一写入入口 commitSnapshot。
     * 事务内完成「一次查询读 → 规范化业务数据幂等 → 基线/密文令牌 → 写主行 → 清旧块」。
     * 幂等比较排除 updatedAt/uploadId，两次 POST 的密文必然不同也不影响判定。 */
    if (dbChannel() === "huawei") {
      const token = typeof cur?._sha === "string" ? (cur._sha as VersionToken) : null;
      // 未提供 baseVersion 的旧客户端仍走密文令牌条件写（保留并发保护）；首次创建才 absent
      const expect: Expectation =
        declaredBaseVersion === null ? { mode: "absent" } : token ? { mode: "match", token } : { mode: "absent" };
      let out: Awaited<ReturnType<typeof commitSnapshot>>;
      try {
        out = await commitSnapshot({
          path: snapPath(user.userId),
          payload: payload as unknown as SnapshotPayload,
          content: encrypt(payload),
          version: payload.updatedAt,
          uploadId: typeof payload.uploadId === "string" ? payload.uploadId : undefined,
          expect,
          baseVersion: declaredBaseVersion,
        });
      } catch (e) {
        if (isConcurrentWriteError(e)) {
          const d = e.details;
          return Response.json(
            {
              error: "云端数据已被其他设备或会话修改，请刷新后再提交",
              conflict: true,
              currentVersion: d?.currentVersion ?? null,
              ...(d?.currentUploadId ? { currentUploadId: d.currentUploadId } : {}),
              ...(d?.reason === "lock-timeout" ? { code: "LOCK_TIMEOUT" } : {}),
            },
            { status: 409 }
          );
        }
        if (e instanceof Error && e.name === "SnapshotIncompleteError") {
          return Response.json({ error: "云端快照不完整，请刷新后重试", code: "SNAPSHOT_INCOMPLETE" }, { status: 503 });
        }
        if (e instanceof Error && e.name === "DbUnavailableError") {
          return Response.json({ error: "云端存储暂不可用，请稍后重试", code: "DB_UNAVAILABLE" }, { status: 503 });
        }
        throw e;
      }
      // 只有真正推进版本的写入才归档；幂等返回不归档（REQ-04-08）
      let archive: "archived" | "exists" | "failed" | undefined;
      if (out.kind !== "idempotent" && out.previous) {
        archive = await archivePrevious(user.userId, {
          data: (out.previous.payload as { data?: unknown }).data,
          updatedAt: out.previous.version,
        });
      }
      return Response.json({
        ok: true,
        updatedAt: out.version,
        version: out.version,
        ...(archive ? { archive } : {}),
      });
    }

    // 非 RDS 通道沿用既有语义（D1 的 gate 事务在 dbPut 内）
    if (cur?.updatedAt && isDeepStrictEqual(cur.data, payload.data)) {
      return Response.json({ ok: true, updatedAt: cur.updatedAt });
    }
    if (declaredBaseVersion !== undefined) {
      const currentVersion = cur?.updatedAt ?? null;
      if (currentVersion !== declaredBaseVersion) {
        return Response.json(
          {
            error: "云端数据已被其他设备或会话修改，请刷新后再提交",
            conflict: true,
            currentVersion,
          },
          { status: 409 }
        );
      }
    }
    const previous = cur ? { data: cur.data, updatedAt: cur.updatedAt, userId: cur.userId } : null;
    try {
      await dbPut(snapPath(user.userId), payload, {
        encrypted: true,
        sha: cur?._sha ?? null,
        overwriteOnConflict: true,
        compareSnapshot: true,
      });
    } catch (e) {
      /* 条件写失败 = 并发冲突：把当前云端版本一起返回，客户端可直接展示/合并 */
      if (e instanceof Error && e.name === "ConcurrentWriteError") {
        return Response.json(
          {
            error: "云端数据已被其他设备或会话修改，请刷新后再提交",
            conflict: true,
          },
          { status: 409 }
        );
      }
      throw e;
    }
    // The writer that advances the version archives the snapshot it replaced.
    await archivePrevious(user.userId, previous);
    return Response.json({ ok: true, updatedAt: payload.updatedAt });
  } catch (e) {
    if (e instanceof Error && e.name === "SnapshotIncompleteError") {
      return Response.json({ error: "云端快照不完整，请刷新后重试", code: "SNAPSHOT_INCOMPLETE" }, { status: 503 });
    }
    if (e instanceof Error && e.name === "DbUnavailableError") {
      return Response.json({ error: "云端存储暂不可用，请稍后重试", code: "DB_UNAVAILABLE" }, { status: 503 });
    }
    return Response.json({ error: "云端写入失败" }, { status: 503 });
  }
}
