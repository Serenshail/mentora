import { describe, expect, it } from "vitest";
import type { DayPlan, Phase } from "@/lib/types";

/* 付费墙豁免回归锁（修复：viewDayLocked 未豁免已通过阶段的天）。
 * 三处契约曾自相矛盾：页面注释（L293-294「只拦新内容，已完成/已通过的阶段照常可看」）、
 * PhasePaywall 文案（L972「你已经完成的阶段…随时可以回看」）、PlanTimeline 判定
 * （L1156 `phase.status !== "passed"` 才标 paywalled、条目可点）。父层唯一渲染闸门
 * viewDayLocked 修复前只看阶段下标——会员过期的用户曾在其订阅期内通过第 3+ 阶段时，
 * 时间线显示可点、点进去却是付费墙。本文件把修复后的判定钉死。 */
describe("付费墙豁免判定（page.tsx viewDayLocked / PlanTimeline locked 契约）", () => {
  const FREE_PHASE_LIMIT = 2;

  /* 与 page.tsx 修复后逐字一致的纯判定（page.tsx 是 hook 组件文件无法直接单测；
   * 两份表达式必须同步改，防契约静默漂移——本文件就是那份"同步清单"）。 */
  const phaseIndexOf = (phases: Phase[], day: DayPlan | null | undefined): number =>
    day ? phases.findIndex((p) => p.id === day.phaseId) : -1;
  const dayViewExempt = (day: DayPlan | null | undefined): boolean => {
    if (!day) return false;
    return day.status === "passed" || day.status === "skipped";
  };
  const viewDayLocked = (
    freeTier: boolean,
    viewDay: DayPlan | null | undefined,
    phases: Phase[]
  ): boolean => freeTier && !!viewDay && phaseIndexOf(phases, viewDay) >= FREE_PHASE_LIMIT && !dayViewExempt(viewDay);

  /* PlanTimeline 条目锁（page.tsx PlanTimeline entries.map 内，修复后同口径） */
  const entryLocked = (
    freeTier: boolean,
    pi: number,
    phase: Phase,
    day: DayPlan | undefined
  ): boolean => {
    const paywalled = freeTier && pi >= FREE_PHASE_LIMIT && phase.status !== "passed";
    return (!day || day.status === "locked") || (paywalled && !dayViewExempt(day));
  };

  const mkDay = (id: string, phaseId: string, status: DayPlan["status"]): DayPlan =>
    ({ id, phaseId, status } as DayPlan);

  it("原 bug 场景：会员过期用户点开第 3 阶段的已通过天，不再渲染付费墙", () => {
    const phases: Phase[] = [
      { id: "ph1", status: "passed", dayIds: ["d1"] },
      { id: "ph2", status: "active", dayIds: ["d2"] },
      { id: "ph3", status: "passed", dayIds: ["d3"] }, // 订阅期内学完的阶段
      { id: "ph4", status: "active", dayIds: ["d4"] }, // 过期后未学的新内容
    ] as Phase[];
    expect(viewDayLocked(true, mkDay("d3", "ph3", "passed"), phases)).toBe(false);
    expect(viewDayLocked(true, mkDay("d4", "ph4", "locked"), phases)).toBe(true); // 新内容照旧上墙
    expect(viewDayLocked(true, mkDay("d1", "ph1", "locked"), phases)).toBe(false); // 前 2 阶段免费
    expect(viewDayLocked(false, mkDay("d4", "ph4", "locked"), phases)).toBe(false); // 会员不过闸
    expect(viewDayLocked(true, null, phases)).toBe(false); // 无 viewDay 不闸（走 activePhase 分支）
  });

  it("已跳过的天同样豁免——skipped 也是已完成路径（progress 统计口径含 skipped）", () => {
    expect(dayViewExempt(mkDay("d3", "p3", "skipped"))).toBe(true);
    expect(dayViewExempt(mkDay("d3", "p3", "active"))).toBe(false);
    expect(dayViewExempt(null)).toBe(false);
  });

  it("豁免看天的 status 而非 phase.status：重排在已通过阶段里引入的新 locked 天仍上墙", () => {
    /* 事实链（读码核验）：setPhaseCatalog 只翻 locked→active（store.ts:677），不重置
     * phase.status；但重排一个已通过阶段会新建 stub 天（store.ts:656-667），首天还会
     * 翻成 active（store.ts:679）。标题对齐沿用旧 id 的天保留 passed（alignPhaseDayIds）。
     * 按天豁免才能放行旧记录、拦住新内容。 */
    const passedPhaseWithRegenResidue: Phase = { id: "ph3", status: "passed", dayIds: ["d3", "n1", "n2"] } as Phase;
    const phases: Phase[] = [{ id: "p1", status: "active" }, { id: "p2", status: "active" }, passedPhaseWithRegenResidue] as Phase[];
    expect(viewDayLocked(true, mkDay("d3", "ph3", "passed"), phases)).toBe(false); // 旧记录可回看
    expect(viewDayLocked(true, mkDay("n1", "ph3", "active"), phases)).toBe(true);  // 重排新天是付费内容
    expect(viewDayLocked(true, mkDay("n2", "ph3", "locked"), phases)).toBe(true);
  });

  it("条目锁与时间线口径一致：已通过天可点，重排新天带会员标记不可点", () => {
    const residue: Phase = { id: "ph3", status: "passed", dayIds: ["d3", "n1"] } as Phase;
    expect(entryLocked(true, 2, residue, mkDay("d3", "ph3", "passed"))).toBe(false);
    expect(entryLocked(true, 2, residue, mkDay("n1", "ph3", "locked"))).toBe(true);
    expect(entryLocked(true, 2, residue, undefined)).toBe(true); // 目录条目无天记录 → 锁
  });
});
