import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 设置页 4 个裸 fetch 硬超时的回归锁 ============
 * 背景：change-password / account DELETE / profile GET / referral GET 均未设超时——
 * 移动网 TCP 半开场景下：savingPwd 永久 true（按钮无限转圈）、savingDel 锁死且跳转
 * 永不执行、姓名/头像既不回填也不走 catch 兜底、邀请页永远停在骨架屏。
 * 代码库自身已有硬超时纪律（auth-client：login/register 30s、logout 8s、me 12s，
 * 注释明确「反代/连接挂起时不能把 busy 锁死」）。修复：四处统一补 AbortSignal.timeout。 */

const SRC = readFileSync(join(process.cwd(), "src/app/settings/page.tsx"), "utf8");

/** 取 marker 之后 window 个字符的窗口，检查是否包含 pattern */
function around(marker: string, pattern: RegExp, window = 400): boolean {
  const i = SRC.indexOf(marker);
  expect(i, `找不到 ${marker}`).toBeGreaterThan(-1);
  return pattern.test(SRC.slice(i, i + window));
}

describe("settings 页每条请求都有硬超时", () => {
  it("profile GET 12s（与 /api/auth/me 同款）", () => {
    expect(around('fetch("/api/auth/profile"', /signal: AbortSignal\.timeout\(12_000\)/)).toBe(true);
  });

  it("change-password POST 30s（login/register 同款：db 层 withRetry 最坏 ≈22s 不能更短）", () => {
    expect(around('fetch("/api/auth/change-password"', /signal: AbortSignal\.timeout\(30_000\)/)).toBe(true);
  });

  it("account DELETE 30s（注销链路写库/清会话，挂起时跳转永不执行）", () => {
    expect(around('fetch("/api/auth/account"', /signal: AbortSignal\.timeout\(30_000\)/)).toBe(true);
  });

  it("referral GET 12s（挂起时邀请页永远停在骨架屏）", () => {
    expect(around('fetch("/api/referral"', /signal: AbortSignal\.timeout\(12_000\)/)).toBe(true);
  });

  it("全页不存在无 signal 的裸 fetch（本页这四处之外没有其他 fetch 调用）", () => {
    const fetchCalls = SRC.match(/await fetch\(/g) ?? [];
    expect(fetchCalls.length).toBe(4);
  });
});
