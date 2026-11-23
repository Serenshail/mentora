import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 圆桌补答入口生命周期回归锁（批次 D 重构版）。
 * 背景：rtRetry 只有 4 处写入——发言不足、部分失败、主持人失败、用户点「忽略」。
 * 补答全部成功/下一轮成功时没有任何路径清掉它，横幅常驻，再点一次会以旧
 * question 重跑已成功的席位：重复发言、重复纪要、重复 N+1 次模型调用计费。
 *
 * 批次 D 重构：执行逻辑委托共享引擎（council-engine.ts），页面 result 驱动
 * setRtRetry；引擎负责 pendingRetry 持久化（跨入口重试）。本锁按新结构断言：
 *   1. 页面：done 时带会话守卫撤下补答入口（不清别桌的）；
 *   2. 页面：insufficient/partial/主持失败三路都保留 setRtRetry 写入；
 *   3. 引擎：pendingRetry 单写者——席位失败/主持失败以本轮 failedSeatIds 为准，
 *      全部完成时清空；不存在「沿用 prev.seats 重跑已成功席位」的路径。 */

const pageSrc = readFileSync(
  fileURLToPath(new URL("../../app/council/page.tsx", import.meta.url)),
  "utf8"
);
const engineSrc = readFileSync(
  fileURLToPath(new URL("../agent/council-engine.ts", import.meta.url)),
  "utf8"
);

/** 页面结果驱动块：await runDiscussion(...) 之后、finally 之前（CRLF 兼容） */
const resultBlock = pageSrc.match(
  /const result = await runDiscussion\([\s\S]*?\}\s*finally \{/
)?.[0];

describe("圆桌补答入口生命周期（引擎重构版）", () => {
  it("页面：全部完成（done）时带会话守卫撤下本会话补答入口", () => {
    expect(resultBlock, "未能定位 runDiscussion 结果处理块").toBeTruthy();
    const block = resultBlock!;
    expect(block).toMatch(/result\.status === "done"/);
    expect(block).toMatch(/setRtRetry\(\(prev\) =>/);
    // 必须带会话守卫：不能顺手清掉别桌留下的补答入口
    expect(block).toMatch(/prev\.sessionId === sessionId/);
    // 命中时清空（置 null），未命中原样保留
    expect(block).toMatch(/\? null : prev/);
  });

  it("页面：发言不足 / 部分失败 / 主持失败 三路都保留补答入口写入", () => {
    const block = resultBlock!;
    expect(block).toMatch(/result\.status === "insufficient"/);
    expect(block).toMatch(/result\.status === "partial"/);
    expect(block).toMatch(/result\.hostFailed/);
    /* 部分失败的 note 用本轮完成席位数（不数旧席位） */
    expect(block).toMatch(/goodTakes\)\.length} 席生成/);
  });

  it("引擎：pendingRetry 以本轮 failedSeatIds 为准；完成时清空", () => {
    /* 部分失败：纪要已按完成席位生成，失败席位留 pendingRetry（三元） */
    expect(engineSrc).toMatch(/pendingRetry:\s*\n?\s*failedSeatIds\.length > 0\s*\n?\s*\?\s*\{/);
    /* 主持人失败：无条件以本轮 failedSeatIds 持久化（不再有 prev.seats 合并） */
    expect(engineSrc).toMatch(/pendingRetry:\s*\{\s*\n?\s*question:/);
    expect(engineSrc).not.toMatch(/prev\.seats/);
    expect(engineSrc).not.toMatch(/prev\?\.seats/);
    /* hostOnly/补答重试路径在全部完成时清空 pendingRetry（防重复重跑已成功席位）：
     * 三元的假分支落 null（发言不足不可重试 / 全部完成）。 */
    expect(engineSrc).toMatch(/\?\s*\{[\s\S]{0,400}?\}\s*:\s*null/);
  });

  it("引擎：互斥与迟到写纪律（同会话拒绝、abort 后不落库）", () => {
    expect(engineSrc).toMatch(/activeRuns\.has\(sessionId\)/);
    expect(engineSrc).toMatch(/if \(signal\.aborted\) return;/);
    /* 席位与主持的落库都在 signal 守卫之后（取消时返回 cancelled） */
    expect(engineSrc).toMatch(/if \(signal\.aborted\) \{\s*return \{ status: "cancelled"/);
  });
});
