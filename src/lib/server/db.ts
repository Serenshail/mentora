import "server-only";
import crypto from "node:crypto";
import zlib from "node:zlib";
import type Redis from "ioredis";
import { logEvent } from "./config";
import { remoteResponse, RemoteResponseBodyError } from "./remote-response";
import { DbUnavailableError, type ConcurrentWriteDetails } from "./snapshot-types";
import { joinChunks, parseChunkHeader, versionToken } from "./version-token";

/* ============================================================
 * 存储层（已收口：上层只见 dbGet/dbPut/dbList/dbDelete）
 *
 * 双通道设计（大厂 serverless 标配）：
 *   主通道  Upstash Redis REST —— <10ms、原子写、无限流焦虑
 *   通道 2  Cloudflare D1（HTTP API）—— 无 Upstash 时使用（当前生产主通道）
 *   回退   GitHub Contents API —— 两者都未配置时的兜底
 *
 * 三者共用同一套 key（users/xxx.json、data/yyy.json）与
 * AES-256-GCM 加密，可随时平滑迁移、互为备份。
 * ============================================================ */

/* ---------------- 通用：加密（两通道共用，gzip 压缩向后兼容） ---------------- */

/* scryptSync 是 CPU 密集的（每次约几十毫秒）：encrypt/decrypt 是登录、限流、
 * 同步、后台的热路径，每次调用都重算一遍纯属浪费。密钥在进程内是常量，memo 一次。 */
let encKeyCache: Buffer | null = null;
function encKey(): Buffer {
  if (encKeyCache) return encKeyCache;
  const secret = process.env.AUTH_SECRET || "";
  if (!secret) throw new Error("AUTH_SECRET 未配置");
  encKeyCache = crypto.scryptSync(secret, "mentora-db-v1", 32);
  return encKeyCache;
}

const GZ_PREFIX = "GZ1.";

export function encrypt(obj: unknown): string {
  // 大库（如几百条笔记的 vault）明文 JSON 可达 9MB+，先 gzip 再加密。
  // level 9 对 9MB 明文同步压缩约秒级、冻结事件循环；level 6 CPU 约降至 1/4，解压端无损兼容
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 6 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  return GZ_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decrypt<T>(payload: string): T {
  const gzipped = payload.startsWith(GZ_PREFIX);
  const body = gzipped ? payload.slice(GZ_PREFIX.length) : payload;
  const raw = Buffer.from(body, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  const json = gzipped ? zlib.gunzipSync(plain) : plain;
  return JSON.parse(json.toString("utf8")) as T;
}

/* ---------------- 通用：重试（指数退避）+ 网络健康熔断 ---------------- */

/* 403 不重试：确定性失败（凭据错/被拒），重试只是烧满退避；交给各通道 !res.ok 分支计入熔断 */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS = [300, 600, 1200]; // ms
const REMOTE_FETCH_TIMEOUT_MS = 5_000; // 单次 fetch 硬超时：连不上的服务不该拖死请求

/* 熔断器：远端 KV（D1/Upstash）连续网络失败后 60s 内判定"不健康"。
 * best-effort 调用方（限流桶/验证码/配额/登录失败计数）应走 hasHealthyRemoteDb()：
 * 不健康时直接降级为进程内存——否则本地开发（连不上 Cloudflare）与线上 D1 抖动时，
 * 每个请求都要陪着重试烧 20 秒。数据主路径（用户档案/同步）不受此闸约束：
 * 那是必须真读写的，失败如实报错。 */
let lastNetFailAt = 0;
let netFailStreak = 0;
function recordNetResult(ok: boolean): void {
  if (ok) {
    netFailStreak = 0;
    lastNetFailAt = 0;
  } else {
    netFailStreak += 1;
    if (netFailStreak >= 2) lastNetFailAt = Date.now();
  }
}

export function hasHealthyRemoteDb(): boolean {
  if (!hasRemoteDb()) return false;
  return !(lastNetFailAt && Date.now() - lastNetFailAt < 60_000);
}

/** 给 best-effort 的远端调用设硬预算：超时/失败立刻取降级值，不拖死请求。
 *  远端 KV 偶发变慢时（实测单次 D1 可撞满 5s×3 重试），限流/配额/吊销校验这类
 *  "失效也不该阻断功能"的检查绝不能让首字节等上十几秒——公网网关 15s 就会掐断长请求。 */
export async function withBudget<T>(p: Promise<T>, fallback: T, ms = 1200): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
  return await Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withRetry(fn: () => Promise<Response>): Promise<Response> {
  let lastErr: unknown = null;
  let statusFail = false; // 重试型状态码（429/5xx）烧满：与断网同等计入熔断
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fn();
      if (!RETRY_STATUS.has(res.status)) {
        recordNetResult(true);
        return res;
      }
      statusFail = true;
      lastErr = new Error(`status ${res.status}`);
      /* 消费 body 释放连接 */
      await res.text().catch(() => {});
    } catch (e) {
      recordNetResult(false); // 连接失败/超时：网络层问题，计入熔断
      if (e instanceof RemoteResponseBodyError) throw e;
      lastErr = e;
    }
    if (attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  if (statusFail) recordNetResult(false); // 持续 429/5xx 也要能开熔断，不能每个请求都陪跑满 4 尝试
  throw lastErr instanceof Error ? lastErr : new Error("网络错误");
}

/* ---------------- 主通道：Upstash Redis REST ---------------- */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const hasUpstash = () => Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function upstash<T = unknown>(
  command: (string | number)[]
): Promise<{ result: T }> {
  const res = await withRetry(() => {
    return remoteResponse(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(command),
      cache: "no-store",
    }, REMOTE_FETCH_TIMEOUT_MS);
  });
  if (!res.ok) {
    recordNetResult(false); // 服务逻辑失败同样计入熔断（如凭据错误时次次 4xx，不该每个请求都撞一遍）
    throw new Error(`Upstash 请求失败（${res.status}）`);
  }
  return (await res.json()) as { result: T };
}

async function upstashGet(path: string): Promise<string | null> {
  const { result } = await upstash<string>(["GET", path]);
  return result;
}

async function upstashSet(path: string, value: string): Promise<void> {
  await upstash(["SET", path, value]);
}

/** SET NX：只有 key 不存在才写。返回 true 表示本次写入成功（抢到了）。 */
async function upstashSetIfAbsent(path: string, value: string): Promise<boolean> {
  const { result } = await upstash<string | null>(["SET", path, value, "NX"]);
  return result === "OK";
}

async function upstashList(dir: string): Promise<string[]> {
  /* 用 SCAN 而不是 KEYS：KEYS 会阻塞整个 Redis 实例（注释本来就写着 SCAN，实现却是 KEYS）。
   * 游标循环按 COUNT 分批，最多 60 轮兜底防异常响应导致死循环。 */
  const out: string[] = [];
  let cursor = "0";
  for (let guard = 0; guard < 60; guard++) {
    const { result } = await upstash<[string, string[]]>([
      "SCAN", cursor, "MATCH", `${dir}/*.json`, "COUNT", 200,
    ]);
    const next = String(result?.[0] ?? "0");
    for (const k of result?.[1] ?? []) out.push(k.slice(dir.length + 1));
    cursor = next;
    if (cursor === "0") break;
  }
  if (cursor !== "0") throw new Error("目录扫描未完成，请稍后重试");
  return [...new Set(out)];
}

async function upstashDelete(path: string): Promise<void> {
  await upstash(["DEL", path]);
}

/* ---------------- 通道 2：Cloudflare D1（HTTP API，免费额度：5M 读/天、100k 写/天） ---------------- */

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_DB_ID = process.env.CLOUDFLARE_D1_DATABASE_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_D1_API_TOKEN || "";
const hasD1 = () => Boolean(CF_ACCOUNT && CF_DB_ID && CF_TOKEN);

/** 冷启动懒建表：成功才缓存，失败即清空让下次调用重试（与 ensureAuxTable 同纪律）。
 *  否则冷启动首触的一次网络抖动会把 rejected Promise 永久钉在本 isolate，
 *  此后每次读写都撞同一个错误，直到进程回收。 */
let d1Ready: Promise<void> | null = null;
function d1Init(): Promise<void> {
  if (d1Ready) return d1Ready;
  const p: Promise<void> = (async () => {
    await d1Raw("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)", []);
  })();
  d1Ready = p;
  p.catch(() => { if (d1Ready === p) d1Ready = null; });
  return p;
}

type D1Query = { sql: string; params: (string | number | null)[] };
async function d1Query<T>(query: D1Query | { batch: D1Query[] }): Promise<T[][]> {
  const res = await withRetry(() => {
    return remoteResponse(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${CF_DB_ID}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(query),
      cache: "no-store",
    }, REMOTE_FETCH_TIMEOUT_MS);
  });
  const j = (await res.json().catch(() => null)) as
    | { success?: boolean; errors?: { code?: number; message?: string }[]; result?: { results?: T[] }[] }
    | null;
  if (!res.ok || !j?.success) {
    recordNetResult(false); // 连上的 400（凭据/库 ID 错/语句拒绝）与断网同等对待：累计 2 次开熔断
    const why = j?.errors?.[0]?.message ?? `status ${res.status}`;
    // 带语句头部（我们自己的固定 SQL 文本）；绝不带参数——参数含邮箱等键路径，不该进日志
    const sql = "sql" in query ? query.sql : query.batch[0].sql;
    throw new Error(`D1 请求失败（${res.status}）：${why.slice(0, 180)} [${sql.slice(0, 70)}]`);
  }
  return j.result?.map((item) => item.results ?? []) ?? [];
}

