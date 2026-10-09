"use client";

/* 学习时段：按本地时间返回当前时段并在 <html> 上打 data-period。
 * 早读 5-9 / 上午 9-12 / 午后 12-17 / 晚自习 17-23 / 深夜 23-5 */
export type Period = "morning" | "forenoon" | "afternoon" | "evening" | "night";

export const PERIOD_LABEL: Record<Period, string> = {
  morning: "早读",
  forenoon: "上午",
  afternoon: "午后",
  evening: "晚自习",
  night: "深夜",
};

export function periodOf(d = new Date()): Period {
  const h = d.getHours();
  if (h >= 5 && h < 9) return "morning";
  if (h >= 9 && h < 12) return "forenoon";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 23) return "evening";
  return "night";
}

export function applyPeriodTheme() {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-period", periodOf());
}

export const PERIOD_GREETING: Record<Period, string> = {
  morning: "早上好。趁脑子干净，啃最难的。",
  forenoon: "上午效率高，把主线推一段。",
  afternoon: "午后适合练习和输出。",
  evening: "晚自习。复习今天学过的，趁还记得。",
  night: "深夜了，刷完这条就去睡。",
};
