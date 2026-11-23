import { clsx, type ClassValue } from "clsx";
import type { Resource } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/* 「默认类仅兜底」合并，供 Skeleton 等需要可覆盖默认形状的组件使用。
 * 背景：cn 只是 clsx（无 tailwind-merge），基类与调用方传入的同族类
 * （如 rounded-lg 与 rounded-2xl）会同时保留在 class 里，胜负由 Tailwind 4
 * 构建产物中样式的发射顺序（按类名字母序）决定而非调用意图——17 处
 * Skeleton 调用方传的 rounded-2xl 就这样被基类 rounded-lg 静默覆盖
 * （产物 CSS 里 .rounded-lg 排在 .rounded-2xl 之后）。
 * 规则：调用方传了同族类（词元以前缀开头）时默认类整个不下发（彻底消除
 * 同族冲突，且不再依赖发射顺序的运气）；没传才补默认类。带变体前缀
 * （md:/hover: 等）的词元不算同族覆盖——它们与无条件默认类作用在不同条件下。 */
export function skeletonClassName(className?: string): string {
  const tokens = (className ?? "").trim().split(/\s+/).filter(Boolean);
  return cn(
    "animate-pulse",
    tokens.some((t) => t.startsWith("rounded")) ? "" : "rounded-lg",
    tokens.some((t) => t.startsWith("bg-")) ? "" : "bg-black/[0.06]",
    ...tokens,
  );
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

/* 客户端 id 生成。
 * ⚠️ 不能用 crypto.randomUUID()：该 API 只在"安全上下文"（HTTPS / localhost）暴露，
 * 自托管走 http://IP:3000 时 window.crypto.randomUUID 是 undefined →
 * 所有客户端建对象（目标/笔记/书/会话）当场抛错，整个功能静默失效。
 * 这里退回 getRandomValues（非安全上下文也可用），再不行用 Math.random 兜底。 */
export function uid(prefix = ""): string {
  const id = randomChars(8);
  return prefix ? `${prefix}_${id}` : id;
}

function randomChars(n: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(n);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % 36];
  return out;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/* 本地日历日 key（YYYY-MM-DD）。
 * ⚠️ 与 todayISO() 的 UTC 日**不是**同一个概念，别互换：学习日期（todayISO/
 * addDays/掌握记录）全站按 UTC 日对齐，那是数据口径；本函数只用于「按本地
 * 一天」的体验键（如提醒横幅当天已关闭 rem-banner-<日期>）。
 * 不能用 toISOString()：UTC+8 的本地 0:00–8:00 期间 UTC 仍是前一天，关闭时
 * 写入的是昨天的 key，本地 8 点后再加载就按「新的一天」重新弹出横幅。 */
export function localDayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

/** 复制到剪贴板。
 * navigator.clipboard 只在安全上下文（HTTPS/localhost）存在——自托管 HTTP 下为 undefined，
 * 旧实现直接 await 会抛错、按钮点了没反应。这里降级到 execCommand("copy")。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到下面的降级路径 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
