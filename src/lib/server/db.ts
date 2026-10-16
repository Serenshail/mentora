import "server-only";
import crypto from "node:crypto";
import zlib from "node:zlib";

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

function encKey(): Buffer {
  const secret = process.env.AUTH_SECRET || "";
  if (!secret) throw new Error("AUTH_SECRET 未配置");
  return crypto.scryptSync(secret, "mentora-db-v1", 32);
}

const GZ_PREFIX = "GZ1.";

export function encrypt(obj: unknown): string {
  // 大库（如几百条笔记的 vault）明文 JSON 可达 9MB+，先 gzip 再加密
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 9 });
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

const RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);
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

async function withRetry<T>(fn: () => Promise<Response>): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fn();
      if (!RETRY_STATUS.has(res.status)) {
        recordNetResult(true);
        return res;
      }
      lastErr = new Error(`status ${res.status}`);
      /* 消费 body 释放连接 */
      await res.text().catch(() => {});
    } catch (e) {
      recordNetResult(false); // 连接失败/超时：网络层问题，计入熔断
      lastErr = e;
    }
    if (attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("网络错误");
}

/** 给 fetch 加硬超时（serverless 里连接挂起会吃满 maxDuration，用户端看到的是"卡死"） */
function timed(): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REMOTE_FETCH_TIMEOUT_MS);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/* ---------------- 主通道：Upstash Redis REST ---------------- */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const hasUpstash = () => Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function upstash<T = unknown>(
  command: (string | number)[]
): Promise<{ result: T }> {
  const res = await withRetry(() => {
    const { signal, done } = timed();
    return fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(command),
      cache: "no-store",
      signal,
    }).finally(done);
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

async function upstashList(dir: string): Promise<string[]> {
  /* SCAN 匹配前缀；返回去掉前缀的文件名 */
  const { result } = await upstash<string[]>(["KEYS", `${dir}/*.json`]);
  return (result || []).map((k) => k.slice(dir.length + 1));
}

async function upstashDelete(path: string): Promise<void> {
  await upstash(["DEL", path]);
}

/* ---------------- 通道 2：Cloudflare D1（HTTP API，免费额度：5M 读/天、100k 写/天） ---------------- */

const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_DB_ID = process.env.CLOUDFLARE_D1_DATABASE_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_D1_API_TOKEN || "";
const hasD1 = () => Boolean(CF_ACCOUNT && CF_DB_ID && CF_TOKEN);

/** 冷启动懒建表：每个 isolate 只跑一次 */
let d1Ready: Promise<void> | null = null;
function d1Init(): Promise<void> {
  d1Ready ??= (async () => {
    await d1Raw("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)", []);
  })();
  return d1Ready;
}

async function d1Raw<T = { k?: string; v?: string }>(sql: string, params: (string | number | null)[]): Promise<T[]> {
  const res = await withRetry(() => {
    const { signal, done } = timed();
    return fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${CF_DB_ID}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
      cache: "no-store",
      signal,
    }).finally(done);
  });
  const j = (await res.json().catch(() => null)) as
    | { success?: boolean; errors?: { code?: number; message?: string }[]; result?: { results?: T[] }[] }
    | null;
  if (!res.ok || !j?.success) {
    recordNetResult(false); // 连上的 400（凭据/库 ID 错/语句拒绝）与断网同等对待：累计 2 次开熔断
    const why = j?.errors?.[0]?.message ?? `status ${res.status}`;
    // 带语句头部（我们自己的固定 SQL 文本）；绝不带参数——参数含邮箱等键路径，不该进日志
    throw new Error(`D1 请求失败（${res.status}）：${why.slice(0, 180)} [${sql.slice(0, 70)}]`);
  }
  return j.result?.[0]?.results ?? [];
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
  // 主行写块数；再逐块 upsert（每条 SQL 均低于 1MB 限制）
  await d1Raw(
    "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    [path, `{"__chunks__":${parts.length}}`]
  );
  for (let i = 0; i < parts.length; i++) {
    await d1Raw(
      "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      [`${path}#p${i}`, parts[i]]
    );
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

/* ---------------- 通道 3：华为云 RDS PostgreSQL（huawei 主数据真源，HW-T-01/02） ----------------
 * 免分块：PG TEXT 无 1MB 限制，大库单行直存；加密语义与 D1/Upstash 完全一致（密文透传）。
 * 懒加载：未配置 DATABASE_URL 时不加载 pg 驱动，旧通道零感知。 */

const DATABASE_URL = process.env.DATABASE_URL || "";
const hasRds = () => Boolean(DATABASE_URL);

type PgPool = { query: (sql: string, params?: (string | number | null)[]) => Promise<{ rows: Record<string, unknown>[] }> };
let rdsPoolInst: PgPool | null = null;
async function rdsPool(): Promise<PgPool> {
  if (!rdsPoolInst) {
    const { Pool } = await import("pg");
    rdsPoolInst = new Pool({ connectionString: DATABASE_URL, max: 5 }) as unknown as PgPool;
  }
  return rdsPoolInst;
}

/** 冷启动懒建表：每个进程只跑一次 */
let rdsReady: Promise<void> | null = null;
function rdsInit(): Promise<void> {
  rdsReady ??= (async () => {
    const pool = await rdsPool();
    await pool.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  })();
  return rdsReady;
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

async function rdsGet(path: string): Promise<string | null> {
  await rdsInit();
  const rows = await rdsQuery<{ v?: string }>("SELECT v FROM kv WHERE k = $1", [path]);
  const v = rows[0]?.v;
  return v == null ? null : v;
}

async function rdsPut(path: string, content: string): Promise<void> {
  await rdsInit();
  // RDS 无 1MB 语句限制（PG TEXT 上限 1GB），单行直存；若从 D1 迁入的块行遗留，写入主行后清理
  await rdsQuery("DELETE FROM kv WHERE substr(k, 1, $1) = $2", [`${path}#p`.length, `${path}#p`]);
  await rdsQuery(
    "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
    [path, content]
  );
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

/* ---------------- 回退通道：GitHub Contents API ---------------- */

const REPO = process.env.GITHUB_DB_REPO || "";
const TOKEN = process.env.GITHUB_DB_TOKEN || "";

async function ghApi(path: string, method: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await withRetry(() => {
    const { signal, done } = timed();
    return fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "mentora",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal,
    }).finally(done);
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch { /* empty body */ }
  return { status: res.status, json };
}

/* ---------------- 统一接口（上层只用这四个） ---------------- */

/** 读（404/null 返回 null）；加密内容自动解密 */
export async function dbGet<T>(path: string, opts: { encrypted?: boolean } = {}): Promise<(T & { _sha?: string }) | null> {
  if (hasUpstash()) {
    const raw = await upstashGet(path);
    if (raw == null) return null;
    const value = opts.encrypted ? decrypt<T>(raw) : (JSON.parse(raw) as T);
    return value as T & { _sha?: string };
  }

  if (hasD1()) {
    const raw = await d1Get(path);
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

/** 写（Upstash 天然原子；GitHub 通道带 sha 乐观并发，冲突 last-write-wins） */
export async function dbPut<T>(
  path: string,
  value: T,
  opts: { encrypted?: boolean; sha?: string | null; overwriteOnConflict?: boolean } = {}
): Promise<{ sha: string }> {
  const content = opts.encrypted ? encrypt(value) : JSON.stringify(value, null, 1);

  if (hasUpstash()) {
    await upstashSet(path, content);
    return { sha: "upstash" };
  }

  if (hasD1()) {
    await d1Put(path, content);
    return { sha: "d1" };
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

/** 列目录，返回 [{name, sha}]（sha 在 Upstash 通道为占位） */
export async function dbList(dir: string): Promise<{ name: string; sha: string }[]> {
  if (hasUpstash()) {
    const names = await upstashList(dir);
    return names.map((name) => ({ name, sha: "upstash" }));
  }

  if (hasD1()) {
    const names = await d1List(dir);
    return names
      .filter((n) => n.endsWith(".json"))
      .map((name) => ({ name, sha: "d1" }));
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
  if (hasUpstash()) {
    await upstashDelete(path);
    return;
  }

  if (hasD1()) {
    await d1Delete(path);
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

export function emailHash(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
}

/** 是否存在跨进程可用的远端 KV（D1/Upstash 任一）；纯 GitHub 兜底时返回 false（写放大不值当） */
export function hasRemoteDb(): boolean {
  return hasUpstash() || hasD1();
}

/** 反馈双写（GitHub Issues 为主通道，D1 存一份冗余；任何失败都不抛出） */
export async function dbFeedbackSave(rec: {
  number: number;
  type: string;
  content: string;
  contact: string;
  page: string;
}): Promise<void> {
  if (!hasD1()) return;
  try {
    await d1Init();
    await d1Raw(
      "CREATE TABLE IF NOT EXISTS feedback (number INTEGER PRIMARY KEY, type TEXT, content TEXT, contact TEXT, page TEXT, created_at TEXT DEFAULT (datetime('now')))",
      []
    );
    await d1Raw(
      "INSERT INTO feedback (number, type, content, contact, page) VALUES (?, ?, ?, ?, ?) ON CONFLICT(number) DO NOTHING",
      [rec.number, rec.type, rec.content, rec.contact, rec.page]
    );
  } catch { /* 双写失败不影响反馈主流程 */ }
}

/** 漏斗埋点落档（/api/track 专用）：D1 events 表，best-effort，失败只丢事件不抛错 */
export async function dbEventSave(rec: {
  name: string;
  account: string;
  path: string;
  props: string;
}): Promise<void> {
  if (!hasD1()) return;
  try {
    await d1Init();
    await d1Raw(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, account TEXT, path TEXT, props TEXT, created_at TEXT DEFAULT (datetime('now')))",
      []
    );
    await d1Raw(
      "INSERT INTO events (name, account, path, props) VALUES (?, ?, ?, ?)",
      [rec.name, rec.account, rec.path, rec.props]
    );
  } catch { /* 埋点绝不影响主流程 */ }
}
