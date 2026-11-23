import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：referral 路由 catch{} 吞掉全部异常且零日志——referralSummary
 * 底层有三种可区分失败：ensureRefCode 抛「账号不存在」（verifySession 降级放行后账号被
 * 并发删除的竞态）、「邀请码生成失败」（连续 5 次码碰撞）、dbGet KV 故障——全被压成同一个
 * 503「邀请码暂时取不到」且无任何记录，线上 KV 抖动时该端点故障完全无迹可查（同组
 * admin/stats 连 401 拒绝都写了 logEvent）；「账号不存在」被误报成「暂时性错误」也误导
 * 排障方向。修复：logEvent 留痕（含 reason），账号不存在 → 401，其余 → 503 照旧。 */

const h = vi.hoisted(() => ({
  logEvent: vi.fn(() => {}),
  throwMsg: null as string | null,
  summary: { refCode: "ABC123", invited: 0, rewardedCount: 0, rewardedDays: 0, list: [] },
}));

vi.mock("@/lib/server/auth", () => ({
  verifySession: vi.fn(async () => ({ email: "inviter@x.com", userId: "u-inviter" })),
}));

vi.mock("@/lib/server/referral", () => ({
  referralSummary: vi.fn(async () => {
    if (h.throwMsg) throw new Error(h.throwMsg);
    return h.summary;
  }),
}));

vi.mock("@/lib/server/config", () => ({ logEvent: h.logEvent }));

import { GET } from "../../app/api/referral/route";

beforeEach(() => {
  h.throwMsg = null;
  h.logEvent.mockClear();
});

describe("referral GET：故障必须可诊断（logEvent + 可区分状态码）", () => {
  it("KV 故障 → 仍 503，但 logEvent 留痕（含 userId 与错误消息）", async () => {
    h.throwMsg = "D1 请求失败（500）";
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("邀请码暂时取不到");
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ route: "referral", ev: "summary-fail", userId: "u-inviter" })
    );
  });

  it("「账号不存在」（会话降级放行后档案被并发删除的竞态）→ 401，不再误报为暂时性错误", async () => {
    h.throwMsg = "账号不存在";
    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("重新登录");
    expect(h.logEvent).toHaveBeenCalled();
  });

  it("「邀请码生成失败」（连续 5 次码碰撞）→ 503 照旧，留痕", async () => {
    h.throwMsg = "邀请码生成失败，稍后再试";
    const res = await GET();
    expect(res.status).toBe(503);
    expect(h.logEvent).toHaveBeenCalled();
  });

  it("成功路径不受影响 → 200 + rewardDays", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refCode: string; rewardDays: number };
    expect(body.refCode).toBe("ABC123");
    expect(body.rewardDays).toBeGreaterThan(0);
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