async function d1Raw<T = { k?: string; v?: string }>(sql: string, params: D1Query["params"]): Promise<T[]> {
  return (await d1Query<T>({ sql, params }))[0] ?? [];
}

/* D1 单条 SQL 有 1MB 上限，大值按块拆存：主行存 {"__chunks__":N}，块存 <path>#p0..#p(N-1) */
const D1_CHUNK_SIZE = 380_000;

/* D1 的 SQLite LIKE 模式匹配器实测间歇性抛 "LIKE or GLOB pattern too complex"
 * （同一模式一次 400 一次 200，v17 冒烟复现）——前缀需求一律改 substr 相等比较绕开：
 * kv 表量级小，全扫无感；行为等价且稳定。 */
const PREFIX_SELECT = "SELECT k FROM kv WHERE substr(k, 1, ?) = ?";
const PREFIX_LIKE = "SELECT k, v FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k";
const PREFIX_DELETE = "DELETE FROM kv WHERE k = ? OR substr(k, 1, ?) = ?";
const PREFIX_DELETE_ONLY = "DELETE FROM kv WHERE substr(k, 1, ?) = ?";
const prefixOf = (dir: string): [number, string] => [dir.length, dir];

async function d1ReadSnapshot(path: string) {
  await d1Init();
  const [current] = await d1Raw("SELECT v FROM kv WHERE k = ?", [path]);
  if (current?.v == null) return null;
  if (!/^\{"__chunks__":\d+\}$/.test(current.v)) {
    return { raw: current.v, token: JSON.stringify([current.v, null]) };
  }
  // Read the header and its chunks in the same SQLite statement.
  const rows = await d1Raw("SELECT k, v FROM kv WHERE k = ? OR substr(k, 1, ?) = ?", [path, ...prefixOf(`${path}#p`)]);
  const values = new Map(rows.map(({ k, v }) => [k, v]));
  const header = values.get(path);
  if (header == null) return null;
  const count = Number(/^\{"__chunks__":(\d+)\}$/.exec(header)?.[1] ?? 0);
  const parts = Array.from({ length: count }, (_, i) => values.get(`${path}#p${i}`));
  if (parts.includes(undefined)) throw new Error("云端快照不完整");
  return { raw: count ? parts.join("") : header, token: JSON.stringify([header, parts[0] ?? null]) };
}

async function d1WriteSnapshot(path: string, content: string, token: string | null) {
  await d1Init();
  const [header, first] = token ? JSON.parse(token) as [string, string | null] : [null, null];
  if (content.length <= D1_CHUNK_SIZE && first === null) {
    const rows = header === null
      ? await d1Raw("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING RETURNING k", [path, content])
      : await d1Raw("UPDATE kv SET v = ? WHERE k = ? AND v = ? RETURNING k", [content, path, header]);
    if (!rows.length) throw new ConcurrentWriteError(path);
    return;
  }

  // The transient marker gates every statement in the same D1 transaction.
  // Keep the existing chunk layout so an earlier release can still read new snapshots.
  const gate = `${path}#p-gate-${crypto.randomUUID()}`;
  const parts: string[] = [];
  if (content.length > D1_CHUNK_SIZE) {
    for (let i = 0; i < content.length; i += D1_CHUNK_SIZE) parts.push(content.slice(i, i + D1_CHUNK_SIZE));
  }
  const queries: D1Query[] = [{
    sql: "INSERT INTO kv(k, v) SELECT ?, '' WHERE (SELECT v FROM kv WHERE k = ?) IS ? AND (SELECT v FROM kv WHERE k = ?) IS ? RETURNING k",
    params: [gate, path, header, `${path}#p0`, first],
  }, {
    sql: "DELETE FROM kv WHERE substr(k, 1, ?) = ? AND k <> ? AND EXISTS (SELECT 1 FROM kv WHERE k = ?)",
    params: [...prefixOf(`${path}#p`), gate, gate],
  }, ...parts.map((part, i) => ({
    sql: "INSERT INTO kv(k, v) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM kv WHERE k = ?)",
    params: [`${path}#p${i}`, part, gate],
  })), {
    sql: "INSERT INTO kv(k, v) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM kv WHERE k = ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    params: [path, parts.length ? JSON.stringify({ __chunks__: parts.length }) : content, gate],
  }, { sql: "DELETE FROM kv WHERE k = ?", params: [gate] }];
  const results = await d1Query<{ k: string }>({ batch: queries });
  if (!results[0]?.length) throw new ConcurrentWriteError(path);
}

