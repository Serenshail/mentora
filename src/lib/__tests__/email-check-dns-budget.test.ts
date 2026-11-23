import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 回归锁：checkEmailDeliverable 的 DNS 取证必须有总预算。
 *
 * 修复前（email-check.ts:34/41）是两次裸的串行 promisify(dns.*)：
 * resolveMx 失败后再 resolveA，各自只受 c-ares 内建超时（数秒且含重试）约束，
 * 黑洞型解析器下两段叠加可达数十秒。注册路由（app/api/auth/register/route.ts:54）
 * 在写库前 await 它——自托管端没有 Vercel maxDuration 兜底，用户注册会被拖死，
 * 声明的 fail-open 迟迟走不到。
 *
 * 锁四件事：
 *  1) MX 永不回包 → 预算耗尽后按"无法取证"放行（ok:true），不会永远 pending；
 *  2) 预算在 MX/A 之间共享：MX 烧掉大半预算后，A 只剩剩余部分，总时长不叠加；
 *  3) 正常路径不受影响：MX 有记录直接放行；MX 空数组仍判失败；
 *  4) 超时/成功路径都不残留定时器（不泄漏 timer）。 */

const h = vi.hoisted(() => ({ resolveMx: vi.fn(), resolveA: vi.fn() }));

/* email-check 在模块加载时 promisify 这两个函数，所以 mock 必须是 node 回调风格 */
vi.mock("node:dns", () => ({
  default: { resolveMx: h.resolveMx, resolve: h.resolveA },
}));

import { checkEmailDeliverable, EMAIL_DNS_BUDGET_MS } from "../email-check";

type Cb = (err: NodeJS.ErrnoException | null, records?: unknown) => void;

beforeEach(() => {
  vi.useFakeTimers();
  h.resolveMx.mockReset();
  h.resolveA.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 永不回调：模拟丢包不回包的 DNS 黑洞 */
const blackhole = () => new Promise<void>(() => {});

describe("checkEmailDeliverable：DNS 取证总预算", () => {
  it("MX 黑洞 → 预算内 settle 为 fail-open(ok:true)，不永远 pending", async () => {
    h.resolveMx.mockImplementation(() => blackhole());
    h.resolveA.mockImplementation(() => blackhole());

    const p = checkEmailDeliverable("user@blackhole.example");
    await vi.advanceTimersByTimeAsync(EMAIL_DNS_BUDGET_MS + 10);

    expect(await p).toEqual({ ok: true });
    expect(h.resolveMx).toHaveBeenCalledTimes(1);
    expect(h.resolveA).toHaveBeenCalledTimes(1); // MX 超时后仍按设计退查 A
    expect(vi.getTimerCount()).toBe(0); // 预算定时器已清理
  });

  it("预算共享：MX 烧掉大半后 A 只用剩余预算，总时长不超过一个预算", async () => {
    const mxUsed = EMAIL_DNS_BUDGET_MS - 500;
    // MX 在预算快耗尽时才以 NXDOMAIN 失败
    h.resolveMx.mockImplementation((_d: string, cb: Cb) =>
      setTimeout(() => cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })), mxUsed)
    );
    // A 也黑洞
    h.resolveA.mockImplementation(() => blackhole());

    const p = checkEmailDeliverable("user@shared-budget.example");

    // MX 阶段结束
    await vi.advanceTimersByTimeAsync(mxUsed + 10);
    expect(h.resolveA).toHaveBeenCalledTimes(1);

    // 只再给剩余预算（500ms）就必须 settle；若 A 拿到独立的新预算，这里仍会 pending
    await vi.advanceTimersByTimeAsync(EMAIL_DNS_BUDGET_MS - mxUsed + 10);
    expect(await p).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("正常路径：MX 有记录直接放行，不再查 A", async () => {
    h.resolveMx.mockImplementation((_d: string, cb: Cb) =>
      cb(null, [{ exchange: "mx.example.com", priority: 10 }])
    );

    expect(await checkEmailDeliverable("user@good.example")).toEqual({ ok: true });
    expect(h.resolveA).not.toHaveBeenCalled();
  });

  it("MX 空数组仍判失败（无收信服务），不因加超时而放行", async () => {
    h.resolveMx.mockImplementation((_d: string, cb: Cb) => cb(null, []));

    const r = await checkEmailDeliverable("user@no-mx.example");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("没有配置收信服务");
  });

  it("MX 失败 + A 成功 → 放行（少数域用 A 直收）", async () => {
    h.resolveMx.mockImplementation((_d: string, cb: Cb) =>
      cb(Object.assign(new Error("ENODATA"), { code: "ENODATA" }))
    );
    h.resolveA.mockImplementation((_d: string, cb: Cb) => cb(null, ["1.2.3.4"]));

    expect(await checkEmailDeliverable("user@a-only.example")).toEqual({ ok: true });
  });

  it("临时邮箱与格式错误在 DNS 之前短路，不产生查询", async () => {
    expect((await checkEmailDeliverable("user@mailinator.com")).ok).toBe(false);
    expect((await checkEmailDeliverable("not-an-email")).ok).toBe(false);
    expect(h.resolveMx).not.toHaveBeenCalled();
    expect(h.resolveA).not.toHaveBeenCalled();
  });
});
