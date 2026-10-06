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
/* Learn Anything 动态复习间隔：根据掌握状态和提示等级调整。
 * 独立完成→更长间隔；需要提示→缩短间隔；完整示范后→重头开始。 */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30] as const;

export function nextReviewDate(stage: number): string {
  const idx = Math.min(stage, REVIEW_INTERVALS.length - 1);
  return addDays(REVIEW_INTERVALS[idx]);
}

/** 按掌握状态计算下一轮复习间隔（天）
 * - independent/transferable：正常递进
 * - guided：缩短间隔（还没独立，需要更密复习）
 * - exposed：重头开始
 * - durable：进入长间隔维护 */
export function nextReviewInterval(
  masteryStatus: string | undefined,
  hintLevel: number | undefined,
  currentStage: number
): number {
  // L1-L4 提示完成 = guided，缩短间隔
  if (hintLevel != null && hintLevel >= 1 && hintLevel <= 4) {
    return Math.max(1, Math.min(3, REVIEW_INTERVALS[Math.min(currentStage, 2)]));
  }
  // L5 完整示范 = exposed，重头开始
  if (hintLevel === 5) return 1;
  switch (masteryStatus) {
    case "durable": return 30;
    case "transferable": return 14;
    case "independent": return REVIEW_INTERVALS[Math.min(currentStage, REVIEW_INTERVALS.length - 1)];
    case "guided": return 3;
    case "exposed": return 1;
    default: return REVIEW_INTERVALS[Math.min(currentStage, REVIEW_INTERVALS.length - 1)];
  }
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
