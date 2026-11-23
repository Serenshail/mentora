import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* db.ts / reset-code.ts 都是服务端模块（import "server-only"），单测里豁免该护栏 */
vi.mock("server-only", () => ({}));

/* ============ 重置码失败计数在 GitHub 兜底通道上必须真落盘（8 次即焚） ============
 * 缺陷：consumeResetCode 的 mismatch 分支曾写 dbPut(p, rec, { encrypted: true })，
 * 既不带 sha 也不带 overwriteOnConflict。GitHub Contents API 对「已存在文件 + 无 sha 的 PUT」
 * 恒返 422（db.ts:663-677 只有 overwriteOnConflict 才回读 sha 重试），抛错被本行
 * .catch(() => {}) 吞掉 → attempts 永远读回 0，MAX_ATTEMPTS=8 在该通道形同虚设。
 * 修复后：写入带 dbGet 的 _sha + overwriteOnConflict，且 _sha 不得混进持久化记录。 */

const ENV_KEYS = [
  "AUTH_SECRET", "DB_CHANNEL",
  "DATABASE_URL", "REDIS_URL",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_D1_API_TOKEN",
  "GITHUB_DB_REPO", "GITHUB_DB_TOKEN",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

async function loadModules(env: Record<string, string>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const db = await import("../server/db");
  const resetCode = await import("../server/reset-code");
  return { db, resetCode };
}

const GH_ENV = {
  AUTH_SECRET: "test-secret-for-reset-code",
  DB_CHANNEL: "github",
  GITHUB_DB_REPO: "owner/repo",
  GITHUB_DB_TOKEN: "gh-token",
};

/** GitHub Contents API 桩：已存在文件的无 sha PUT/DELETE 恒 422（与真实 API 一致） */
function stubGitHub(
  files: Map<string, { content: string; sha: string }>,
  opts: { onPut?: (p: string) => void } = {}
) {
  let seq = 0;
  const res = (status: number, json: unknown) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => json, text: async () => "" }) as unknown as Response;

  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const p = decodeURIComponent(new URL(String(url)).pathname.split("/contents/")[1] ?? "");
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as { content?: string; sha?: string }) : undefined;

    if (method === "GET") {
      const cur = files.get(p);
      if (!cur) return res(404, { message: "Not Found" });
      return res(200, { content: cur.content, sha: cur.sha, encoding: "base64" });
    }
    if (method === "PUT") {
      /* onPut 模拟并发写（管理员重新发码）：必须在取 cur 之前发生，
       * 这样后面的 sha 比对用的是并发写之后的新 sha。 */
      opts.onPut?.(p);
      const cur = files.get(p);
      if (cur && !body?.sha) return res(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
      if (body?.sha && body.sha !== cur?.sha) return res(409, { message: "sha mismatch" });
      seq += 1;
      const sha = `sha-${seq}`;
      files.set(p, { content: String(body?.content ?? ""), sha });
      return res(cur ? 200 : 201, { content: { sha } });
    }
    if (method === "DELETE") {
      const cur = files.get(p);
      if (!cur) return res(404, { message: "Not Found" });
      if (!body?.sha) return res(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
      if (body.sha !== cur.sha) return res(409, { message: "sha mismatch" });
      files.delete(p);
      return res(200, { content: null });
    }
    return res(405, { message: "method not allowed" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const EMAIL = "user@example.com";
const CODE = "ABCD-EFGH";

async function seed(db: typeof import("../server/db"), files: Map<string, { content: string; sha: string }>) {
  const p = `reset/${db.emailHash(EMAIL)}.json`;
  const rec = { code: CODE, expiresAt: Date.now() + 86_400_000, attempts: 0, createdAt: Date.now() };
  files.set(p, {
    content: Buffer.from(db.encrypt(rec), "utf8").toString("base64"),
    sha: "sha-seed",
  });
  return p;
}

function storedAttempts(db: typeof import("../server/db"), files: Map<string, { content: string; sha: string }>, p: string) {
  const f = files.get(p);
  if (!f) return null;
  const rec = db.decrypt<{ attempts: number; code: string }>(Buffer.from(f.content, "base64").toString("utf8"));
  return rec;
}

describe("consumeResetCode：GitHub 兜底通道上失败计数必须落盘", () => {
  it("并发使用同一码时，GitHub 原子占位只允许一次成功", async () => {
    const files = new Map<string, { content: string; sha: string }>();
    stubGitHub(files);
    const { db, resetCode } = await loadModules(GH_ENV);
    await seed(db, files);
    const results = await Promise.all([
      resetCode.consumeResetCode(EMAIL, CODE),
      resetCode.consumeResetCode(EMAIL, CODE),
    ]);
    expect(results.sort()).toEqual(["none", "ok"]);
    expect(await resetCode.consumeResetCode(EMAIL, CODE)).toBe("none");
  });

  it("连续 7 次错误码：每次 attempts 都 +1 持久化（旧实现恒被 422 吞掉、停在 0）", async () => {
    const files = new Map<string, { content: string; sha: string }>();
    stubGitHub(files);
    const { db, resetCode } = await loadModules(GH_ENV);
    const p = await seed(db, files);

    for (let i = 1; i <= 7; i++) {
      expect(await resetCode.consumeResetCode(EMAIL, "ZZZZ-ZZZZ")).toBe("mismatch");
      const rec = storedAttempts(db, files, p);
      expect(rec, `第 ${i} 次失败后记录不应消失`).not.toBeNull();
      expect(rec!.attempts).toBe(i);
      expect(rec!.code).toBe(CODE); // 计数写回不得篡改/覆盖原码
    }
  });

  it("第 8 次错误码：达到 MAX_ATTEMPTS 即焚（记录删除，后续校验返回 none）", async () => {
    const files = new Map<string, { content: string; sha: string }>();
    stubGitHub(files);
    const { db, resetCode } = await loadModules(GH_ENV);
    const p = await seed(db, files);

    for (let i = 1; i <= 7; i++) {
      expect(await resetCode.consumeResetCode(EMAIL, "ZZZZ-ZZZZ")).toBe("mismatch");
    }
    expect(await resetCode.consumeResetCode(EMAIL, "ZZZZ-ZZZZ")).toBe("mismatch");
    expect(files.has(p)).toBe(false);
    expect(await resetCode.consumeResetCode(EMAIL, CODE)).toBe("none");
  });

  it("读到的记录已被管理员重新发码覆盖（sha 失配）→ 旧记录不得把新码写回", async () => {
    const files = new Map<string, { content: string; sha: string }>();
    const NEW_CODE = "WXYZ-2345";
    const { db, resetCode } = await loadModules(GH_ENV);
    const p = await seed(db, files);
    /* 在 dbGet 之后、dbPut 之前模拟「管理员重新发码」：文件换成新码、sha 也变了。
     * 修复后写入带旧 sha，GitHub 侧 409 拒绝，新码不会被旧 rec 覆盖回去。 */
    stubGitHub(files, {
      onPut: (target) => {
        const f = files.get(target);
        if (!f) return;
        const rec = db.decrypt<Record<string, unknown>>(Buffer.from(f.content, "base64").toString("utf8"));
        files.set(target, {
          content: Buffer.from(db.encrypt({ ...rec, code: NEW_CODE, attempts: 0 }), "utf8").toString("base64"),
          sha: "sha-reissued",
        });
      },
    });

    expect(await resetCode.consumeResetCode(EMAIL, "ZZZZ-ZZZZ")).toBe("mismatch");
    expect(storedAttempts(db, files, p)).toMatchObject({ code: NEW_CODE, attempts: 0 });
  });

  it("持久化记录不得混入 dbGet 注入的 _sha 字段", async () => {
    const files = new Map<string, { content: string; sha: string }>();
    stubGitHub(files);
    const { db, resetCode } = await loadModules(GH_ENV);
    const p = await seed(db, files);

    expect(await resetCode.consumeResetCode(EMAIL, "ZZZZ-ZZZZ")).toBe("mismatch");
    const f = files.get(p)!;
    const raw = db.decrypt<Record<string, unknown>>(Buffer.from(f.content, "base64").toString("utf8"));
    expect(raw).not.toHaveProperty("_sha");
    expect(Object.keys(raw).sort()).toEqual(["attempts", "code", "createdAt", "expiresAt"]);
  });

  it("issueResetCode 对已存在记录可覆盖（否则 GitHub 通道重新发码恒 422）", async () => {
    const files = new Map<string, { content: string; sha: string }>();
    stubGitHub(files);
    const { db, resetCode } = await loadModules(GH_ENV);
    const p = await seed(db, files);

    const { code, expiresAt } = await resetCode.issueResetCode(EMAIL);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const rec = storedAttempts(db, files, p)!;
    expect(rec.code).toBe(code);
    expect(rec.attempts).toBe(0);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});
