import type { KnowledgeItem } from "./types";

/* 复习队列的触发规则（单一真源，2026-10-26）
 *
 * 背景：用户"复习一次都没触发"。根因不是功能坏了，而是队列只有一个来源——
 * `addKnowledge` 写入 nextReviewAt；Obsidian 导入（importKnowledge）、手动新建
 * （createKnowledge）按设计都不写，早期快照数据也可能从未有过该字段。
 *
 * 本文件的纪律：
 * - 不改变"谁该进队列"的产品决策（导入党仍然不自动进，保持原结构）；
 * - 只做两件事：①旧数据自愈回填（仅 learn/read 来源，用户自己学出来的内容）；
 *              ②提供手动加入的纯函数。
 */

/** 只有「用户自己学出来/读出来」的来源允许自动回填；导入与手写保持原样（用户已决定搁置 Obsidian） */
export const AUTO_REVIEW_SOURCES = ["learn", "read"] as const;

/** 是否是复习队列的合法成员（MOC 目录与未解析占位永不进） */
export function isReviewCandidate(item: KnowledgeItem): boolean {
  if (item.unresolved) return false;
  if ((item.tags ?? []).includes("MOC")) return false;
  return true;
}

/**
 * 旧数据自愈：来源为 learn/read、缺 nextReviewAt、且不是占位/MOC 的笔记
 * 补成今天。返回新数组（无变化时返回原引用，避免多余渲染）。
 */
export function backfillReviewDates(items: KnowledgeItem[], today: string): KnowledgeItem[] {
  let changed = false;
  const out = items.map((k) => {
    if (k.nextReviewAt || !isReviewCandidate(k)) return k;
    if (!(AUTO_REVIEW_SOURCES as readonly string[]).includes(k.source)) return k;
    changed = true;
    return { ...k, nextReviewAt: today };
  });
  return changed ? out : items;
}

/** 手动加入复习时的补丁（也用于「移出复习」时传 null） */
export function reviewPatch(enabled: boolean, today: string): Partial<KnowledgeItem> {
  return enabled
    ? { nextReviewAt: today, reviewStage: 0, lastReviewOk: undefined }
    : { nextReviewAt: undefined, reviewStage: 0 };
}
