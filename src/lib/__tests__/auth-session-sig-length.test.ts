import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
/* readSessionToken 是纯函数，不碰 cookies()；仍 mock 掉 next/headers 与 db，
 * 让单测不依赖 Next 运行时与任何远端库。 */
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn() })) }));
vi.mock("../server/db", () => ({
  dbGet: vi.fn(async () => null),
  emailHash: (email: string) => email,
}));
vi.mock("../server/deploy-env", () => ({ isProdDeploy: () => false }));

import { createSessionToken, readSessionToken } from "../server/auth";

/* 回归锁：会话签名长度守卫必须按**字节**比较。
 * 旧实现先比 sig.length（UTF-16 码元）再调 crypto.timingSafeEqual(Buffer.from(sig), ...)：
 * 攻击者发 43 个汉字时字符串长度 43 == expect 的 43，但 UTF-8 是 129 字节，
 * timingSafeEqual 抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，异常穿到路由变成 500。
 * 正确行为是当作伪造 cookie → 返回 null（未登录），绝不抛。 */

const USER = { userId: "u1", email: "u@example.com", name: "U", sv: 0 };

describe("readSessionToken 签名长度守卫", () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = "test-secret-for-auth-sig-length";
  });

  it("合法 token 正常解出会话（守卫没有误伤）", () => {
    const token = createSessionToken(USER);
    expect(readSessionToken(token)).toEqual(USER);
  });

  it("多字节 sig（字符数相等、字节数不等）返回 null 且不抛", () => {
    const token = createSessionToken(USER);
    const [payload, sig] = token.split(".");
    expect(sig.length).toBe(43); // ASCII base64url 签名长度
    // 43 个汉字：str.length 相等，但 UTF-8 129 字节——旧实现就在这一步抛错
    const forged = "汉".repeat(sig.length);
    expect(forged.length).toBe(sig.length);
    expect(Buffer.byteLength(forged)).not.toBe(Buffer.byteLength(sig));

    let result: unknown;
    expect(() => {
      result = readSessionToken(`${payload}.${forged}`);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("同长度 ASCII 篡改 sig 返回 null（常量时间比较仍然生效）", () => {
    const token = createSessionToken(USER);
    const [payload, sig] = token.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(flipped.length).toBe(sig.length);
    expect(readSessionToken(`${payload}.${flipped}`)).toBeNull();
  });

  it("缺失 sig / 无分隔点 / 空串均返回 null", () => {
    expect(readSessionToken(undefined)).toBeNull();
    expect(readSessionToken("")).toBeNull();
    expect(readSessionToken("nodot")).toBeNull();
  });
});
