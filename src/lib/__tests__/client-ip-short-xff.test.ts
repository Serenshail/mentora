import { afterEach, describe, expect, it, vi } from "vitest";

/* rate-limit.ts 是服务端模块（server-only），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

import { clientIp } from "../server/rate-limit";

/* ============ XFF 段数不足可信跳数时的退化分支 ============
 * 旧实现用 Math.max(0, parts.length - hops) 取下标：当段数少于可信跳数时
 * 被钳到 parts[0]，而 parts[0] 恰是 HTTP 语义上客户端可自填的最左段——
 * 攻击者每次换一个伪造值就得到全新限流桶（login/reset/chat/admin-pwfail 全失效）。
 * 正确语义：请求没有穿过全部可信代理 ⇒ 整条 XFF 不可信，回落 x-real-ip / unknown。 */

const req = (xff?: string, real?: string) =>
  new Request("https://mentora.example/", {
    headers: {
      ...(xff ? { "x-forwarded-for": xff } : {}),
      ...(real ? { "x-real-ip": real } : {}),
    },
  });

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe("clientIp 短 XFF 退化", () => {
  it("段数少于可信跳数时不用最左段，回落 x-real-ip", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    // 只有一层代理（或攻击者直连源站自带单段 XFF）：1 段 < 2 跳
    expect(clientIp(req("6.6.6.6", "203.0.113.9"))).toBe("203.0.113.9");
  });

  it("段数少于可信跳数且无 x-real-ip 时回落 unknown", () => {
    process.env.TRUSTED_PROXY_HOPS = "3";
    expect(clientIp(req("6.6.6.6"))).toBe("unknown");
  });

  it("伪造段轮换无法换桶：短 XFF 下键稳定", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    const a = clientIp(req("6.6.6.1"));
    const b = clientIp(req("6.6.6.2"));
    expect(a).toBe("unknown");
    expect(a).toBe(b);
  });

  it("段数恰好等于可信跳数时仍取最左段（正常链路不回归）", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req("1.2.3.4, 203.0.113.9"))).toBe("1.2.3.4");
  });

  it("段数多于可信跳数时仍从右往左数（默认 1 跳不受影响）", () => {
    expect(clientIp(req("10.0.0.1, 203.0.113.9"))).toBe("203.0.113.9");
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req("9.9.9.9, 1.2.3.4, 203.0.113.9"))).toBe("1.2.3.4");
  });
});
