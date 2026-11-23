import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

/* ============ consumeResetCode：存储读失败必须是独立错误态，不能伪装成「码不存在」============
 * 历史缺陷：dbGet 抛错（KV 超时/5xx/网络抖动）时 catch 返回 "none"，reset-password 路由
 * 据此回 401「重置码不存在或已使用，请联系管理员重新发放」——存储故障期间持有有效重置码
 * 的用户收到假空态与一条无效指引（此时 issueResetCode 同样受影响，管理员重发也会失败）。
 * 修复：读失败返回 "error"，路由作答 503，与本端点读用户记录失败同一纪律。 */

let failRead = false;
let failClaim = false;
let claimed = false;
let record: unknown = null;

vi.mock("../server/db", () => ({
  emailHash: () => "hash",
  dbGet: vi.fn(async () => {
    if (failRead) throw new Error("KV timeout");
    return record;
  }),
  dbPut: vi.fn(async () => ({ sha: "mem" })),
  dbDelete: vi.fn(async () => {}),
  dbPutIfAbsent: vi.fn(async () => {
    if (failClaim) throw new Error("claim failed");
    if (claimed) return false;
    claimed = true;
    return true;
  }),
}));

import { consumeResetCode } from "../server/reset-code";

const EMAIL = "u@x.com";
const CODE = "ABCD-EFGH";

beforeEach(() => {
  failRead = false;
  failClaim = false;
  claimed = false;
  record = null;
});

describe("consumeResetCode：错误态与空态必须可区分", () => {
  it("存储读失败 → error（不是 none）", async () => {
    failRead = true;
    expect(await consumeResetCode(EMAIL, CODE)).toBe("error");
  });

  it("记录不存在（dbGet 返回 null）→ none", async () => {
    record = null;
    expect(await consumeResetCode(EMAIL, CODE)).toBe("none");
  });

  it("码不匹配 → mismatch；码正确 → ok", async () => {
    record = { code: CODE, expiresAt: Date.now() + 60_000, attempts: 0, createdAt: Date.now() };
    expect(await consumeResetCode(EMAIL, "ZZZZ-ZZZZ")).toBe("mismatch");
    expect(await consumeResetCode(EMAIL, CODE)).toBe("ok");
  });

  it("占位失败时拒绝重置", async () => {
    record = { code: CODE, expiresAt: Date.now() + 60_000, attempts: 0, createdAt: Date.now() };
    failClaim = true;
    expect(await consumeResetCode(EMAIL, CODE)).toBe("error");
  });

  it("并发使用同一个码只有一个请求成功", async () => {
    record = { code: CODE, expiresAt: Date.now() + 60_000, attempts: 0, createdAt: Date.now() };
    const results = await Promise.all([consumeResetCode(EMAIL, CODE), consumeResetCode(EMAIL, CODE)]);
    expect(results.sort()).toEqual(["none", "ok"]);
  });
});

describe("reset-password 路由：error → 503（不是 401）", () => {
  it("路由对 error 判返回 503，且不与 none 的 401 文案混同", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../../app/api/auth/reset-password/route.ts", import.meta.url)),
      "utf8"
    );
    expect(route).toMatch(/verdict === "error"/);
    const idx = route.indexOf('verdict === "error"');
    const block = route.slice(idx, idx + 220);
    expect(block).toMatch(/status: 503/);
  });
});
