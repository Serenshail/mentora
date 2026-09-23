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

export function addDays(days: number, from?: string): string {
  const d = from ? new Date(from + "T00:00:00") : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  return Math.round((db - da) / 86400000);
}

/** 间隔重复队列：第 1/3/7/15 天（来自用户学习方法论） */
export const REVIEW_INTERVALS = [1, 3, 7, 15] as const;

export function nextReviewDate(stage: number): string {
  const idx = Math.min(stage, REVIEW_INTERVALS.length - 1);
  return addDays(REVIEW_INTERVALS[idx]);
}

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
