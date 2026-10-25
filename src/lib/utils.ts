import { clsx, type ClassValue } from "clsx";
import type { Resource } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/* 资料"新近+实用优先、经典降权"的确定性排序(工程层,不 trusting 模型单独输出)。
 * kind 权重:官方/官方文档最高;年份越新分越高;evergreen 经典旧著排到最后作"经典补充"。 */
const KIND_SCORE: Record<string, number> = {
  official: 5,
  doc: 5,
  course: 4,
  tutorial: 4,
  paper: 3,
  repo: 4,
  book: 2,
  classic: 1,
};

export function rankResources(rs: Resource[]): Resource[] {
  const nowYear = new Date().getFullYear();
  const score = (r: Resource) =>
    (KIND_SCORE[r.kind ?? ""] ?? 3) +
    Math.max(0, Math.min(2, ((r.year ?? nowYear - 5) - (nowYear - 8)) / 4));
  return [...rs].sort((a, b) => {
    if (!!a.evergreen !== !!b.evergreen) return a.evergreen ? 1 : -1;
    return score(b) - score(a);
  });
}

export const KIND_LABEL: Record<string, string> = {
  official: "官方",
  doc: "官方文档",
  course: "视频课",
  tutorial: "教程",
  paper: "论文",
  repo: "开源仓库",
  book: "书",
  classic: "经典",
};

export function uid(prefix = ""): string {
  const id = crypto.randomUUID().slice(0, 8);
  return prefix ? `${prefix}_${id}` : id;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/* 纯 UTC 日历运算：学习日期（todayISO/masteredAt/quizLog.date）全部是 UTC 日，
 * 这里也必须按 UTC 日加减——此前本地时区解析 + UTC 输出，东八区一次 addDays(-1)
 * 会跳过两天，首页连续天数被砍半（2026-10-24 修复） */
export function addDays(days: number, from?: string): string {
  const base = from ? Date.parse(`${from}T00:00:00Z`) : Date.now();
  if (Number.isNaN(base)) return todayISO();
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return 0;
  return Math.round((db - da) / 86400000);
}

/* 旧固定阶梯（1/3/7/14/30）已删——v14 起调度器为 FSRS（store.ts recordReview），
 * v17 起复习还会推进掌握状态（mastery.ts）。勿再往这里加死代码。 */

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function streakFrom(dates: string[]): number {
  const set = new Set(dates);
  let streak = 0;
  let cursor = todayISO();
  // 今天没学不打断连击，从昨天开始数
  if (!set.has(cursor)) cursor = addDays(-1);
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDays(-1, cursor);
  }
  return streak;
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
