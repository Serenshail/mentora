import "server-only";
import crypto from "node:crypto";

/* ============================================================
 * 存储层（已收口：上层只见 dbGet/dbPut/dbList/dbDelete）
 *
 * 双通道设计（大厂 serverless 标配）：
 *   主通道  Upstash Redis REST —— <10ms、原子写、无限流焦虑
 *   回退   GitHub Contents API —— 无 Upstash 环境变量时使用
 *
 * 两者共用同一套 key（users/xxx.json、sync/yyy.json）与
 * AES-256-GCM 加密，可随时平滑迁移、互为备份。
 * ============================================================ */

/* ---------------- 通用：加密（两通道共用） ---------------- */

function encKey(): Buffer {
  const secret = process.env.AUTH_SECRET || "";
  if (!secret) throw new Error("AUTH_SECRET 未配置");
  return crypto.scryptSync(secret, "mentora-db-v1", 32);
}

export function encrypt(obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decrypt<T>(payload: string): T {
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")) as T;
}

/* ---------------- 通用：重试（指数退避） ---------------- */

const RETRY_STATUS = new Set([403, 429, 500, 502, 503, 504]);
const RETRY_DELAYS = [300, 600, 1200]; // ms

async function withRetry<T>(fn: () => Promise<Response>): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await fn();
      if (!RETRY_STATUS.has(res.status)) return res;
      lastErr = new Error(`status ${res.status}`);
      /* 消费 body 释放连接 */
      await res.text().catch(() => {});
    } catch (e) {
      lastErr = e;
    }
    if (attempt < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("网络错误");
}

/* ---------------- 主通道：Upstash Redis REST ---------------- */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const useUpstash = () => UPSTASH_URL && UPSTASH_TOKEN;

async function upstash<T = unknown>(
  command: (string | number)[]
): Promise<{ result: T }> {
  const res = await withRetry(() =>
    fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(command),
      cache: "no-store",
    })
  );
  if (!res.ok) throw new Error(`Upstash 请求失败（${res.status}）`);
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

/* ---------------- 回退通道：GitHub Contents API ---------------- */

const REPO = process.env.GITHUB_DB_REPO || "";
const TOKEN = process.env.GITHUB_DB_TOKEN || "";

async function ghApi(path: string, method: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await withRetry(() =>
    fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method,
      headers: {
        Authorization: `token ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "mentora",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    })
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch { /* empty body */ }
  return { status: res.status, json };
}

/* ---------------- 统一接口（上层只用这四个） ---------------- */

/** 读（404/null 返回 null）；加密内容自动解密 */
export async function dbGet<T>(path: string, opts: { encrypted?: boolean } = {}): Promise<(T & { _sha?: string }) | null> {
  if (useUpstash()) {
    const raw = await upstashGet(path);
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

  if (useUpstash()) {
    await upstashSet(path, content);
    return { sha: "upstash" };
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
  if (useUpstash()) {
    const names = await upstashList(dir);
    return names.map((name) => ({ name, sha: "upstash" }));
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
  if (useUpstash()) {
    await upstashDelete(path);
    return;
  }

  let res = await ghApi(path, "DELETE", sha ? { sha } : undefined);
  if (res.status === 404) return;
  if (res.status === 422) {
    const cur = await ghApi(path, "GET");
    const fresh = (cur.json as { sha?: string })?.sha;
    res = await ghApi(path, "DELETE", fresh ? { sha: fresh } : undefined);
  }
  if (res.status >= 300) throw new Error(`DB 删除失败（${res.status}）`);
}

export function emailHash(email: string): string {
  return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
}
