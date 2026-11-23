import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 流式生成节流：不再逐 delta 全文重解析（回归锁） ============
 * 背景：讲义/答疑流式的 onDelta 逐 chunk setState，每到达一个 chunk 就重渲染整个
 * DayPanel/AskCoach，<Markdown>（react-markdown v10 无内部缓存）对已累积全文重新
 * parse——解析成本随文本线性增长、按 chunk 次数累乘为 O(n²)。讲义是产品里最贵最长
 * 的生成，弱设备上流式后半段明显卡顿。
 * （Markdown 组件本身已 memo 化：历史消息 text 不变即短路；本锁针对「正在增长的
 * 那一条」的逐 delta 重渲染。）
 *
 * 修复：delta 只入 buf + 80ms 批量 flush（flushNow），收尾兜底最后一个窗口内的增量，
 * finally 清掉未触发的定时器（防幽灵刷新）。AskCoach 与 genLesson 两处同修。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

const coach = PAGE.slice(
  PAGE.indexOf("function AskCoach"),
  PAGE.indexOf("/* ================= 随手记")
);
const dayPanel = PAGE.slice(PAGE.indexOf("function DayPanel"));

describe("learn/[id]：流式 onDelta 必须节流（批量 flush 而非逐 delta setState）", () => {
  it("AskCoach：delta 入 buf 排队 80ms 刷新，不存在逐 delta 直写 state", () => {
    expect(coach).toMatch(
      /onDelta: \(d\) => \{\s*\n\s*buf \+= d;\s*\n\s*if \(!flushTimer\) flushTimer = setTimeout\(flushNow, 80\);\s*\n\s*\}/
    );
    expect(coach).not.toMatch(/setStreamText\(\(p\) => p \+ d\)/);
  });

  it("genLesson：同款节流（讲义是最贵的生成）", () => {
    expect(dayPanel).toMatch(
      /onDelta: \(d\) => \{\s*\n\s*buf \+= d;\s*\n\s*if \(!flushTimer\) flushTimer = setTimeout\(flushNow, 80\);\s*\n\s*\}/
    );
    expect(dayPanel).not.toMatch(/setLesson\(\(p\) => p \+ d\)/);
  });

  it("收尾兜底 flushNow + finally 清定时器（增量不丢、无幽灵刷新）", () => {
    expect(coach).toMatch(/flushNow\(\);/);
    expect(dayPanel).toMatch(/flushNow\(\);/);
    // finally 里的定时器清理两处都要有
    expect(coach.match(/if \(flushTimer\) \{\s*\n\s*clearTimeout\(flushTimer\);/)?.length).toBeGreaterThanOrEqual(1);
    expect(dayPanel.match(/if \(flushTimer\) \{\s*\n\s*clearTimeout\(flushTimer\);/)?.length).toBeGreaterThanOrEqual(1);
  });
});