async function d1Get(path: string): Promise<string | null> {
  await d1Init();
  const rows = await d1Raw<{ v?: string }>("SELECT v FROM kv WHERE k = ?", [path]);
  const v = rows[0]?.v;
  if (v == null) return null;
  const m = /^\{"__chunks__":(\d+)\}$/.exec(v);
  if (!m) return v;
  const n = Number(m[1]);
  const parts = await d1Raw<{ k?: string; v?: string }>(
    PREFIX_LIKE,
    prefixOf(`${path}#p`)
  );
  const byIdx = new Map<number, string>();
  for (const p of parts) {
    const idx = Number((p.k ?? "").split("#p")[1]);
    if (p.v != null && !Number.isNaN(idx)) byIdx.set(idx, p.v);
  }
  let out = "";
  for (let i = 0; i < n; i++) out += byIdx.get(i) ?? "";
  return out;
}

async function d1Put(path: string, content: string): Promise<void> {
  await d1Init();
  if (content.length <= D1_CHUNK_SIZE) {
    // 若此前是分块存储，先清理旧块
    await d1Raw(PREFIX_DELETE_ONLY, prefixOf(`${path}#p`));
    await d1Raw(
      "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      [path, content]
    );
    return;
  }
  const parts: string[] = [];
  for (let i = 0; i < content.length; i += D1_CHUNK_SIZE) {
    parts.push(content.slice(i, i + D1_CHUNK_SIZE));
  }
  // 先写块行、再写主行（读者以主行的 __chunks__ 数为准，主行最后落=读到旧值完整密文而非缺块密文）；
  // 收尾清掉内容变短后多余的旧块行，防止永久泄漏
  for (let i = 0; i < parts.length; i++) {
    await d1Raw(
      "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      [`${path}#p${i}`, parts[i]]
    );
  }
  await d1Raw(
    "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    [path, `{"__chunks__":${parts.length}}`]
  );
  const stale = await d1Raw<{ k?: string }>(PREFIX_LIKE, prefixOf(`${path}#p`));
  for (const row of stale) {
    const idx = Number((row.k ?? "").split("#p")[1]);
    if (row.k && !Number.isNaN(idx) && idx >= parts.length) {
      await d1Raw("DELETE FROM kv WHERE k = ?", [row.k]);
    }
  }
}

async function d1List(dir: string): Promise<string[]> {
  await d1Init();
  const rows = await d1Raw<{ k?: string }>(PREFIX_SELECT, prefixOf(`${dir}/`));
  return (rows.map((r) => r.k ?? "").filter(Boolean) as string[])
    .filter((k) => !k.includes("#")) // 分块行不属于任何文件名
    .map((k) => k.slice(dir.length + 1));
}

async function d1Delete(path: string): Promise<void> {
  await d1Init();
  const [len, pre] = prefixOf(`${path}#p`);
  await d1Raw(PREFIX_DELETE, [path, len, pre]);
}

/** 仅当 key 不存在才写。RETURNING 只在新插入时返回行，故能区分"已存在"。 */
async function d1PutIfAbsent(path: string, content: string): Promise<boolean> {
  await d1Init();
  const rows = await d1Raw<{ k?: string }>(
    "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING RETURNING k",
    [path, content]
  );
  return rows.length > 0;
}

/** 乐观并发控制失败：写入被拒，调用方必须提示冲突并让用户重新预览/合并。 */
export class ConcurrentWriteError extends Error {
  constructor(
    public readonly path: string,
    public readonly details?: ConcurrentWriteDetails
  ) {
    super(`并发写冲突：${path} 已被其他会话/设备修改`);
    this.name = "ConcurrentWriteError";
  }
}

/* ---------------- 通道 3：华为云 RDS PostgreSQL（huawei 主数据真源，HW-T-01/02） ----------------
 * 免分块：PG TEXT 无 1MB 限制，大库单行直存；加密语义与 D1/Upstash 完全一致（密文透传）。
 * 懒加载：未配置 DATABASE_URL 时不加载 pg 驱动，旧通道零感知。 */

const DATABASE_URL = process.env.DATABASE_URL || "";
const hasRds = () => Boolean(DATABASE_URL);

type PgQueryResult = { rows: Record<string, unknown>[] };
type PgClient = {
  query: (sql: string, params?: (string | number | null)[]) => Promise<PgQueryResult>;
  release: (destroy?: boolean) => void;
};
type PgPool = {
  query: (sql: string, params?: (string | number | null)[]) => Promise<PgQueryResult>;
  connect: () => Promise<PgClient>;
};
let rdsPoolInst: PgPool | null = null;
async function rdsPool(): Promise<PgPool> {
  if (!rdsPoolInst) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    /* pg 的空闲连接出错时会在 Pool 上 emit 'error'：不监听就是 uncaughtException
     * （Next 只打日志不退出，但噪音会污染日志且掩盖真实故障）。ioredis 侧早有对口处理。 */
    pool.on("error", (err: unknown) => {
      logEvent({ route: "db", ev: "pg-pool-error", msg: err instanceof Error ? err.message : String(err) });
    });    rdsPoolInst = pool as unknown as PgPool;
  }
  return rdsPoolInst;
}

/** 冷启动懒建表：成功才缓存，失败即清空让下次调用重试（同 d1Init/ensureAuxTable） */
let rdsReady: Promise<void> | null = null;
function rdsInit(): Promise<void> {
  if (rdsReady) return rdsReady;
  const p: Promise<void> = (async () => {
    const pool = await rdsPool();
    await pool.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  })();
  rdsReady = p;
  p.catch(() => { if (rdsReady === p) rdsReady = null; });
  return p;
}

async function rdsQuery<T = { k?: string; v?: string }>(sql: string, params: (string | number | null)[] = []): Promise<T[]> {
  try {
    const pool = await rdsPool();
    const res = await pool.query(sql, params);
    recordNetResult(true);
    return res.rows as T[];
  } catch (e) {
    recordNetResult(false); // 连接/凭据/语句错误与 D1 同纪律：计入熔断
    // 带语句头部（我们自己的固定 SQL 文本）；绝不带参数——参数含邮箱等键路径，不该进日志
    throw new Error(`RDS 请求失败：${(e instanceof Error ? e.message : String(e)).slice(0, 180)} [${sql.slice(0, 70)}]`);
  }
}

/* ============ RDS 事务外壳（T-ICT-006 / 007a） ============
 * 快照写入必须在**同一专用连接**上完成：pool.query 每次另取连接，
 * 「BEGIN」与后续语句可能落在不同连接上，事务形同虚设。
 * 事务内禁止调用 rdsQuery（它会再次向池取连接），测试用 pg_stat_activity 断言。 */

