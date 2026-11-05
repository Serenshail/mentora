import { afterEach, describe, expect, it, vi } from "vitest";

/* rate-limit.ts 是服务端模块（server-only），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

import { clientIp } from "../server/rate-limit";

/* ============ 限流键防伪造回归锁 ============
 * X-Forwarded-For 的最左段是客户端可自填的（HTTP 语义如此）：
 * 旧实现取它当限流键，攻击者每次换一个伪造值就换一个全新桶，
 * login/admin 的爆破防线与全站限流全部失效。 */

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

describe("clientIp", () => {
  it("默认取可信代理追加的最右地址，伪造前缀不参与", () => {
    expect(clientIp(req("1.2.3.4, 203.0.113.9"))).toBe("203.0.113.9");
  });

  it("攻击者轮换伪造前缀，限流键保持一致", () => {
    const a = clientIp(req("10.0.0.1, 203.0.113.9"));
    const b = clientIp(req("10.0.0.2, 203.0.113.9"));
    expect(a).toBe(b);
    expect(a).toBe("203.0.113.9");
  });

  it("两层代理（LB→Caddy→app）按可信跳数取真实客户端", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req("1.2.3.4, 203.0.113.9"))).toBe("1.2.3.4");
  });

  it("没有 XFF 时回落到 x-real-ip", () => {
    expect(clientIp(req(undefined, "198.51.100.7"))).toBe("198.51.100.7");
  });

  it("非法 TRUSTED_PROXY_HOPS 回落到默认 1 跳", () => {
    process.env.TRUSTED_PROXY_HOPS = "0";
    expect(clientIp(req("1.2.3.4, 203.0.113.9"))).toBe("203.0.113.9");
  });
});
