import { MASTERY_ORDER, type GradingResult, type MasteryStatus } from "./types";

/* ========= 掌握状态机（Learn Anything assessment-integrity） =========
 * 规则：L1-L4 提示下完成最高只记 guided；L5 完整示范后原题不得记 independent；
 * 结论对但依据错不升级；一次偶然答对不覆盖此前引导证据（historicalHighest 保底）。
 * ungradable 不算任何证据。
 * v17：从 store.ts 拆出为纯模块——状态机是产品的方法论心脏，必须可单测
 * （store.ts 模块初始化挂浏览器存储，Node 测试环境拉不动）。 */

export function advanceMastery(
  cur: MasteryStatus | undefined,
  hist: MasteryStatus | undefined,
  verdict: GradingResult,
  hintLevel: number | undefined,
  opts?: { /** apply/build 题无提示判对：这是"变化情境中仍能完成"的直接证据 */ applyEvidence?: boolean }
): { next: MasteryStatus; hist: MasteryStatus } {
  const order = MASTERY_ORDER;
  const idx = (m: MasteryStatus) => order.indexOf(m);
  const h = hist ?? cur ?? "unknown";
  if (verdict === "ungradable") return { next: cur ?? "unknown", hist: h };
  const hl = typeof hintLevel === "number" ? hintLevel : 0;
  const base: MasteryStatus = cur ?? "unknown";
  let next: MasteryStatus = base;
  if (verdict === "correct") {
    if (hl >= 5) next = base === "unknown" ? "exposed" : base; // L5 完整示范：原题不升级过 exposed
    else if (hl >= 1) next = maxStatus("guided", base); // L1-L4：guided 封顶
    // 无提示答对：变式/实操题可直达 transferable（v17：此前六级里两级永不可达）
    else next = maxStatus(opts?.applyEvidence ? "transferable" : "independent", base);
  } else if (verdict === "partially_correct") {
    next = maxStatus("guided", base === "unknown" ? "exposed" : base);
  } else {
    // incorrect：不升级；连续错误由 FSRS/复习队列处理,不在此降级历史
    next = base === "unknown" ? "exposed" : base;
  }
  return { next, hist: idx(next) > idx(h) ? next : h };
}

export function maxStatus(a: MasteryStatus, b: MasteryStatus): MasteryStatus {
  return MASTERY_ORDER.indexOf(a) >= MASTERY_ORDER.indexOf(b) ? a : b;
}

/** 验收通过后,把本日知识点按判分/提示等级推进掌握状态并同步进第二大脑的对应笔记 */
export function masteryFromQuiz(
  items: { verdict: GradingResult; hintLevel?: number; kind?: string }[]
): MasteryStatus {
  // 取所有题里最弱的证据作为本日知识点的保守估计（Learn Anything:证据从紧不从松）
  let worst: MasteryStatus = "durable";
  for (const it of items) {
    const { next } = advanceMastery("unknown", undefined, it.verdict, it.hintLevel, {
      applyEvidence: it.kind === "apply" || it.kind === "build",
    });
    if (MASTERY_ORDER.indexOf(next) < MASTERY_ORDER.indexOf(worst)) worst = next;
  }
  if (worst === "durable") worst = "independent"; // 单日到不了 durable(需延迟复习)
  return worst;
}

/** 复习→掌握接线（v17）：「延迟后仍能独立回忆成功」是长期保持的直接证据。
 *  从紧：只在当前等级之上补一步，且要求累计通过次数足够；
 *  失败不降级（遗忘由 FSRS 重新排期负责，不是对历史证据的否定）。
 *  passReps = FSRS reps - lapses（本卡累计主动回忆成功次数）。 */
export function masteryFromReview(
  cur: MasteryStatus | undefined,
  pass: boolean,
  passReps: number,
  stabilityDays: number
): MasteryStatus {
  const c: MasteryStatus = cur ?? "unknown";
  if (!pass) return c;
  switch (c) {
    case "unknown":
    case "exposed":
      return passReps >= 1 ? "guided" : c;
    case "guided":
      return passReps >= 2 ? "independent" : c;
    case "independent":
    case "transferable":
      return passReps >= 4 && stabilityDays >= 21 ? "durable" : c;
    default:
      return c; // durable 已是顶点
  }
}