export type RdsTxClient = PgClient;

function txTimeout(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function sqlStateOf(e: unknown): string {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

async function txOnce<T>(path: string, fn: (c: RdsTxClient) => Promise<T>): Promise<T> {
  await rdsInit();
  const pool = await rdsPool();
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    // SET LOCAL 必须在事务内；时间参数来自环境变量并强制为整数，不接受拼接任意文本
    await client.query(`SET LOCAL lock_timeout = ${txTimeout("RDS_LOCK_TIMEOUT_MS", 2000)}`);
    await client.query(`SET LOCAL statement_timeout = ${txTimeout("RDS_STATEMENT_TIMEOUT_MS", 8000)}`);
    // 路径级互斥：事务结束自动释放；不同 path 互不阻塞
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [path]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroy = true;
    }
    throw e;
  } finally {
    client.release(destroy);
  }
}

/** 在专用连接上执行一次事务；序列化失败重试 1 次，其余错误映射为业务错误。 */
export async function rdsTx<T>(path: string, fn: (c: RdsTxClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await txOnce(path, fn);
    } catch (e) {
      if (e instanceof ConcurrentWriteError || e instanceof DbUnavailableError) throw e;
      if (e instanceof Error && e.name === "SnapshotIncompleteError") throw e;
      const code = sqlStateOf(e);
      if (attempt === 0 && (code === "40001" || code === "40P01")) continue;
      if (code === "55P03") {
        throw new ConcurrentWriteError(path, { reason: "lock-timeout", currentVersion: null });
      }
      if (!code || code.startsWith("08") || ["57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)) {
        throw new DbUnavailableError(`RDS 事务不可用：${code || "connection"}`);
      }
      throw e;
    }
  }
}

async function rdsGet(path: string): Promise<string | null> {
  await rdsInit();
  const rows = await rdsQuery<{ v?: string }>("SELECT v FROM kv WHERE k = $1", [path]);
  const v = rows[0]?.v;
  return v == null ? null : v;
}

/** RDS 快照读取：识别历史分块形态（`{"__chunks__":N}` + `#p0..`），返回逻辑密文。
 *  一条查询取齐主行与块行；缺块抛 SnapshotIncompleteError（接口 503），不返回部分内容。 */
async function rdsGetLogical(path: string): Promise<string | null> {
  await rdsInit();
  const safe = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await rdsQuery<{ k?: string; v?: string }>(
    "SELECT k, v FROM kv WHERE k = $1 OR (k LIKE $2 AND k ~ $3)",
    [path, `${path}#p%`, `^${safe}#p[0-9]+$`]
  );
  let header: string | null = null;
  const parts = new Map<number, string>();
  const prefix = `${path}#p`;
  for (const row of rows) {
    if (typeof row.k !== "string" || typeof row.v !== "string") continue;
    if (row.k === path) {
      header = row.v;
      continue;
    }
    if (!row.k.startsWith(prefix)) continue;
    const idx = row.k.slice(prefix.length);
    if (/^[0-9]+$/.test(idx)) parts.set(Number(idx), row.v);
  }
  if (header === null) return null;
  const declared = parseChunkHeader(header);
  if (declared === null) return header;
  return joinChunks(path, declared, [...Array(declared).keys()].map((i) => parts.get(i)));
}

/** 读一行的**逻辑内容令牌**（md5 of 逻辑密文），供乐观并发控制使用。
 *  分块形态先拼接再计算，保证与 commitSnapshot 的令牌口径一致。 */
export async function rdsGetSha(path: string): Promise<string | null> {
  const raw = await rdsGetLogical(path);
  return raw === null ? null : versionToken(raw);
}

/**
 * 写入一行 KV。
 *
 * `expectSha`（可选）：乐观并发控制。给出时要求库里的**当前值哈希**与它一致才写入，
 * 否则抛 `ConcurrentWriteError`。
 *
 * 为什么必须做在服务端（复核 REVIEW-TENCENT §3）：/api/sync 是整份快照覆盖，
 * 客户端「GET 后比对再写」在跨设备场景没有原子性——两个设备都读到同一版本、
 * 都认为自己是基于最新版，后写的那个静默覆盖前者。原实现完全忽略 sha 参数，
 * 等于 PG 通道上**没有任何并发控制**。
 *
 * 实现：用 `WHERE kv.v = $expected` 做条件 UPDATE（PG 单语句原子），
 * 影响 0 行即说明被别人改过。
 */
async function rdsPut(path: string, content: string, expectSha?: string | null): Promise<void> {
  await rdsInit();
  // RDS 无 1MB 语句限制（PG TEXT 上限 1GB），单行直存；若从 D1 迁入的块行遗留，写入主行后清理
  if (expectSha === undefined) {
    /* 无条件写（内部路径：迁移/初始化/归档，调用方明确知道自己在覆盖） */
    await rdsQuery(
      "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      [path, content]
    );
    await rdsQuery("DELETE FROM kv WHERE substr(k, 1, $1) = $2", [`${path}#p`.length, `${path}#p`]);
    return;
  }
  if (expectSha === null) {
    /* 期望「不存在」：只有空表时才插入（ON CONFLICT DO NOTHING + 检查影响行数） */
    const rows = await rdsQuery<{ k?: string }>(
      "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT(k) DO NOTHING RETURNING k",
      [path, content]
    );
    if (rows.length === 0) throw new ConcurrentWriteError(path);
    await rdsQuery("DELETE FROM kv WHERE substr(k, 1, $1) = $2", [`${path}#p`.length, `${path}#p`]);
    return;
  }
  /* 期望「当前值是 expectSha」：条件更新，影响 0 行 = 被并发改过 */
  const updated = await rdsQuery<{ k?: string }>(
    "UPDATE kv SET v = $2 WHERE k = $1 AND md5(v) = $3 RETURNING k",
    [path, content, expectSha]
  );
  if (updated.length === 0) throw new ConcurrentWriteError(path);
  await rdsQuery("DELETE FROM kv WHERE substr(k, 1, $1) = $2", [`${path}#p`.length, `${path}#p`]);
}

async function rdsList(dir: string): Promise<string[]> {
  await rdsInit();
  const rows = await rdsQuery<{ k?: string }>("SELECT k FROM kv WHERE substr(k, 1, $1) = $2 ORDER BY k", [dir.length + 1, `${dir}/`]);
  return (rows.map((r) => r.k ?? "").filter(Boolean) as string[])
    .filter((k) => !k.includes("#")) // 迁移期防御：分块行不属于任何文件名
    .map((k) => k.slice(dir.length + 1));
}

async function rdsDelete(path: string): Promise<void> {
  await rdsInit();
  await rdsQuery("DELETE FROM kv WHERE k = $1 OR substr(k, 1, $2) = $3", [path, `${path}#p`.length, `${path}#p`]);
}

