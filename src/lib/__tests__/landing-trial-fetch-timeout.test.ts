import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 体验申请提交必须有超时（回归锁） ============
 * 背景：submitTrial 的 POST /api/trial-request 没有 signal/超时，弱网/连接停滞时
 * fetch 可挂起数分钟，期间 trialBusy=true——提交按钮永远「提交中…」且 disabled，
 * 用户无法重试；openTrial 只重置 trialSent 不重置 trialBusy，关掉弹窗再开仍是卡死。
 * 修复：fetch 带 AbortSignal.timeout(15_000)（与 feedback-widget 等全站客户端 fetch
 * 的超时纪律一致），超时走 catch 提示、finally 复位 trialBusy。 */

const src = readFileSync(
  fileURLToPath(new URL("../../components/landing.tsx", import.meta.url)),
  "utf8"
);

describe("landing.tsx submitTrial 超时防线", () => {
  it("POST /api/trial-request 带 AbortSignal.timeout(有限毫秒)", () => {
    const callArgs = src.match(/fetch\("\/api\/trial-request",\s*\{([\s\S]*?)\}\);/)?.[1];
    expect(callArgs, "未能定位 trial-request 的 fetch 调用").toBeTruthy();
    const m = /signal:\s*AbortSignal\.timeout\(\s*(\d[\d_]*)\s*\)/.exec(callArgs!);
    expect(m, "trial-request fetch 缺 signal/AbortSignal.timeout").not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeGreaterThanOrEqual(1000);
  });

  it("trialBusy 仍在 finally 里复位（超时/失败后可重试）", () => {
    const fn = src.match(/const submitTrial = async \(\) => \{([\s\S]*?)\n  \};/)?.[1];
    expect(fn).toBeTruthy();
    expect(fn).toMatch(/finally \{\s*\n\s*setTrialBusy\(false\);/);
  });
});
