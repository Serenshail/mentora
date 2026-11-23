import type { Plan } from "./types";

/** 学习计划完成度（0~1）：只有验收通过 / 强制跳过算完成。
 * `active` 是已解锁、正在学但尚未验收的天，`locked` 是未解锁的天，二者都不计入。
 * 与 learn/[id] 页任务导航计数、小程序 overview 页进度保持同一口径。 */
export function planProgress(plan: Plan | null | undefined): number {
  if (!plan) return 0;
  const days = Object.values(plan.days);
  if (!days.length) return 0;
  const done = days.filter((d) => d.status === "passed" || d.status === "skipped").length;
  return done / days.length;
}