/** 仅当 key 不存在才写。RETURNING 只在新插入时返回行。 */
async function rdsPutIfAbsent(path: string, content: string): Promise<boolean> {
  await rdsInit();
  const rows = await rdsQuery<{ k?: string }>(
    "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT(k) DO NOTHING RETURNING k",
    [path, content]
  );
  return rows.length > 0;
}

/* ---------------- 通道 4：华为云 DCS Redis（huawei 跨进程状态，HW-T-05/S-02） ----------------
 * 协议与 Upstash 通道语义一致（GET/SET/SCAN/DEL + AES-256-GCM 加密值）。
 * 键原生 TTL 仅为存储清理（code 11min / quota 36h / rl 1h / loginfail 30min）；
 * 行为权威判断仍是值内 expiresAt/窗口字段（应用层双保险保持不变）。 */

const REDIS_URL = process.env.REDIS_URL || "";
const hasDcs = () => Boolean(REDIS_URL);

let dcsInst: Redis | null = null;
async function dcs(): Promise<Redis> {
  if (!dcsInst) {
    const { default: RedisCtor } = await import("ioredis");
    dcsInst = new RedisCtor(REDIS_URL, {
      maxRetriesPerRequest: 2,
      connectTimeout: 5_000,
      retryStrategy: (times: number) => Math.min(times * 200, 2_000),
    });
    // ioredis error 事件必须监听，否则连接抖动会以 unhandled 'error' 事件击穿进程
    dcsInst.on("error", () => { /* 网络层错误由 dcsCmd 统一计熔断 */ });
  }
  return dcsInst;
}

async function dcsCmd<T>(fn: (r: Redis) => Promise<T>, what: string): Promise<T> {
  try {
    const r = await dcs();
    const out = await fn(r);
    recordNetResult(true);
    return out;
  } catch (e) {
    recordNetResult(false); // 连接/超时/凭据错误与 Upstash 同纪律：累计 2 次开熔断
    throw new Error(`DCS ${what}失败：${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`);
  }
}

const DCS_TTL_SECONDS: [string, number][] = [
  ["code/", 660], // 验证码 11min
  ["quota/", 36 * 3600], // 服务端 Key 配额 36h
  ["rl/", 3600], // 限流桶 1h
  ["loginfail/", 1800], // 登录失败锁定 30min（> 15min 锁定窗口）
];
function dcsTtl(path: string): number | null {
  for (const [pre, sec] of DCS_TTL_SECONDS) {
    if (path.startsWith(pre)) return sec;
  }
  return null;
}

async function dcsGet(path: string): Promise<string | null> {
  return dcsCmd((r) => r.get(path), "读取");
}

async function dcsPut(path: string, content: string): Promise<void> {
  const ttl = dcsTtl(path);
  await dcsCmd((r) => (ttl ? r.set(path, content, "EX", ttl) : r.set(path, content)), "写入");
}

/** SET NX：只有 key 不存在才写。ioredis 在 NX 未命中时返回 null。 */
async function dcsPutIfAbsent(path: string, content: string): Promise<boolean> {
  const ttl = dcsTtl(path);
  const out = await dcsCmd<string | null>(
    (r) => (ttl ? r.set(path, content, "EX", ttl, "NX") : r.set(path, content, "NX")),
    "写入"
  );
  return out === "OK";
}

async function dcsList(dir: string): Promise<string[]> {
  // SCAN 迭代（不用 KEYS：DCS 生产实例禁用/高成本）；语义对齐 Upstash 通道的 dir/*.json
  return dcsCmd(async (r) => {
    let out: string[] = [];
    let cursor = "0";
    /* 最多 60 轮兜底（与 upstashList 同口径）：代理层/实例故障时游标可能永不为 "0"，
     * 无界 do/while 会让本调用每轮一次网络往返无限循环，直到函数级超时——cron/tick
     * 与 rl/ 限流路径都会被拖满 maxDuration。 */
    for (let guard = 0; guard < 60; guard++) {
      const [c, keys] = await r.scan(cursor, "MATCH", `${dir}/*.json`, "COUNT", 200);
      cursor = c;
      out = out.concat(keys);
      if (cursor === "0") break;
    }
    if (cursor !== "0") throw new Error("目录扫描未完成，请稍后重试");
    return [...new Set(out)].map((k) => k.slice(dir.length + 1));
  }, "列目录");
}

async function dcsDelete(path: string): Promise<void> {
  await dcsCmd((r) => r.del(path), "删除");
}

/* ---------------- 回退通道：GitHub Contents API ---------------- */

const REPO = process.env.GITHUB_DB_REPO || "";
const TOKEN = process.env.GITHUB_DB_TOKEN || "";

