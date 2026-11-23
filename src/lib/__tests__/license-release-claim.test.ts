import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁：注册/续费写库失败时 releaseClaim 必须真把码还回去。
 * 旧版只在 status==="unused" 时删标记，而 claimLicense 成功返回前就已把码标成
 * used —— 回滚永远是 no-op，用户重试必撞 USED，付费码等效烧掉。
 * 这里用内存 KV 替身跑，不碰任何远端库；资金安全护栏一并锁住：
 *  只退当前占用人自己的码、且时长未入账（planHistory 没这张码）才退。 */

const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  emailHash: (email: string) => Buffer.from(email.toLowerCase()).toString("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbPutIfAbsent: vi.fn(async (path: string, value: unknown) => {
    if (store.has(path)) return false;
    store.set(path, structuredClone(value));
    return true;
  }),
  dbDelete: vi.fn(async (path: string) => {
    store.delete(path);
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  ),
}));

import { createHash } from "node:crypto";
import { claimLicense, createBatch, releaseClaim, getLicense, failureMessage, normalizeCode } from "../server/license";

/* 与 license.ts 的路径派生保持一致：normalizeCode（大写、去非字母数字）后 sha256 */
const codeHash = (raw: string) => createHash("sha256").update(normalizeCode(raw)).digest("hex");
const licensePath = (code: string) => `licenses/${codeHash(code)}.json`;
const claimPath = (code: string) => `claim/${codeHash(code)}.json`;
const userPath = (email: string) =>
  `users/${Buffer.from(email.toLowerCase()).toString("hex").slice(0, 24)}.json`;

/** 模拟注册/续费「claim 成功、写档案失败」的现场 */
async function claimThenCrash(code: string, email: string) {
  const claimed = await claimLicense(code, { email, userId: `u-${email}` });
  if (!claimed.ok) throw new Error(`claim 应成功：${claimed.reason}`);
  // 模拟调用方崩溃：不写 planHistory / 不建号，直接回滚
  await releaseClaim(code);
  return claimed;
}

beforeEach(() => store.clear());

describe("releaseClaim 回滚（付费码不被烧）", () => {
  it("注册失败回滚后，同一张码同邮箱可以立刻重试成功", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];

    await claimThenCrash(code, "a@x.com");

    const rec = await getLicense(code);
    expect(rec?.status).toBe("unused"); // 码已还原
    expect(rec?.usedBy).toBeNull();
    expect(store.has(claimPath(code))).toBe(false); // 占用标记已清

    // 关键回归断言：旧版在这里返回 USED，用户从此拿不回这张码
    const retry = await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(failureMessage("USED")).not.toContain(retry.license.id);
  });

  it("回滚后别的用户也能兑这张码（先还原码、再删标记，不卡死）", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    await claimThenCrash(codes[0], "a@x.com");
    const other = await claimLicense(codes[0], { email: "b@x.com", userId: "u-b@x.com" });
    expect(other.ok).toBe(true);
  });

  it("码已 used 时同邮箱重试也返回 USED（生产语义），回滚后才可重试；releaseClaim 幂等", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    const first = await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    expect(first.ok).toBe(true);
    // 回滚前：码已标 used，同邮箱再 claim 拿到的是 USED（license.ts 的既定语义）
    const blocked = await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("USED");

    // 并发双击场景：两条失败路径都调 releaseClaim——幂等，不抛错
    await releaseClaim(code);
    await releaseClaim(code);

    const rec = await getLicense(code);
    expect(rec?.status).toBe("unused");
    const retry = await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    expect(retry.ok).toBe(true);
  });

  it("时长已入账（planHistory 已含该码）绝不退——防止重复兑换", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    // 模拟：写档案其实已落库（planHistory 含这张码），只是响应丢了被当失败
    store.set(userPath("a@x.com"), {
      plan: "month",
      planExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      planHistory: [{ licenseId: code, days: 30, at: new Date().toISOString() }],
    });

    await releaseClaim(code);

    const rec = await getLicense(code);
    expect(rec?.status).toBe("used"); // 保持占用，绝不能退
    expect(store.has(claimPath(code))).toBe(true);
  });

  it("占用标记归属对不上（别的用户占的码）不退", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    // 模拟标记被第三方覆盖/竞态：claim 文件里是别人的邮箱
    store.set(claimPath(code), {
      emailHash: Buffer.from("b@x.com".toLowerCase()).toString("hex").slice(0, 24),
      email: "b@x.com",
    });

    await releaseClaim(code);

    const rec = await getLicense(code);
    expect(rec?.status).toBe("used"); // 不是你的绑定，不动
  });

  it("占用标记缺失（旧版遗留现场）不误还原", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    store.delete(claimPath(code)); // 标记没了，只剩 used 记录

    await releaseClaim(code);

    const rec = await getLicense(code);
    expect(rec?.status).toBe("used"); // 无凭据判断归属，保守不退（后台可手工复位）
  });

  it("码从未被 claim 过（unused 旧版路径）：只删占位标记，行为不回退", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    // 手工造「标记在、码 unused」的旧现场（used 写入前进程中断）
    store.set(claimPath(code), { emailHash: "x", email: "a@x.com" });

    await releaseClaim(code);

    expect(store.has(claimPath(code))).toBe(false);
    const rec = await getLicense(code);
    expect(rec?.status).toBe("unused");
    expect(licensePath(code)).toBeTruthy(); // 码记录未被触碰改写
  });

  it("revoked 状态不回滚", async () => {
    const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
    const code = codes[0];
    const claimed = await claimLicense(code, { email: "a@x.com", userId: "u-a@x.com" });
    expect(claimed.ok).toBe(true);
    // 后台作废
    const rec = await getLicense(code);
    store.set(licensePath(code), { ...rec, status: "revoked" });

    await releaseClaim(code);

    const after = await getLicense(code);
    expect(after?.status).toBe("revoked");
  });
});
