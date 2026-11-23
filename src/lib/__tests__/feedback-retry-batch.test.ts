import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 反馈队列重试：限量投递 + 429 不计 tries + 止损持久化兜底（回归锁） ============
 * 背景（三个连环缺陷）：
 * ① 服务端 /api/feedback 是持久令牌桶 capacity:5、refill 2/min（route.ts:16），且与用户
 *    的直接提交共用同一 IP 配额。挂载时 retry() 把整个队列（上限 20 条）连发：一次重试
 *    窗口只有约 5 条能送达，第 6 条起全部 429 → bumpTries。服务 503 期间攒下的反馈，
 *    运维修好后连续刷新几次页面就把剩余条目的 tries 耗到 MAX_TRIES=5 被止损移出——
 *    内容从未到达 GitHub Issue，用户只得到一句「请重新提交」。
 * ② 429 不是这条反馈的问题，是重试循环撞上家的限流：计入 tries 属于误伤。
 * ③ bumpTries 的 localStorage.setItem 在配额满/被禁时静默失败，tries 只留在内存——
 *    每次挂载读到的磁盘 tries 都是旧值，MAX_TRIES 止损失效，同一会话每挂载一轮
 *    就重发一批（「无限重试」）。
 * 修复：每挂载只投前 RETRY_BATCH 条；429 → rate-limited（break，不计 tries）；
 * tries 取「磁盘 vs 会话内存」的最大值兜底，止损在会话内必然生效。
 * 沿用 feedback-503-retry.test.ts 的源码扫描护栏风格（仓库无 jsdom）。 */

const src = readFileSync(
  fileURLToPath(new URL("../../components/feedback-widget.tsx", import.meta.url)),
  "utf8"
);

describe("反馈队列重试的限流/止损语义", () => {
  it("每次挂载限量投递：retry 循环只取前 RETRY_BATCH 条，不整队列连发", () => {
    expect(src).toMatch(/const RETRY_BATCH = \d+/);
    // 循环必须以 slice(0, RETRY_BATCH) 截取（而不是 for (const fb of q)）
    expect(src).toMatch(/for \(const fb of q\.slice\(0, RETRY_BATCH\)\)/);
    expect(src).not.toMatch(/for \(const fb of q\) \{/);
  });

  it("429 单列为 rate-limited，且不计 tries：撞自家令牌桶不算这条反馈失败", () => {
    const sendBody = src.match(/const send = async \(fb: PendingFeedback\)([\s\S]*?)\n  \};/)?.[1];
    expect(sendBody, "未能定位 send() 函数体").toBeTruthy();
    expect(sendBody).toMatch(/if \(res\.status === 429\) return "rate-limited";/);
    // 429 不得与 fatal 并入同一判定（fatal 只留给内容类 400）
    const fatalLine = sendBody!.match(/if \(([^\n]*)\) return "fatal";/)?.[1] ?? "";
    expect(fatalLine).not.toMatch(/429/);
    // retry 循环遇到 rate-limited 立即停（不继续烧配额）
    const retryBody = src.match(/const retry = async \(\) => \{([\s\S]*?)\n    \};/)?.[1];
    expect(retryBody).toMatch(/r === "rate-limited"[\s\S]{0,160}?\n\s*break;/);
    // rate-limited 分支不得 bumpTries / removeOne（条目原样留给下次挂载）
    const rlBranch = retryBody!.match(/r === "rate-limited"([\s\S]*?)\n\s*break;/)?.[1] ?? "";
    expect(rlBranch).not.toMatch(/bumpTries|removeOne/);
  });

  it("止损持久化兜底：tries 取磁盘与会话内存的最大值，bumpTries 同时推进会话计数", () => {
    // 模块级会话兜底存在（组件反复挂载/卸载仍在）
    expect(src).toMatch(/const sessionTries = new Map<string, number>\(\);/);
    expect(src).toMatch(/const itemKey = \(fb: PendingFeedback\)/);
    const retryBody = src.match(/const retry = async \(\) => \{([\s\S]*?)\n    \};/)?.[1];
    expect(retryBody, "未能定位 retry() 函数体").toBeTruthy();
    // 有效 tries = max(磁盘, 会话内存)：磁盘写失败时止损判定仍有内存值可用
    expect(retryBody).toMatch(/Math\.max\((fb\.tries \?\? 0), memTries\)/);
    // bump 失败时内存值被推进（sessionTries.set 与 bumpTries 相邻出现）
    expect(retryBody).toMatch(/bumpTries\(fb\);\s*\n\s*sessionTries\.set\(key, effTries \+ 1\)/);
    // 止损移出若写盘失败（存储满），会话内记死：后续挂载只重试移出、不再投递
    expect(retryBody).toMatch(/if \(removeOne\(fb\)\) sessionTries\.delete\(key\);\s*\n\s*else sessionTries\.set\(key, MAX_TRIES\)/);
    // 已判死的条目（memTries >= MAX_TRIES）走只移出不投递的分支
    expect(retryBody).toMatch(/if \(memTries >= MAX_TRIES\) \{[\s\S]{0,120}?continue;/);
  });
});