async function ghApi(path: string, method: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await withRetry(() => {
    return remoteResponse(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "mentora",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    }, REMOTE_FETCH_TIMEOUT_MS);
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch { /* empty body */ }
  return { status: res.status, json };
}

/* ---------------- 分发层：DB_CHANNEL 显式路由（HW-T-01/05 双通道） ----------------
 * auto（缺省）：隐式优先级 Upstash → D1 → GitHub（历史行为，本地开发零破坏）
 * huawei：按键前缀分流——跨进程状态（rl/ code/ quota/ loginfail/）→ DCS；
 *         数据真源（users/ data/ versions/ 及其余）→ RDS
 * upstash / d1 / github：显式锁定旧通道（凭据缺失即 fail-fast，绝不静默换道）
 * 切换 env 即切通道，无需代码变更；旧通道不被移除或劣化。 */

type DbChannelMode = "auto" | "huawei" | "upstash" | "d1" | "github";
type RoutedChannel = "upstash" | "d1" | "github" | "rds" | "dcs";

const DCS_PREFIXES = ["rl/", "code/", "quota/", "loginfail/"];
function isDcsPath(path: string): boolean {
  return DCS_PREFIXES.some((p) => path.startsWith(p));
}

function dbChannelEnv(): DbChannelMode {
  const v = (process.env.DB_CHANNEL || "auto").trim().toLowerCase();
  return (["auto", "huawei", "upstash", "d1", "github"] as const).includes(v as DbChannelMode)
    ? (v as DbChannelMode)
    : "auto";
}

function routeOf(path: string): RoutedChannel {
  const mode = dbChannelEnv();
  if (mode === "huawei") {
    if (isDcsPath(path)) {
      if (!hasDcs()) throw new Error("DB_CHANNEL=huawei 但 REDIS_URL 未配置（跨进程状态通道）");
      return "dcs";
    }
    if (!hasRds()) throw new Error("DB_CHANNEL=huawei 但 DATABASE_URL 未配置（数据真源通道）");
    return "rds";
  }
  if (mode === "upstash") {
    if (!hasUpstash()) throw new Error("DB_CHANNEL=upstash 但 UPSTASH_REDIS_REST_* 未配置");
    return "upstash";
  }
  if (mode === "d1") {
    if (!hasD1()) throw new Error("DB_CHANNEL=d1 但 CLOUDFLARE_D1_* 未配置");
    return "d1";
  }
  if (mode === "github") {
    if (!REPO || !TOKEN) throw new Error("DB_CHANNEL=github 但 GITHUB_DB_* 未配置");
    return "github";
  }
  if (hasUpstash()) return "upstash";
  if (hasD1()) return "d1";
  /* auto 兜底 GitHub：凭据缺失必须 fail-fast，绝不静默当成"文件不存在"。
   * 空 REPO 会让 ghApi 去打 repos//contents/... 恒 404，而 dbGet/dbList 把 404
   * 当"没有这个文件/目录"返回 null/[]：verifySession 把在线用户判成"账号已注销"、
   * 登录判"账号不存在"、register 的重复邮箱检测失效——读全是静默假象，写却大声抛错，
   * 故障不对称且极难定位。与显式 github 模式同纪律。 */
  if (!REPO || !TOKEN) throw new Error("无可用数据通道：未配置 Upstash/D1，且 GITHUB_DB_REPO/GITHUB_DB_TOKEN 缺失");
  return "github";
}

/** 当前生效通道（health 展示用；仅枚举名，无敏感值） */
export function dbChannel(): string {
  const mode = dbChannelEnv();
  if (mode === "huawei") return "huawei";
  if (mode !== "auto") return mode;
  if (hasUpstash()) return "upstash";
  if (hasD1()) return "d1";
  return "github";
}

/* ---------------- 统一接口（上层只用这四个） ---------------- */

/** 读（404/null 返回 null）；加密内容自动解密 */
export async function dbGet<T>(path: string, opts: { encrypted?: boolean; forSnapshotWrite?: boolean } = {}): Promise<(T & { _sha?: string }) | null> {
  const ch = routeOf(path);

  if (ch === "upstash") {
    const raw = await upstashGet(path);
    if (raw == null) return null;
    const value = opts.encrypted ? decrypt<T>(raw) : (JSON.parse(raw) as T);
    return value as T & { _sha?: string };
  }

  if (ch === "d1") {
    if (path.startsWith("data/")) {
      const snapshot = await d1ReadSnapshot(path);
      if (!snapshot) return null;
      const value = opts.encrypted ? decrypt<T>(snapshot.raw) : (JSON.parse(snapshot.raw) as T);
      return opts.forSnapshotWrite ? { ...value, _sha: snapshot.token } : value as T & { _sha?: string };
    }
    const raw = await d1Get(path);
    if (raw == null) return null;
    const value = opts.encrypted ? decrypt<T>(raw) : (JSON.parse(raw) as T);
    return value as T & { _sha?: string };
  }

  if (ch === "rds") {
    const raw = await rdsGetLogical(path);
    if (raw == null) return null;
    const value = opts.encrypted ? decrypt<T>(raw) : (JSON.parse(raw) as T);
    return opts.forSnapshotWrite
      ? { ...value, _sha: versionToken(raw) }
      : value as T & { _sha?: string };
  }

  if (ch === "dcs") {
    const raw = await dcsGet(path);
    if (raw == null) return null;
    const value = opts.encrypted ? decrypt<T>(raw) : (JSON.parse(raw) as T);
    return value as T & { _sha?: string };
  }

  const { status, json } = await ghApi(path, "GET");
  if (status === 404) return null;
  if (status !== 200) throw new Error(`DB 读取失败（${status}）`);
  const j = json as { content?: string; sha?: string; encoding?: string };
  const raw = Buffer.from(j.content ?? "", "base64").toString("utf8");
  const value = opts.encrypted ? decrypt<T>(raw) : (JSON.parse(raw) as T);
  return { ...(value as object), _sha: j.sha } as T & { _sha?: string };
}

/** 写（Upstash/DCS 天然原子；GitHub 通道带 sha 乐观并发，冲突 last-write-wins） */
export async function dbPut<T>(
  path: string,
  value: T,
  opts: { encrypted?: boolean; sha?: string | null; overwriteOnConflict?: boolean; compareSnapshot?: boolean } = {}
): Promise<{ sha: string }> {
  const content = opts.encrypted ? encrypt(value) : JSON.stringify(value, null, 1);
  const ch = routeOf(path);

  if (ch === "upstash") {
    await upstashSet(path, content);
    return { sha: "upstash" };
  }

  if (ch === "d1") {
    if (opts.compareSnapshot) await d1WriteSnapshot(path, content, opts.sha ?? null);
    else await d1Put(path, content);
    return { sha: "d1" };
  }

  if (ch === "rds") {
    /* 只有调用方显式给了 overwriteOnConflict 才无条件写；否则按 sha 做乐观并发控制 */
    const expect = opts.compareSnapshot ? (opts.sha ?? null) : opts.overwriteOnConflict ? undefined : opts.sha;
    await rdsPut(path, content, expect);
    return { sha: "rds" };
  }

  if (ch === "dcs") {
    await dcsPut(path, content);
    return { sha: "dcs" };
  }

  let res = await ghApi(path, "PUT", {
    message: `db: ${path}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    ...(opts.sha ? { sha: opts.sha } : {}),
  });
  if (res.status === 422 && opts.overwriteOnConflict) {
    const cur = await ghApi(path, "GET");
    const sha = (cur.json as { sha?: string })?.sha;
    res = await ghApi(path, "PUT", {
      message: `db: ${path} (overwrite)`,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    });
  }
  if (res.status >= 300) throw new Error(`DB 写入失败（${res.status}）`);
  return { sha: (res.json as { content?: { sha?: string } })?.content?.sha ?? "" };
}

/** 仅当 key 不存在才写：用于卡密占用、短锁这类"只能有一个赢家"的场景。
 *  Upstash/DCS 走 SET NX；RDS/D1 走 INSERT ... ON CONFLICT DO NOTHING RETURNING；
 *  GitHub 不带 sha 的 PUT 在文件已存在时返回 422——据此判定失败。
 *  网络/服务故障时抛错，调用方应视为"没抢到"并拒绝写入，绝不降级成覆盖写。 */
export async function dbPutIfAbsent<T>(
  path: string,
  value: T,
  opts: { encrypted?: boolean } = {}
): Promise<boolean> {
  const content = opts.encrypted ? encrypt(value) : JSON.stringify(value, null, 1);
  const ch = routeOf(path);

  if (ch === "upstash") return upstashSetIfAbsent(path, content);
  if (ch === "d1") return d1PutIfAbsent(path, content);
  if (ch === "rds") return rdsPutIfAbsent(path, content);
  if (ch === "dcs") return dcsPutIfAbsent(path, content);

  const res = await ghApi(path, "PUT", {
    message: `db: ${path} (create)`,
    content: Buffer.from(content, "utf8").toString("base64"),
  });
  if (res.status === 201) return true;
  if (res.status === 422) return false;
  throw new Error(`DB 写入失败（${res.status}）`);
}

/** 列目录，返回 [{name, sha}]（sha 在 KV 类通道为占位） */
export async function dbList(dir: string): Promise<{ name: string; sha: string }[]> {
  const ch = routeOf(`${dir}/_`);

  if (ch === "upstash") {
    const names = await upstashList(dir);
    return names.map((name) => ({ name, sha: "upstash" }));
  }

  if (ch === "d1") {
    const names = await d1List(dir);
    return names
      .filter((n) => n.endsWith(".json"))
      .map((name) => ({ name, sha: "d1" }));
  }

  if (ch === "rds") {
    const names = await rdsList(dir);
    return names
      .filter((n) => n.endsWith(".json"))
      .map((name) => ({ name, sha: "rds" }));
  }

  if (ch === "dcs") {
    const names = await dcsList(dir);
    return names.map((name) => ({ name, sha: "dcs" }));
  }

  const { status, json } = await ghApi(dir, "GET");
  if (status === 404) return [];
  if (status !== 200) throw new Error(`DB 列目录失败（${status}）`);
  return (json as { name: string; sha: string }[])
    .filter((f) => f.name.endsWith(".json"))
    .map((f) => ({ name: f.name, sha: f.sha }));
}

/** 删（404/不存在视为成功） */
export async function dbDelete(path: string, sha: string | null): Promise<void> {
  const ch = routeOf(path);

  if (ch === "upstash") {
    await upstashDelete(path);
    return;
  }

  if (ch === "d1") {
    await d1Delete(path);
    return;
  }

  if (ch === "rds") {
    await rdsDelete(path);
    return;
  }

  if (ch === "dcs") {
    await dcsDelete(path);
    return;
  }

  /* GitHub Contents API 的 DELETE 必须带 message，漏了会一律 422（"message" wasn't supplied） */
  const del = (s: string | null) =>
    ghApi(path, "DELETE", { message: `db: delete ${path}`, ...(s ? { sha: s } : {}) });

  let res = await del(sha);
  if (res.status === 404) return;
  if (res.status === 422) {
    const cur = await ghApi(path, "GET");
    const fresh = (cur.json as { sha?: string })?.sha;
    res = await del(fresh ?? null);
  }
  if (res.status >= 300) throw new Error(`DB 删除失败（${res.status}）`);
}

/** 级联删一个目录下的所有键，返回删除条数。
 *  用于注销账号时清掉派生数据（versions/<userId>/ 历史快照）。
 *  单个文件删失败不阻断整体——残留的历史版本不该反过来阻止用户注销。 */
export async function dbDeleteDir(dir: string): Promise<number> {
  let n = 0;
  const files = await dbList(dir);
  for (const f of files) {
    try {
      await dbDelete(`${dir}/${f.name}`, f.sha || null);
      n++;
    } catch { /* 单个失败继续下一个 */ }
  }
  return n;
}

export function emailHash(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
}

/** 是否存在跨进程可用的远端 KV（huawei 模式看 DCS；其余模式 D1/Upstash 任一）；纯 GitHub 兜底时返回 false（写放大不值当） */
export function hasRemoteDb(): boolean {
  if (dbChannelEnv() === "huawei") return hasDcs();
  return hasUpstash() || hasD1();
}

/* events 表 DDL 收口（原先在 dbEventSave / dbEventStats / dbReadingEvents 各复制一份，
 * D1 3 份、RDS 3 份，且其中一份列序还不同）。ensureAuxTable 按 key 记忆化后，新进程里
 * 先跑到哪个函数就用哪份建表、其余份 CREATE IF NOT EXISTS 静默 no-op——任何一处列序改动
 * 都会让表结构随冷启动路径随机分叉。收成单一常量；INSERT 本就显式列名，统一列序安全。 */
const EVENTS_DDL_D1 = "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, account TEXT, path TEXT, props TEXT, created_at TEXT DEFAULT (datetime('now')))";
const EVENTS_DDL_RDS = "CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, name TEXT, account TEXT, path TEXT, props TEXT, created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')))";

/* events/feedback 惰性建表 memo（kv 表 d1Ready/rdsReady 同款纪律）：每进程只跑一次 DDL。
 * 埋点/反馈是高频路径，每次 INSERT 前都跑一遍 CREATE TABLE 是双倍往返与目录锁竞争；
 * 失败不缓存，下次调用重试。 */
const auxTableReady = new Map<string, Promise<void>>();
/* DDL 回调返回 rdsQuery 的 rows（无意义），收口为 unknown：调用方不必为了类型再包一层 */
function ensureAuxTable(key: string, ddl: () => Promise<unknown>): Promise<void> {
  const cached = auxTableReady.get(key);
  if (cached) return cached;
  const p: Promise<void> = ddl().then(() => undefined);
  p.catch(() => auxTableReady.delete(key));
  auxTableReady.set(key, p);
  return p;
}

/** 反馈双写（GitHub Issues 为主通道，KV 库存一份冗余；任何失败都不抛出）
 *  通道感知：huawei 模式写 RDS，其余模式保持 D1（HW-S-01/V-02） */
export async function dbFeedbackSave(rec: {
  number: number;
  type: string;
  content: string;
  contact: string;
  page: string;
}): Promise<void> {
  try {
    if (dbChannelEnv() === "huawei") {
      if (!hasRds()) return;
      await ensureAuxTable("rds:feedback", () =>
        rdsQuery(
          "CREATE TABLE IF NOT EXISTS feedback (number BIGINT PRIMARY KEY, type TEXT, content TEXT, contact TEXT, page TEXT, created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')))",
          []
        )
      );
      await rdsQuery(
        "INSERT INTO feedback (number, type, content, contact, page) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(number) DO NOTHING",
        [rec.number, rec.type, rec.content, rec.contact, rec.page]
      );
      return;
    }
    if (!hasD1()) return;
    await ensureAuxTable("d1:feedback", async () => {
      await d1Init();
      await d1Raw(
        "CREATE TABLE IF NOT EXISTS feedback (number INTEGER PRIMARY KEY, type TEXT, content TEXT, contact TEXT, page TEXT, created_at TEXT DEFAULT (datetime('now')))",
        []
      );
    });
    await d1Raw(
      "INSERT INTO feedback (number, type, content, contact, page) VALUES (?, ?, ?, ?, ?) ON CONFLICT(number) DO NOTHING",
      [rec.number, rec.type, rec.content, rec.contact, rec.page]
    );
  } catch { /* 双写失败不影响反馈主流程 */ }
}

/** 漏斗埋点落档（/api/track 专用）：events 表，best-effort，失败只丢事件不抛错
 *  通道感知：huawei 模式写 RDS，其余模式保持 D1（切换主通道后埋点不静默丢档） */
export async function dbEventSave(rec: {
  name: string;
  account: string;
  path: string;
  props: string;
}): Promise<void> {
  try {
    if (dbChannelEnv() === "huawei") {
      if (!hasRds()) return;
      await ensureAuxTable("rds:events", () =>
        rdsQuery(
          EVENTS_DDL_RDS,
          []
        )
      );
      await rdsQuery(
        "INSERT INTO events (name, account, path, props) VALUES ($1, $2, $3, $4)",
        [rec.name, rec.account, rec.path, rec.props]
      );
      return;
    }
    if (!hasD1()) return;
    await ensureAuxTable("d1:events", async () => {
      await d1Init();
      await d1Raw(
        EVENTS_DDL_D1,
        []
      );
    });
    await d1Raw(
      "INSERT INTO events (name, account, path, props) VALUES (?, ?, ?, ?)",
      [rec.name, rec.account, rec.path, rec.props]
    );
  } catch { /* 埋点绝不影响主流程 */ }
}
/** chat-usage props 聚合（纯函数，可测）：解析最近窗口内 props JSON，按 provider 汇总 */
export function aggregateChatUsage(propsList: string[]): {
  window: number;
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  byProvider: Record<string, { calls: number; promptTokens: number; completionTokens: number; byok: number }>;
} {
  const byProvider: Record<string, { calls: number; promptTokens: number; completionTokens: number; byok: number }> = {};
  let promptTokens = 0;
  let completionTokens = 0;
  let parsed = 0;
  for (const raw of propsList) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(raw); } catch { continue; }
    parsed += 1;
    const prov = typeof p.provider === "string" && p.provider ? p.provider : "unknown";
    const pt = Number(p.prompt_tokens) || 0;
    const ct = Number(p.completion_tokens) || 0;
    const slot = (byProvider[prov] ??= { calls: 0, promptTokens: 0, completionTokens: 0, byok: 0 });
    slot.calls += 1;
    slot.promptTokens += pt;
    slot.completionTokens += ct;
    if (p.byok === 1 || p.byok === true) slot.byok += 1;
    promptTokens += pt;
    completionTokens += ct;
  }
  return { window: propsList.length, totalCalls: parsed, promptTokens, completionTokens, byProvider };
}

/** 漏斗与用量聚合（/api/admin/stats 专用）：只出计数与 token 汇总，绝不含 account/PII
 *  通道感知：huawei 读 RDS，其余读 D1；远端库不可用时返回 null（端点如实报 503，不伪造数据） */
export async function dbEventStats(): Promise<{
  funnel: Record<string, number>;
  chatUsage: ReturnType<typeof aggregateChatUsage>;
} | null> {
  /* v26.1：学习教练 + 阅读系统全量漏斗事件（reading-metrics 与 dashboard 共用） */
  const FUNNEL = [
    "intake_start", "intake_complete", "plan_generated", "day_pass", "review_done",
    "reading_started", "goal_confirmed", "roadmap_generated", "learning_node_started",
    "node_assessment_completed", "transfer_started", "transfer_submitted", "transfer_evaluated",
    "misconception_created", "misconception_clarified", "book_assessment_completed",
    "graduation_generated", "deposit_created", "second_problem_started", "reading_exit_survey",
  ];
  try {
    let funnelRows: { name: string; n: number | string }[] = [];
    let propsList: string[] = [];
    if (dbChannelEnv() === "huawei") {
      if (!hasRds()) return null;
      await ensureAuxTable("rds:events", () =>
        rdsQuery(
          EVENTS_DDL_RDS,
          []
        )
      );
      funnelRows = await rdsQuery<{ name: string; n: number }>(
        `SELECT name, COUNT(*)::int AS n FROM events WHERE name IN (${FUNNEL.map((_, i) => `$${i + 1}`).join(", ")}) GROUP BY name`,
        FUNNEL
      );
      propsList = (
        await rdsQuery<{ props: string }>(
          "SELECT props FROM events WHERE name = 'chat-usage' ORDER BY id DESC LIMIT 500",
          []
        )
      ).map((r) => r.props);
    } else {
      if (!hasD1()) return null;
      await ensureAuxTable("d1:events", async () => {
        await d1Init();
        await d1Raw(
          EVENTS_DDL_D1,
          []
        );
      });
      funnelRows = await d1Raw(
        `SELECT name, COUNT(*) AS n FROM events WHERE name IN (${FUNNEL.map(() => "?").join(", ")}) GROUP BY name`,
        FUNNEL
      );
      propsList = (
        await d1Raw<{ props: string }>(
          "SELECT props FROM events WHERE name = 'chat-usage' ORDER BY id DESC LIMIT 500",
          []
        )
      ).map((r) => r.props);
    }

    const funnel: Record<string, number> = {};
    for (const k of FUNNEL) funnel[k] = 0;
    for (const r of funnelRows) if (r.name in funnel) funnel[r.name] = Number(r.n) || 0;

    return { funnel, chatUsage: aggregateChatUsage(propsList) };
  } catch (e) {
    /* 折成 null 前先留痕：否则远端库瞬时故障与「未配置通道」在调用方无法区分，
     * 事后也无法从日志归因（错误信息只进服务端日志，不含查询参数/PII）。 */
    logEvent({
      route: "db",
      ev: "event-stats-failed",
      msg: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
    return null;
  }
}

/** events 通道是否已配置（不探测连通性）：dbEventStats 返回 null 时，调用方用它区分
 * 「未配置任何事件存储通道」与「配置了但远端库故障」——两种失败的处置完全不同。 */
export function eventStatsChannelReady(): boolean {
  return dbChannelEnv() === "huawei" ? hasRds() : hasD1();
}

/** v26.1 G5：拉取阅读实验原始事件（reading-metrics 专用）——通道分派同 dbEventStats。
 *  返回按时间升序的原始行；SQL 聚合在调用方用 JS 做（实验期量级小，可追溯性优先）。 */
export async function dbReadingEvents(days: number): Promise<
  { name: string; account: string; props: string; created_at: string }[] | null
> {
  try {
    if (dbChannelEnv() === "huawei") {
      if (!hasRds()) return null;
      await ensureAuxTable("rds:events", () =>
        rdsQuery(
          EVENTS_DDL_RDS,
          []
        )
      );
      return await rdsQuery<{ name: string; account: string; props: string; created_at: string }>(
        "SELECT name, account, props, created_at FROM events WHERE created_at >= (now() - ($1 || ' days')::interval) ORDER BY id ASC",
        [String(days)]
      );
    }
    if (!hasD1()) return null;
    await ensureAuxTable("d1:events", async () => {
      await d1Init();
      await d1Raw(
        EVENTS_DDL_D1,
        []
      );
    });
    return await d1Raw<{ name: string; account: string; props: string; created_at: string }>(
      "SELECT name, account, props, created_at FROM events WHERE created_at >= datetime('now', ?) ORDER BY id ASC",
      [`-${Math.max(1, Math.min(90, days))} days`]
    );
  } catch {
    return null;
  }
}
