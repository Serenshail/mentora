import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 重排本阶段流程必须只有一份实现（回归锁） ============
 * 背景：「重排本阶段」的 window.prompt → toast("正在重排…") → 动态 import
 * regeneratePhase → 按 r.ok 分支 toast 的整段异步 handler 在 PhasePlanPanel 与
 * PlanTimeline 各写一份，且两份拷贝已漂移——PlanTimeline 版的确认文案包含
 * 「标题相同的天会保留学习记录，其余会被替换（旧目录会存进历史版本，可回看）」
 * 的破坏性操作警示，PhasePlanPanel 版没有：同一 regeneratePhase 调用从不同入口
 * 触发时用户得到的删除风险提示不一致。
 *
 * 修复：收口为模块级 regenPhaseFlow，两个入口共用；统一采用完整警示文案。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

describe("learn/[id]：重排流程收口为单一实现", () => {
  it("regeneratePhase 只在共享 helper 中调用一次（两份拷贝已删除）", () => {
    expect(PAGE.match(/regeneratePhase\(/g)?.length).toBe(1);
    expect(PAGE).toMatch(/async function regenPhaseFlow\(/);
  });

  it("两个入口都走共享实现（保留各自的标题前缀）", () => {
    expect(PAGE).toMatch(/void regenPhaseFlow\(goal, phase, phase\.title\)/);
    expect(PAGE).toMatch(/void regenPhaseFlow\(goal, phase, `阶段\$\{pi \+ 1\} · \$\{phase\.title\}`\)/);
  });

  it("破坏性操作警示全文只此一份（PhasePlanPanel 版不再缺警示）", () => {
    expect(
      PAGE.match(/标题相同的天会保留学习记录，其余会被替换（旧目录会存进历史版本，可回看）。/g)?.length
    ).toBe(1);
    expect(PAGE).not.toContain("重排后学习日结构会变化"); // 旧漂移文案已移除
  });
});
