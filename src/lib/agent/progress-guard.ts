"use client";

/* 任务进展守卫（RUN-01 / PRD §6.3）
 *
 * 要解决的问题（A09）：用户说「把第二阶段改成一周」，模型却连续调 get_goal / search_brain /
 * get_goal，每次换个参数但没拿到新信息，直到把轮数预算烧完才给一句「已尽力」。
 *
 * PRD 对「进展」的定义很明确：**获得必要缺失信息、确定对象、形成/更新草稿、审批或成功提交**——
 * 不是「调用次数变了」「返回长度变了」。
 *
 * 本模块只做确定性判断，不调模型：
 *  - 同一「规范化工具名 + 参数 + 对象版本」的只读结果复用（版本变了就失效）；
 *  - 非相邻重复识别（不只比上一轮，旧实现 lastRoundSigs 只比上一轮）；
 *  - 换参数空转识别：参数不同但**信息面无增长**（同一工具、同一对象、返回内容摘要相同）；
 *  - 连续 N 轮无新证据 → 建议收尾（让 runner 走一次聚焦澄清或如实说明阻塞）。
 *
 * 研究型任务（web_search / read_url 读新来源）不套用业务修改阈值，避免误杀。
 */

import { isWriteCall, type ToolName } from "./protocol";

/** 只读工具：结果可复用（写入工具绝不缓存，写入结果本身就是副作用） */
const READ_TOOLS = new Set<ToolName>([
  "manage_workspace",
  "search_brain",
  "read_context",
  "get_note",
  "list_goals",
  "get_goal",
  "list_books",
  "list_sessions",
  "get_settings_public",
  "resume_workflow",
  "get_book",
  "get_session",
]);

/** 研究型工具：合理读取新来源不算空转（PRD §6.3 明确要求不误杀） */
const RESEARCH_TOOLS = new Set<ToolName>(["web_search", "read_url"]);

export interface ReadRecord {
  /** 规范化签名（工具 + 参数 + 对象版本） */
  sig: string;
  /** 结果的内容指纹（用于识别「换了参数但结果一样」） */
  digest: string;
  /** 第几轮拿到 */
  round: number;
  content: string;
}

export interface ProgressState {
  /** 签名 → 记录（同一签名只保留第一次，后续命中即复用） */
  reads: Map<string, ReadRecord>;
  /** 每轮的进展标记 */
  rounds: { round: number; advanced: boolean; note: string }[];
  /** 连续无进展轮数 */
  stalledStreak: number;
}

export function newProgressState(): ProgressState {
  return { reads: new Map(), rounds: [], stalledStreak: 0 };
}

/** 参数规范化：键排序 + 去空白，避免「同一调用不同书写顺序」被当成新调用。
 *  对象版本（goalId/phaseId 等）必须参与签名——版本变了就该重新读（PRD §6.3）。 */
export function normalizeSignature(name: ToolName, args: Record<string, unknown>): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = walk((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  };
  return `${name}:${JSON.stringify(walk(args))}`;
}

/** 结果指纹：只抹平易变的空白差异，不做有损截断。
 *  短内容（绝大多数工具结果）归一化后整串比较，任何真实差异都能区分；长内容（列表/分页/
 *  大段正文）取「精确长度 + 头 + 中部 + 尾」。此前是「头 120 + 尾 60 + 40 字长度桶」，
 *  分页读取（list_goals offset=0/25 首条目重叠、尾部同为闭合括号）会撞成同一指纹，
 *  被误判「换了参数但结果相同（无新信息）」，累计 stalledStreak 让合法多页读取提前被放弃。 */
export function digestOf(content: string): string {
  const norm = content.replace(/\s+/g, " ").trim();
  if (norm.length <= 300) return norm;
  const mid = Math.floor(norm.length / 2);
  return `${norm.length}|${norm.slice(0, 120)}|${norm.slice(mid - 40, mid + 40)}|${norm.slice(-60)}`;
}

