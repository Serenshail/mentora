import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* auth 端点体积闸回归锁（修复：login/register/reset-password/device/account/
 * change-password/profile 直接 await req.json()——整包缓冲进内存再解析，
 * 自托管（腾讯云 + Caddy 默认不限 body）下 GB 级 chunked JSON 可在限流额度内
 * 用 JSON.parse 内存尖峰 OOM 单进程 Node；Vercel 有 ~4.5MB 平台封顶，自托管没有）。
 * 修复后走 src/lib/server/body-limit.ts 双层闸（与 sync/chat 体积闸同一纪律）：
 *  1) content-length 声明超标 → 未读一字节就 413，限流之后、任何 KV/DB 查询之前；
 *  2) chunked（无声明值）→ 流式按块限量累计，一超限立即断流 413——
 *     与 chat 的 req.text() 终闸的本质区别：不把整包缓冲完才量大小，
 *     GB 级包最多只缓冲到超限那一刻。
 * 本锁钉住四件会真出事的事：
 *  A) 声明超标包回 413 且不碰 json()/DB（不打疼内存与 KV）；
 *  B) chunked 超标包在超限块处断流，绝不耗尽整个流（OOM 回归锁）；
 *  C) 正常小载荷（跨多块的真实 JSON）不被误伤，仍走完原链路；
 *  D) 语义对齐：非法 JSON 回 {} 走原字段校验路径（旧行为 .catch(() => ({}))）。 */

vi.mock("server-only", () => ({}));

const dbQueries: string[] = [];
vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async (path: string) => {
    dbQueries.push(path);
    return null;
  }),
  dbPut: vi.fn(async () => {}),
  dbDelete: vi.fn(async () => {}),
  dbDeleteDir: vi.fn(async () => {}),
  emailHash: vi.fn((s: string) => `h_${s}`),
}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.7"),
}));

vi.mock("@/lib/server/auth", () => ({
  verifySession: vi.fn(async () => null),
  verifyPassword: vi.fn(() => false),
  hashPassword: vi.fn(() => ({ salt: "s", hash: "h" })),
  mintSession: vi.fn(async () => {}),
}));

vi.mock("@/lib/server/login-guard", () => ({
  dummyScryptVerify: vi.fn(() => {}),
  getFailState: vi.fn(async () => undefined),
  bumpFail: vi.fn(async () => {}),
  clearFail: vi.fn(async () => {}),
}));

vi.mock("@/lib/server/entitlement", () => ({
  computeEntitlement: vi.fn(() => "active"),
  setExpiry: vi.fn(async () => ({})),
}));

vi.mock("@/lib/server/referral", () => ({
  ensureRefCode: vi.fn(async () => ({})),
}));

vi.mock("@/lib/admin-emails", () => ({
  isAdminEmail: vi.fn(() => false),
}));

vi.mock("@/lib/server/deploy-env", () => ({
  deployEnv: vi.fn(() => "local"),
}));

vi.mock("@/lib/server/reset-code", () => ({
  consumeResetCode: vi.fn(async () => ({ ok: false, reason: "INVALID" })),
}));

import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as resetPOST } from "@/app/api/auth/reset-password/route";

/* 构造最小 NextRequest 形状：route/body-limit 只用 headers.get / body / json()。
 * body 传 AsyncIterable 模拟 chunked 流（ReadableStream 也是 AsyncIterable，同语义）。 */
function makeReq(opts: {
  contentLength?: string;
  body?: AsyncIterable<Uint8Array> | null;
  json?: () => Promise<unknown>;
}): NextRequest {
  const headers = new Headers();
  if (opts.contentLength !== undefined) headers.set("content-length", opts.contentLength);
  return {
    headers,
    body: opts.body ?? null,
    json: opts.json ?? (async () => ({})),
  } as unknown as NextRequest;
}

/* chunked 流替身：每产出一块记一笔，用于断言「超限即断流，未耗尽整个流」 */
function chunkedStream(chunks: Uint8Array[], pulled: number[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const c of chunks) {
      pulled.push(c.byteLength);
      yield c;
    }
  })();
}

const encoder = new TextEncoder();
const LIMIT = 512 * 1024;

beforeEach(() => {
  dbQueries.length = 0;
});

describe("login 体积闸（声明预检 + chunked 流式终闸）", () => {
  it("声明 content-length 超标：未读 json()、未查 DB 就 413", async () => {
    const jsonRead = vi.fn(async () => ({}));
    const res = await loginPOST(makeReq({ contentLength: String(LIMIT + 25), json: jsonRead }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "请求体过大" });
    expect(jsonRead).not.toHaveBeenCalled(); // 一字节都没读
    expect(dbQueries).toEqual([]); // 没碰 KV/DB（不打疼内存与存储）
  });

  it("chunked 无声明值的超标包：超限块处断流 413，绝不耗尽整个流（OOM 回归锁）", async () => {
    // 614KB 的 JSON 分 10 块发来（每块 ~61KB，第 9 块累计越过 512KB 上限）
    const bigJson = JSON.stringify({ email: "a@b.c", password: "x".repeat(600 * 1024) });
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 10; i++) {
      chunks.push(encoder.encode(bigJson.slice((i * bigJson.length) / 10, ((i + 1) * bigJson.length) / 10)));
    }
    const pulled: number[] = [];
    const res = await loginPOST(makeReq({ body: chunkedStream(chunks, pulled) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "请求体过大" });
    expect(dbQueries).toEqual([]); // 不查用户库
    // 关键断言：断流发生时剩下的块永不再产出——GB 级包不会缓冲进内存
    expect(pulled.length).toBeGreaterThan(0);
    expect(pulled.length).toBeLessThan(chunks.length);
  });

  it("正常小载荷（跨多块的合法 JSON）不被误伤：走完原链路回 401", async () => {
    const raw = encoder.encode('{"email":"a@b.c","password":"x"}');
    const third = Math.ceil(raw.length / 3);
    const chunks = [raw.slice(0, third), raw.slice(third, 2 * third), raw.slice(2 * third)];
    const pulled: number[] = [];
    const res = await loginPOST(makeReq({ body: chunkedStream(chunks, pulled) }));
    expect(pulled.length).toBe(chunks.length); // 全部正常读完
    expect(res.status).toBe(401); // 密码错（mock verifyPassword=false），链路走通
    expect(dbQueries).toEqual(["users/h_a@b.c.json"]); // 按邮箱查了用户库（路由拼完整路径）
  });

  it("非法 JSON 回 {} 走原字段校验（与旧 req.json().catch(() => ({})) 语义对齐）", async () => {
    const pulled: number[] = [];
    const res = await loginPOST(
      makeReq({ body: chunkedStream([encoder.encode("not-json")], pulled) })
    );
    expect(res.status).toBe(401); // 不是 413：解析失败=空对象=空邮箱，走原 401 路径
    expect(dbQueries).toEqual(["users/h_.json"]);
  });

  it("无 body 可读（req.body 为空）回退 json()：合法小载荷正常放行", async () => {
    const res = await loginPOST(
      makeReq({ json: async () => ({ email: "a@b.c", password: "x" }) })
    );
    expect(res.status).toBe(401);
    expect(dbQueries).toEqual(["users/h_a@b.c.json"]);
  });
});

describe("reset-password 体积闸（证明不止 login 一个端点）", () => {
  it("声明超标：consumeResetCode/DB 都没碰就 413", async () => {
    const res = await resetPOST(makeReq({ contentLength: String(LIMIT + 1) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "请求体过大" });
    expect(dbQueries).toEqual([]);
  });

  it("正常小载荷不被误伤：空邮箱回 400 原校验路径", async () => {
    const pulled: number[] = [];
    const res = await resetPOST(
      makeReq({ body: chunkedStream([encoder.encode("{}")], pulled) })
    );
    expect(res.status).toBe(400); // 邮箱格式不对（原校验路径）
    expect(dbQueries).toEqual([]);
  });
});