export interface LookupOutcome {
  /** 命中可复用结果（同签名同版本） */
  reuse?: ReadRecord;
  /** 换参数但结果相同（无新信息） */
  duplicateOf?: ReadRecord;
  /** 是否是研究型工具（不参与空转判定） */
  research: boolean;
}

/** 查缓存 / 判重复（不写入）。 */
export function lookupRead(state: ProgressState, name: ToolName, args: Record<string, unknown>): LookupOutcome {
  if (!READ_TOOLS.has(name)||isWriteCall(name,args)) return { research: RESEARCH_TOOLS.has(name) };
  const sig = normalizeSignature(name, args);
  const hit = state.reads.get(sig);
  if (hit) return { reuse: hit, research: false };
  return { research: false };
}

/** 记录一次读取结果，并判断这一轮是否算「有进展」。
 *  advanced=false 表示：拿到的信息和之前某次一样（换参数空转），或者根本没有新对象被确定。 */
export function recordRead(
  state: ProgressState,
  round: number,
  name: ToolName,
  args: Record<string, unknown>,
  content: string
): { advanced: boolean; note: string; duplicateOf?: ReadRecord } {
  if (!READ_TOOLS.has(name)||isWriteCall(name,args)) {
    /* 研究型工具读新来源 = 有进展；写入类由 runner 自己算进展 */
    return { advanced: RESEARCH_TOOLS.has(name), note: RESEARCH_TOOLS.has(name) ? "读取了新来源" : "非读取工具" };
  }
  const sig = normalizeSignature(name, args);
  const digest = digestOf(content);

  /* 同签名但**内容变了** = 对象版本更新（计划被改过），属于新信息：
   * 缓存失效并更新记录，不能当成「重复读取」把真实变化吃掉。 */
  const same = state.reads.get(sig);
  if (same) {
    if (same.digest !== digest) {
      state.reads.set(sig, { sig, digest, round, content });
      return { advanced: true, note: "同一对象的内容已变化（版本更新）" };
    }
    return { advanced: false, note: "重复读取同一对象（结果已复用）", duplicateOf: same };
  }
  /* 换参数但结果指纹相同：也没有新信息 */
  const dup = [...state.reads.values()].find((r) => r.digest === digest);
  if (dup) {
    state.reads.set(sig, { sig, digest, round, content });
    return { advanced: false, note: "换了参数但结果与之前相同（无新信息）", duplicateOf: dup };
  }
  state.reads.set(sig, { sig, digest, round, content });
  return { advanced: true, note: "获得了新信息" };
}

/** 每轮结束后登记进展，维护连续空转计数。 */
export function markRound(state: ProgressState, round: number, advanced: boolean, note: string): void {
  state.rounds.push({ round, advanced, note });
  state.stalledStreak = advanced ? 0 : state.stalledStreak + 1;
}

/** 是否该停止同策略（PRD §6.3：连续两轮模型调用没有新证据或动作进展 → 停止相同策略）。
 *  返回 null 表示还可以继续；返回字符串则是给模型的收尾指令。 */
export function stallVerdict(state: ProgressState, threshold = 2): string | null {
  if (state.stalledStreak < threshold) return null;
  const recent = state.rounds.slice(-state.stalledStreak).map((r) => r.note);
  return [
    `你已经连续 ${state.stalledStreak} 轮没有获得新信息（${recent.join("；")}）。`,
    "不要再换参数重复读取同一批对象——重复读取不会产生新信息。",
    "现在二选一：① 如果只缺一个关键信息就能动手，用一句话向用户提出**这一个**聚焦问题；",
    "② 如果信息已经够了，直接给出结论/方案并说明你已经做了什么、还差什么。",
    "禁止再用同一批工具换参数试探。",
  ].join("\n");
}

/** 缓存统计（报告/诊断用）。 */
export function progressStats(state: ProgressState) {
  return {
    reads: state.reads.size,
    rounds: state.rounds.length,
    stalledStreak: state.stalledStreak,
    advancedRounds: state.rounds.filter((r) => r.advanced).length,
  };
}
