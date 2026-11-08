"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from "ts-fsrs";
import { useShallow } from "zustand/react/shallow";
import { MASTERY_ORDER } from "./types";
import type {
  AgentSession,
  Book,
  BookChapter,
  BookDeposit,
  BookLearning,
  BookMap,
  BookReadStatus,
  BookTransfer,
  ChapterAssessment,
  ChatMsg,
  CouncilSession,
  CustomPersona,
  DayPlan,
  Goal,
  KnowledgeItem,
  MasteryStatus,
  KnowledgeSource,
  KnowledgeType,
  NodeStatus,
  Plan,
  PlanHistoryEntry,
  QuizResult,
  ReadingGoal,
  Settings,
} from "./types";
import { PROVIDERS } from "./ai/providers";
import { todayISO, uid } from "./utils";
import { backfillReviewDates, reviewPatch } from "./review";
import { track, trackReading } from "./track";

/* 验收记录只保留最近 200 次，长文本按字段截断。
 * 云端同步是全量快照 + 服务端 4.5MB 硬上限：quizLog 无界增长会让「推不上」
 * 悄悄变成「本机写盘也失败」，最终丢的是自上次成功落盘以来的全部编辑。 */
const QUIZ_LOG_MAX = 200;
const QUIZ_TEXT_MAX = 600;

function trimQuizResult(r: QuizResult): QuizResult {
  return {
    ...r,
    items: r.items.slice(0, 12).map((it) => ({
      ...it,
      question: it.question.slice(0, QUIZ_TEXT_MAX),
      userAnswer: it.userAnswer.slice(0, QUIZ_TEXT_MAX),
      feedback: it.feedback.slice(0, QUIZ_TEXT_MAX),
    })),
  };
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "demo", // "自动"：跟随服务端配置，无配置时回退演示模式
  apiKey: "",
  model: "",
  baseUrl: "",
  userName: "",
  coachTone: "standard" as const,
};

/* ---- FSRS 自适应间隔调度（目标记忆率 90%；开源算法 ts-fsrs） ---- */
const FSRS = fsrs(generatorParameters({ request_retention: 0.9 }));

function toFsrsCard(k: KnowledgeItem) {
  if (k.fsrs) {
    return {
      ...createEmptyCard(),
      due: new Date(k.fsrs.due),
      stability: k.fsrs.stb,
      difficulty: k.fsrs.dif,
      elapsed_days: k.fsrs.elapsed,
      scheduled_days: k.fsrs.scheduled,
      reps: k.fsrs.reps,
      lapses: k.fsrs.lapses,
      state: k.fsrs.st as State,
      last_review: k.fsrs.last ? new Date(k.fsrs.last) : null,
    };
  }
  const card = createEmptyCard();
  /* 兼容旧数据：reviewStage 0-4 → 预热 reps，让老笔记延续原有进度感 */
  for (let i = 0; i < k.reviewStage; i++) {
    const r = FSRS.repeat(card, new Date())[Rating.Good];
    Object.assign(card, r.card);
  }
  return card;
}

function stageOf(scheduled: number): number {
  /* 展示用 0-4：把 FSRS 天数映射回间隔轮次（1/3/7/15 的近似分档） */
  if (scheduled <= 1) return 0;
  if (scheduled <= 3) return 1;
  if (scheduled <= 7) return 2;
  if (scheduled <= 15) return 3;
  return 4;
}

interface AppState {
  /** 首页智能体对话（本地记忆，不参与云同步；跨设备不迁移，M2 范围）
   * v23.2 起由 agentSessions 承载（多会话）；agentChat 仅作 v6 迁移源 */
  agentChat: ChatMsg[];
  /** 主对话框多会话（v23.2）：新建/切换/删除，标题=首问截断 */
  agentSessions: AgentSession[];
  agentActiveId: string | null;
  goals: Goal[];
  knowledge: KnowledgeItem[];
  books: Book[];
  sessions: CouncilSession[];
  customPersonas: CustomPersona[];
  folders: string[]; // 第二大脑的文件夹（Obsidian 式目录树）
  settings: Settings;
  _storeUserId: string | null; // 内部：当前 localStorage 仓所属用户

  addGoal: (g: Goal) => void;
  updateGoal: (id: string, patch: Partial<Goal>) => void;
  removeGoal: (id: string) => void;
  removeGoalAndNotes: (id: string, includeKnowledge?: boolean) => void;
  setPlan: (goalId: string, plan: Plan) => void;
  /** 写入整个阶段的天目录：一次性建齐全部天（含占位 stub），目录立即完整可见 */
  setPhaseCatalog: (
    goalId: string,
    phaseId: string,
    boundary: string,
    catalog: { id: string; title: string; knowledgePoints: string[] }[]
  ) => void;
  /** 阶段重排前快照旧目录（V26.2-H5，PRD §6.4 版本留痕）：只增不删，每目标最多 5 条 */
  snapshotPhase: (goalId: string, phaseId: string, reason?: string) => void;
  /** 单日详情回填：把展开后的完整 DayPlan 覆盖进目录占位，保留进度/讲义/答疑等运行态 */
  setDayDetail: (goalId: string, phaseId: string, dayId: string, detail: DayPlan) => void;
  /** 链接体检/替换完成后异步回写资源（不在生成主链路上阻塞） */
  updateDayResources: (goalId: string, dayId: string, resources: DayPlan["resources"]) => void;
  setDayStatus: (
    goalId: string,
    dayId: string,
    status: "active" | "passed" | "skipped",
    /** 迁移题真门（v17）：passed 时不再立即解锁下一天，留 pendingUnlock；
     *  由 completeTransfer 答题后解锁。进度照常保存，刷新不丢。 */
    opts?: { pendingUnlock?: boolean; transferQuestion?: string }
  ) => void;
  completeTransfer: (goalId: string, dayId: string, answer: string) => void;
  incrementAttempts: (goalId: string, dayId: string) => void;
  /** 定点写回某天知识点的掌握状态：只替换该天 knowledgePoints，不覆盖 plan 里其他并发更新 */
  setDayKnowledgeMastery: (goalId: string, dayId: string, mastery: MasteryStatus) => void;
  /** 定点追加当日答疑消息：只动 day.qa，不覆盖同期写入的 lesson/status 等字段 */
  appendDayQa: (goalId: string, dayId: string, msg: ChatMsg) => void;
  logQuiz: (goalId: string, result: QuizResult) => void;

  addFolder: (name: string) => void;
  removeFolder: (name: string) => void;
  addKnowledge: (
    items: { title: string; body?: string; domain: string; knowledgeType?: KnowledgeType; masteryStatus?: MasteryStatus }[],
    source: KnowledgeSource,
    sourceTitle: string
  ) => void;
  /** 新建空笔记并返回真实 id（标题自动唯一，保证重名不冲突） */
  createKnowledge: (init?: { title?: string; domain?: string }) => string;
  /** Obsidian 批量导入：按标题去重，双链自动解析为 id；返回新增/跳过数 */
  importKnowledge: (
    items: { title: string; body: string; domain: string; sourceTitle: string; linkTitles: string[]; tags?: string[] }[]
  ) => { added: number; skipped: number };
  rebuildLinks: () => { touched: number; placeholders: number };
  updateKnowledge: (id: string, patch: Partial<KnowledgeItem>) => void;
  /** 手动把一篇笔记加入/移出复习队列（导入与手写笔记默认不进） */
  enableReview: (id: string, enabled: boolean) => void;
  removeKnowledge: (id: string) => void;
  recordReview: (id: string, ok: boolean) => void;
  linkNotes: (fromId: string, toId: string) => void;

  addBook: (b: Book) => void;
  updateBook: (id: string, patch: Partial<Book>) => void;
  /** 定点更新单个章节：避免用渲染闭包里的整本 chapters 回写，冲掉其他章节的并发改动 */
  updateBookChapter: (bookId: string, chapterId: string, patch: Partial<BookChapter>) => void;
  removeBook: (id: string) => void;
  addBookMsg: (id: string, msg: ChatMsg) => void;
  addInsight: (bookId: string, text: string) => void;
  toggleChapter: (bookId: string, chapterId: string) => void;
  /* ---- 阅读系统 V1.0（PRD 2026-11-05）---- */
  /** 设定阅读目标：修改目标不清洗任何已有记录（PRD 4.1 验收 4） */
  setBookGoal: (bookId: string, goal: ReadingGoal) => void;
  /** 重生成路线：替换 chapters，但把旧章节的验收结果归档进 book.assessments，
   *  chat/insights/deposits/learning 原样保留（PRD 4.1 验收 4 / 4.3 验收 6） */
  regenerateBookRoute: (bookId: string, plan: { map?: BookMap; planSummary?: string; chapters: BookChapter[]; routeType?: Book["routeType"] }) => void;
  /** 节点状态机：todo/reading/done/skipped（PRD 4.3 验收 4/5）。done 时若来自手动标记则不写 masteredAt */
  setChapterStatus: (bookId: string, chapterId: string, status: BookChapter["status"]) => void;
  /** 节点顺序调整（上移/下移） */
  moveChapter: (bookId: string, chapterId: string, dir: -1 | 1) => void;
  /** 追加单题验收记录（book 级档案，换路线不丢） */
  addChapterAssessment: (bookId: string, a: ChapterAssessment) => void;
  /** 节点验收通过：写 masteredAt + 学习证据 */
  markChapterMastered: (bookId: string, chapterId: string, evidence?: string) => void;
  /** 沉淀：新增 / 删除（PRD 4.6） */
  addBookDeposit: (bookId: string, d: Omit<BookDeposit, "id" | "at">) => void;
  removeBookDeposit: (bookId: string, depositId: string) => void;
  /** 知识迁移（升级 PRD 2.5）：追加迁移记录；used_correct 同步沉淀 practice + 学习证据。返回记录 id（复检回填用） */
  addBookTransfer: (bookId: string, t: Omit<BookTransfer, "id" | "at">) => string;
  /** v26.1 G3：独立迁移复检结果回填到既有迁移记录 */
  attachTransferRecheck: (bookId: string, transferId: string, recheck: NonNullable<BookTransfer["recheck"]>) => void;
  /** 学习状态增量更新（knownConcepts 去重合并 / misconceptions 追加等，PRD 5.3） */
  updateBookLearning: (bookId: string, patch: Partial<Omit<BookLearning, "misconceptions" | "evidence">> & {
    addMisconception?: { concept: string; note: string };
    /** 澄清误解（升级 PRD 2.4）：同名概念标记 clarified（重考通过时调用） */
    clarifyMisconception?: string;
    addEvidence?: { chapterId?: string; text: string };
  }) => void;
  /** 整本书阅读状态机：unread→reading→finished→assessing→mastered（PRD 4.5） */
  setBookReadStatus: (bookId: string, status: BookReadStatus) => void;

  addSession: (s: CouncilSession) => void;
  updateSession: (id: string, patch: Partial<CouncilSession>) => void;
  removeSession: (id: string) => void;
  addSessionMsg: (id: string, msg: ChatMsg) => void;
  /** sessionId 显式指定写入目标会话（缺省=当前激活会话）——生成中途切会话时，回答仍落回发起会话 */
  appendAgentMsg: (msg: ChatMsg, sessionId?: string) => string;
  clearAgentChat: () => void;
  /** v23.2 多会话：新建（返回新 id 并激活）、切换、删除；appendAgentMsg 写入当前激活会话 */
  newAgentSession: () => string;
  setAgentActive: (id: string | null) => void;
  removeAgentSession: (id: string) => void;

  addCustomPersona: (p: CustomPersona) => void;
  removeCustomPersona: (id: string) => void;

  setSettings: (patch: Partial<Settings>) => void;
  /** 导入备份/云端快照。入参校验失败返回 false，且不写入任何状态。 */
  importData: (data: unknown) => boolean;
  resetAll: () => void;
  seedSampleGoal: () => string;
}

/** 通过某天后解锁同阶段下一天 / 下一阶段首天。
 *  返回值：本次推进是否把整个目标走完了（true = 最后一个阶段最后一天）。
 *  **不要**在这里直接写 goal.status：调用方传进来的是 `{ ...g, plan }` 临时包装对象，
 *  赋值落在拷贝上、真实 goal 永远停在 active —— 旧的 web 实现踩过这个坑
 *  （同 miniprogram/utils/store.js 里那条注释记载的是同一个 bug）。 */
function unlockNext(goal: Goal, dayId: string): boolean {
  if (!goal.plan) return false;
  const day = goal.plan.days[dayId];
  if (!day) return false;
  const phase = goal.plan.phases.find((p) => p.id === day.phaseId);
  if (!phase) return false;

  const idx = phase.dayIds.indexOf(dayId);
  if (idx >= 0 && idx < phase.dayIds.length - 1) {
    const next = goal.plan.days[phase.dayIds[idx + 1]];
    if (next && next.status === "locked") next.status = "active";
    return false;
  }
  phase.status = "passed";
  const pIdx = goal.plan.phases.findIndex((p) => p.id === phase.id);
  const nextPhase = goal.plan.phases[pIdx + 1];
  if (nextPhase && nextPhase.status === "locked") {
    nextPhase.status = "active";
    const first = goal.plan.days[nextPhase.dayIds[0]];
    if (first && first.status === "locked") first.status = "active";
    return false;
  }
  // 没有下一阶段了 → 整个目标走完（由调用点落 status）
  return !nextPhase;
}

/** 旧版知识条目（v1：{text}）→ v2 双链笔记 */
function migrateKnowledge(items: unknown[]): KnowledgeItem[] {
  return (items as Record<string, unknown>[]).map((k) => ({
    ...k,
    title: (k.title as string) ?? (k.text as string) ?? "未命名笔记",
    body: (k.body as string) ?? "",
    links: (k.links as string[]) ?? [],
  })) as KnowledgeItem[];
}

/* 配额安全的本地存储：localStorage 只是"缓存"，云端自动同步才是耐久存储。
 * 大知识库（如整库导入的数百篇笔记）可能撑爆 ~5MB 配额；此前 setItem 抛
 * QuotaExceededError 且未被捕获 → 整页崩溃（"This page couldn't load"）。
 * 现在写满时优雅跳过本次快照并通知 UI，绝不崩溃、绝不丢内存数据。 */

/* 磁盘是否已落后于内存（最近一次持久化失败）。跨标签页回采据此跳过，
 * 否则配额满时磁盘的旧快照会把刚生成的今日讲义覆盖掉。 */
let diskStale = false;
export function isStoreDiskStale() {
  return diskStale;
}

/* 最近一次成功写盘（或回采）的快照原文。本地每次 set 都会同步触发 persist 写盘，
 * 所以「磁盘原文 === 我们最后写的内容」即内存与磁盘一致——bindStoreSync 据此
 * 跳过整仓 JSON.stringify 全等比较，只有别的标签页真正写过盘才值得比对。 */
let lastDiskRaw: string | null = null;

const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
      diskStale = false;
      lastDiskRaw = value;
    } catch (e) {
      const quota =
        e instanceof DOMException &&
        (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
      // 非配额失败（私密模式禁写等）同样只放弃本次快照：内存已应用，重抛会以未捕获
      // 异常穿透 UI 动作链（persist 写路径无兜底）。磁盘落后于内存，统一走告警通道。
      diskStale = true;
      if (typeof window !== "undefined") {
        if (quota) {
          window.dispatchEvent(new CustomEvent("mentora:quota"));
        } else {
          window.dispatchEvent(
            new CustomEvent("mentora:store-warning", {
              detail: "本地存储写入失败，本次改动只保存在内存里，请尽快到设置页导出备份。",
            })
          );
        }
      }
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {
      /* 忽略 */
    }
  },
};

/* ========= 科目 MOC(目录)自动维护 =========
 * 借鉴 Obsidian/wiki 的 Map-of-Content 管理方式:每个科目(顶层文件夹)自动有一张
 * 「科目 · 目录」笔记,用 [[wikilink]] 索引该科目下所有笔记,形成 hub 关联链,
 * 笔记不再散落。MOC 不设 nextReviewAt,故不进间隔复习队列。 */
const mocTitle = (subject: string) => `${subject} · 目录`;

function withMoc(knowledge: KnowledgeItem[], subject: string): KnowledgeItem[] {
  if (!subject) return knowledge;
  const title = mocTitle(subject);
  const members = knowledge.filter((k) => (k.domain || "").split("/")[0] === subject && k.title !== title);
  const body =
    `# ${subject} · 目录\n\n> 自动维护的索引（MOC）：本科目下所有笔记都挂在这里,点链接跳转,新笔记自动加入。\n\n` +
    members.map((m) => `- [[${m.title}]]`).join("\n");
  const existing = knowledge.find((k) => k.title === title);
  if (existing) {
    if (existing.body === body) return knowledge;
    return knowledge.map((k) =>
      k.id === existing.id ? { ...k, body, updatedAt: new Date().toISOString() } : k
    );
  }
  const moc: KnowledgeItem = {
    id: uid("k"),
    title,
    body,
    domain: subject,
    source: "manual",
    sourceTitle: "自动目录",
    masteredAt: todayISO(),
    reviewStage: 0,
    links: [],
    tags: ["MOC"],
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  return [moc, ...knowledge];
}

/* 从正文里的 [[双链]] 反解析出 links(仅匹配已存在标题,不建占位)。
 * 让图谱/反链立即反映双链结构——否则正文写了 [[..]] 但 links 字段为空,图谱显示"连接 0"。 */
function linkifyNote(
  k: KnowledgeItem,
  byTitle: Map<string, string>,
  norm: (t: string) => string
): KnowledgeItem {
  const found: string[] = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(k.body || ""))) {
    const id = byTitle.get(norm(m[1]));
    if (id && id !== k.id) found.push(id);
  }
  if (!found.length) return k;
  const merged = [...new Set([...(k.links ?? []), ...found])];
  if (merged.length === (k.links?.length ?? 0)) return k;
  return { ...k, links: merged };
}

function buildTitleIndex(knowledge: KnowledgeItem[]) {
  const norm = (t: string) => t.trim().toLowerCase();
  const byTitle = new Map<string, string>();
  for (const k of knowledge) if (!k.unresolved) byTitle.set(norm(k.title), k.id);
  return { norm, byTitle };
}

function linkifyBodies(knowledge: KnowledgeItem[]): KnowledgeItem[] {
  const { norm, byTitle } = buildTitleIndex(knowledge);
  return knowledge.map((k) => linkifyNote(k, byTitle, norm));
}

/* 单篇版：正文逐键编辑时只重解析当前笔记，避免全库正则扫描造成打字卡顿 */
function linkifyOne(knowledge: KnowledgeItem[], id: string): KnowledgeItem[] {
  const target = knowledge.find((k) => k.id === id);
  if (!target) return knowledge;
  const { norm, byTitle } = buildTitleIndex(knowledge);
  const patched = linkifyNote(target, byTitle, norm);
  if (patched === target) return knowledge;
  return knowledge.map((k) => (k.id === id ? patched : k));
}

/* ========= 单一累积式迁移（persist.migrate 与 setStoreUser 手动装载共用） =========
 * 旧实现两处手工复制且各自漂移：persist.migrate 因 skipHydration 且无 rehydrate 实际不可达，
 * 手动链是 else-if 逐版判断——v1/v2 仓跳过 v4「Day N：」前缀清洗、漏 v8 书籍迁移。
 * 收敛成一个函数后按版本号顺序逐级执行，两条加载路径永远一致。 */
function migrateState(
  state: Partial<AppState> & { knowledge?: unknown[] },
  version: number
): Partial<AppState> {
  let s = state;
  // v2:旧版 {text} 知识条目 → 双链笔记结构
  if (version < 2) s = { ...s, knowledge: migrateKnowledge(s.knowledge ?? []) };
  // v3:把已有笔记正文里的 [[双链]] 一次性解析进 links,旧图谱立即有连线
  if (version < 3) s = { ...s, knowledge: linkifyBodies((s.knowledge ?? []) as KnowledgeItem[]) };
  // v4:清洗历史脏正文——"Day N：Day N：" 重复前缀(早期生成 bug 的残留),一次性自愈
  if (version < 4) {
    const fixed = ((s.knowledge ?? []) as KnowledgeItem[]).map((k) =>
      k.body && /Day\s*\d+[：:]\s*Day\s*\d+[：:]/.test(k.body)
        ? { ...k, body: k.body.replace(/(Day\s*\d+[：:])\s*Day\s*\d+[：:]\s*/g, "$1 ") }
        : k
    );
    s = { ...s, knowledge: linkifyBodies(fixed) };
  }
  // v5:修复分批生成时代产生的重复/乱序天标题——每个阶段按 dayIds 顺序重编 "Day N：",
  // 重复的天（旧 bug 生成的 Day1,Day2,Day1,Day2…）保留内容、顺序归位。
  if (version < 5) {
    const goals = ((s.goals ?? []) as Goal[]).map((g) => {
      if (!g?.plan) return g;
      const plan = structuredClone(g.plan);
      for (const ph of plan.phases) {
        ph.dayIds.forEach((id, i) => {
          const d = plan.days[id];
          if (!d) return;
          const rest = d.title.replace(/^Day\s*\d+[：:]\s*/, "");
          d.title = `Day ${i + 1}：${rest}`;
        });
      }
      return { ...g, plan };
    });
    s = { ...s, goals };
  }
  // v6:首页智能体对话（新增字段，旧仓补空数组）
  if (version < 6) s = { ...s, agentChat: s.agentChat ?? [] };
  // v7:主对话框多会话——把旧的单数组 agentChat 包装成一个历史会话，保留全部内容
  if (version < 7 && !s.agentSessions?.length) {
    const legacy = (s.agentChat ?? []) as ChatMsg[];
    const firstUser = legacy.find((m) => m.role === "user")?.content ?? "";
    const wrapped: AgentSession[] =
      legacy.length > 0
        ? [
            {
              id: uid("as"),
              title: firstUser.slice(0, 24) || "历史对话",
              messages: legacy,
              createdAt: legacy[0]?.at ?? new Date().toISOString(),
              updatedAt: legacy[legacy.length - 1]?.at ?? new Date().toISOString(),
            },
          ]
        : [];
    s = { ...s, agentSessions: wrapped, agentActiveId: wrapped[0]?.id ?? null, agentChat: [] };
  }
  // v8:阅读系统 V1.0——旧书补阅读系统字段（status→readStatus 推导；旧章节 status 只有 todo/done 保持原值）
  if (version < 8) {
    const books = ((s.books ?? []) as Book[]).map((b) => ({
      ...b,
      readStatus:
        b.readStatus ??
        (b.status === "done" ? "finished" : b.status === "reading" ? "reading" : "unread"),
      assessments: b.assessments ?? [],
      deposits: b.deposits ?? [],
    }));
    s = { ...s, books };
  }
  return s;
}

/* ========= 导入校验（备份文件 / 云端快照共用） =========
 * 旧实现只做 JSON.parse 就整体合并：`{"goals":"x"}` 之类坏数据会直接进 store 并落盘，
 * 刷新后 goals.map / PROVIDERS[provider] 抛 TypeError，全应用崩死且应用内无自救入口。
 * 这里做结构校验：字段类型不对就整份拒绝（文件导入据此提示），单个脏元素则过滤掉。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** undefined = 未提供；null = 提供了但类型不对（调用方应拒绝整份数据） */
function optionalRecords(v: unknown): Record<string, unknown>[] | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return null;
  return v.filter(isRecord);
}

/** 校验后的导入载荷：settings 允许只带部分字段（与现有设置合并） */
type SanitizedBackup = Omit<Partial<AppState>, "settings"> & { settings?: Partial<Settings> };

function sanitizeBackup(raw: unknown): SanitizedBackup | null {
  if (!isRecord(raw)) return null;
  const out: SanitizedBackup = {};

  const goals = optionalRecords(raw.goals);
  if (goals === null) return null;
  if (goals) {
    out.goals = goals.map((g) => ({
      ...g,
      id: typeof g.id === "string" ? g.id : uid("g"),
      topic: typeof g.topic === "string" ? g.topic : "",
      quizLog: Array.isArray(g.quizLog) ? g.quizLog : [],
      intakeTranscript: Array.isArray(g.intakeTranscript) ? g.intakeTranscript : [],
      plan: isRecord(g.plan) ? g.plan : undefined,
    })) as unknown as Goal[];
  }

  const knowledge = optionalRecords(raw.knowledge);
  if (knowledge === null) return null;
  if (knowledge) {
    out.knowledge = knowledge.map((k) => ({
      ...k,
      id: typeof k.id === "string" ? k.id : uid("k"),
      title: typeof k.title === "string" ? k.title : "未命名笔记",
      body: typeof k.body === "string" ? k.body : "",
      links: Array.isArray(k.links) ? k.links.filter((x): x is string => typeof x === "string") : [],
    })) as unknown as KnowledgeItem[];
  }

  const books = optionalRecords(raw.books);
  if (books === null) return null;
  if (books) {
    out.books = books.map((b) => ({
      ...b,
      id: typeof b.id === "string" ? b.id : uid("b"),
      chapters: Array.isArray(b.chapters) ? b.chapters : [],
      insights: Array.isArray(b.insights) ? b.insights : [],
      chat: Array.isArray(b.chat) ? b.chat : [],
    })) as unknown as Book[];
  }

  const sessions = optionalRecords(raw.sessions);
  if (sessions === null) return null;
  if (sessions) {
    out.sessions = sessions.map((s) => ({
      ...s,
      id: typeof s.id === "string" ? s.id : uid("s"),
      messages: Array.isArray(s.messages) ? s.messages : [],
    })) as unknown as CouncilSession[];
  }

  const personas = optionalRecords(raw.customPersonas);
  if (personas === null) return null;
  if (personas) out.customPersonas = personas as unknown as CustomPersona[];

  /* v27：主对话多会话入云（与 /api/sync FIELDS 同步扩）。
   * 单条形状只做最宽容校验（id/messages），逐条深校验交给各消费端的既有兜底。 */
  const agentSessions = optionalRecords(raw.agentSessions);
  if (agentSessions === null) return null;
  if (agentSessions) {
    out.agentSessions = agentSessions.map((s) => ({
      ...s,
      id: typeof s.id === "string" ? s.id : uid("as"),
      messages: Array.isArray(s.messages) ? s.messages : [],
    })) as unknown as AgentSession[];
  }

  if (raw.folders !== undefined && raw.folders !== null) {
    if (!Array.isArray(raw.folders)) return null;
    out.folders = raw.folders.filter((f): f is string => typeof f === "string");
  }

  if (raw.settings !== undefined && raw.settings !== null) {
    if (!isRecord(raw.settings)) return null;
    const settings = { ...raw.settings } as Partial<Settings>;
    // 非法 provider 会让 ModelSection 的 PROVIDERS[provider].modelHints 直接 TypeError
    if (settings.provider !== undefined && !Object.hasOwn(PROVIDERS, settings.provider)) {
      delete settings.provider;
    }
    if (settings.apiKey !== undefined && typeof settings.apiKey !== "string") {
      delete settings.apiKey;
    }
    out.settings = settings;
  }

  return out;
}

/* ========= 掌握状态推进（v17 拆至纯模块 mastery.ts，可单测） =========
 * store 内部与外部调用点都从这里拿：行为与原 store 内联版一致，新增复习接线与 apply 迁移证据。
 * masteryFromQuiz 仍被 learn 页经 store 引入；advanceMastery/maxStatus 无消费者，已撤重导出。 */
export { masteryFromQuiz, masteryFromReview } from "./mastery";
import { masteryFromReview } from "./mastery";

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      agentChat: [],
      agentSessions: [],
      agentActiveId: null,
      goals: [],
      knowledge: [],
      books: [],
      sessions: [],
      customPersonas: [],
      folders: [],
      settings: DEFAULT_SETTINGS,
      _storeUserId: null as string | null,

      addGoal: (g) => set((s) => ({ goals: [g, ...s.goals] })),
      updateGoal: (id, patch) =>
        set((s) => ({
          goals: s.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        })),
      removeGoal: (id) =>
        set((s) => ({ goals: s.goals.filter((g) => g.id !== id) })),
      removeGoalAndNotes: (id, includeKnowledge = false) =>
        set((s) => {
          const goal = s.goals.find((g) => g.id === id);
          const goals = s.goals.filter((g) => g.id !== id);
          if (!goal) return { goals };
          const t = goal.topic;
          // 默认只删"计划类"(总纲要/阶段计划/目录);知识点(含复习队列)是学习成果,需显式勾选才删
          const isPlan = (k: KnowledgeItem) =>
            (k.domain || "") === `${t}/计划` ||
            k.title.startsWith(`${t} 学习计划`) ||
            k.title === `${t} · 目录`;
          const isKnow = (k: KnowledgeItem) => (k.domain || "") === `${t}/笔记`;
          const knowledge = s.knowledge.filter(
            (k) => !(isPlan(k) || (includeKnowledge && isKnow(k)))
          );
          return { goals, knowledge };
        }),
      setPlan: (goalId, plan) =>
        set((s) => ({
          goals: s.goals.map((g) => (g.id === goalId ? { ...g, plan } : g)),
        })),
      setPhaseCatalog: (goalId, phaseId, boundary, catalog) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const phase = plan.phases.find((ph) => ph.id === phaseId);
            if (!phase || catalog.length === 0) return g;
            phase.catalog = catalog.map((c) => ({ id: c.id, title: c.title, knowledgePoints: c.knowledgePoints }));
            for (const c of catalog) {
              const old = plan.days[c.id];
              const kps = c.knowledgePoints.map((text) => ({ id: uid("kp"), text }));
              if (!old) {
                // 目录占位：只有标题与清单级知识点，学到那天再展开详情
                plan.days[c.id] = {
                  id: c.id,
                  phaseId,
                  title: c.title,
                  stub: true,
                  knowledgePoints: kps,
                  resources: [],
                  method: "",
                  acceptance: [],
                  status: "locked",
                  attempts: 0,
                };
              } else if (old.stub) {
                // 已展开的天只做目录索引，不覆盖标题/详情（避免老数据标题与正文错位）
                old.title = c.title;
                old.knowledgePoints = kps;
              }
            }
            phase.dayIds = catalog.map((c) => c.id);
            phase.boundary = boundary;
            phase.planned = catalog.every((c) => plan.days[c.id] && !plan.days[c.id].stub);
            if (phase.status === "locked") phase.status = "active";
            const first = plan.days[phase.dayIds[0]];
            if (first && first.status === "locked") first.status = "active";
            return { ...g, plan };
          }),
        })),
      /* V26.2-H5：重排前快照旧阶段目录（深拷贝，只增不删，最多 5 条——旧数据绝不删除） */
      snapshotPhase: (goalId, phaseId, reason) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const phase = g.plan.phases.find((ph) => ph.id === phaseId);
            if (!phase) return g;
            const entry: PlanHistoryEntry = {
              at: new Date().toISOString(),
              reason: reason || "阶段重排",
              phaseId,
              phaseTitle: phase.title,
              boundary: phase.boundary || "",
              dayIds: [...phase.dayIds],
              days: phase.dayIds
                .map((id) => g.plan!.days[id])
                .filter((d): d is DayPlan => !!d)
                .map((d) => structuredClone(d)),
            };
            return { ...g, planHistory: [...(g.planHistory ?? []), entry].slice(-5) };
          }),
        })),
      setDayDetail: (goalId, phaseId, dayId, detail) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const phase = plan.phases.find((ph) => ph.id === phaseId);
            const old = plan.days[dayId];
            if (!phase || !old) return g;
            plan.days[dayId] = {
              ...detail,
              id: dayId,
              phaseId,
              stub: false,
              title: phase.catalog?.find((c) => c.id === dayId)?.title ?? detail.title,
              // 进度与学习痕迹属于运行态，回填细节时原样保留
              status: old.status,
              completedAt: old.completedAt,
              attempts: old.attempts,
              lesson: old.lesson,
              qa: old.qa,
              pendingUnlock: old.pendingUnlock,
              transferQuestion: old.transferQuestion,
              transferAnswer: old.transferAnswer,
            };
            phase.planned = phase.catalog?.length
              ? phase.catalog.every((c) => plan.days[c.id] && !plan.days[c.id].stub)
              : phase.dayIds.every((id) => plan.days[id] && !plan.days[id].stub);
            return { ...g, plan };
          }),
        })),
      updateDayResources: (goalId, dayId, resources) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan || !g.plan.days[dayId]) return g;
            const plan = structuredClone(g.plan);
            plan.days[dayId].resources = resources;
            return { ...g, plan };
          }),
        })),
      setDayStatus: (goalId, dayId, status, opts) => {
        if (status === "passed") {
          /* 漏斗埋点：验收通过（含迁移门挂起）。在 set 外读旧状态，避免 StrictMode 重复发送 */
          const g0 = get().goals.find((x) => x.id === goalId);
          const d0 = g0?.plan?.days[dayId];
          const ph0 = g0?.plan?.phases.find((p) => p.id === d0?.phaseId);
          if (d0)
            track("day_pass", {
              dayNumber: ph0 ? ph0.dayIds.indexOf(dayId) + 1 : 0,
              attempts: d0.attempts,
              gated: Boolean(opts?.pendingUnlock),
            });
        }
        return set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const day = plan.days[dayId];
            if (!day) return g;
            day.status = status;
            day.completedAt = status === "active" ? undefined : todayISO();
            const gate = status === "passed" && opts?.pendingUnlock;
            if (gate) {
              // 真门：进度记录照常，解锁等迁移题
              day.pendingUnlock = true;
              day.transferQuestion = opts?.transferQuestion ?? "";
            } else if (status === "passed") {
              delete day.pendingUnlock;
            }
            let finished = false;
            if ((status === "passed" && !gate) || status === "skipped")
              finished = unlockNext({ ...g, plan }, dayId);
            /* 结业标记两条路径都要覆盖：正常过门（completeTransfer）与强制跳过（这里）。
             * status 必须由这里落库——unlockNext 拿的是临时包装对象，写不回来。 */
            if (finished) {
              return {
                ...g,
                plan,
                status: "done" as const,
                ...(g.graduatedAt || g.needsGraduation ? {} : { needsGraduation: true }),
              };
            }
            return { ...g, plan };
          }),
        }));
      },
      completeTransfer: (goalId, dayId, answer) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const day = plan.days[dayId];
            if (!day || day.status !== "passed") return g;
            day.pendingUnlock = false;
            day.transferAnswer = answer;
            const finished = unlockNext({ ...g, plan }, dayId);
            /* 结业回路（v21）：最后一个阶段过门后 goal.status 变 done。
             * 在这里标记 needsGraduation，由 UI 一次性生成结业笔记+下一步建议——
             * 不在 store 里同步调模型（store 必须保持纯状态）。 */
            if (finished) {
              return {
                ...g,
                plan,
                status: "done" as const,
                ...(g.graduatedAt ? {} : { needsGraduation: true }),
              };
            }
            return { ...g, plan };
          }),
        })),
      incrementAttempts: (goalId, dayId) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const day = plan.days[dayId];
            if (day) day.attempts += 1;
            return { ...g, plan };
          }),
        })),
      setDayKnowledgeMastery: (goalId, dayId, mastery) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const day = g.plan.days[dayId];
            if (!day) return g;
            const knowledgePoints = day.knowledgePoints.map((k) => ({
              ...k,
              masteryStatus: mastery,
              historicalHighest:
                !k.historicalHighest ||
                MASTERY_ORDER.indexOf(mastery) > MASTERY_ORDER.indexOf(k.historicalHighest)
                  ? mastery
                  : k.historicalHighest,
            }));
            /* 定点 patch：只替换这一天的知识点，其余字段沿用 store 最新状态。
             * 旧实现用渲染闭包里的 plan 整体回写，会把并发写入的 passed/pendingUnlock/attempts 冲掉。 */
            return {
              ...g,
              plan: { ...g.plan, days: { ...g.plan.days, [dayId]: { ...day, knowledgePoints } } },
            };
          }),
        })),
      appendDayQa: (goalId, dayId, msg) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const day = g.plan.days[dayId];
            if (!day) return g;
            return {
              ...g,
              plan: {
                ...g.plan,
                days: { ...g.plan.days, [dayId]: { ...day, qa: [...(day.qa ?? []), msg] } },
              },
            };
          }),
        })),
      logQuiz: (goalId, result) =>
        set((s) => ({
          goals: s.goals.map((g) =>
            g.id === goalId
              ? { ...g, quizLog: [trimQuizResult(result), ...g.quizLog].slice(0, QUIZ_LOG_MAX) }
              : g
          ),
        })),

      addFolder: (name) =>
        set((s) => (s.folders.includes(name) ? s : { folders: [...s.folders, name] })),
      // 连带删掉 name/ 前缀的子文件夹，否则删除父夹后 "A/B" 残留、树重建时复活出空夹
      removeFolder: (name) =>
        set((s) => ({
          folders: s.folders.filter((f) => f !== name && !f.startsWith(`${name}/`)),
        })),

      addKnowledge: (items, source, sourceTitle) => {
        const existing = new Set(get().knowledge.map((k) => k.title));
        const fresh: KnowledgeItem[] = items
          .filter((i) => i.title && !existing.has(i.title))
          .map((i) => ({
            id: uid("k"),
            title: i.title,
            body: i.body ?? "",
            domain: i.domain,
            source,
            sourceTitle,
            knowledgeType: i.knowledgeType,
            masteryStatus: i.masteryStatus,
            masteredAt: todayISO(),
            reviewStage: 0,
            /* 只有学习/读书产出的知识点自动进复习队列：manual（助手收藏、上传文档、
             * 智能体存笔记）与结业笔记不进——与 review.ts 的 backfillReviewDates 同一口径
             * （那边也只认 learn/read）。旧实现一律写 nextReviewAt，把这些笔记塞进了队列。 */
            ...(source === "learn" || source === "read" ? { nextReviewAt: todayISO() } : {}),
            links: [],
            version: 1,
            updatedAt: new Date().toISOString(),
          }));
        set((s) => {
          let k = [...fresh, ...s.knowledge];
          for (const subj of new Set(fresh.map((f) => (f.domain || "").split("/")[0]))) {
            k = withMoc(k, subj);
          }
          k = linkifyBodies(k);
          return { knowledge: k };
        });
      },


      createKnowledge: (init) => {
        const base = (init?.title ?? "无标题").trim() || "无标题";
        const titles = new Set(get().knowledge.map((k) => k.title));
        let title = base;
        let n = 2;
        while (titles.has(title)) title = `${base} ${n++}`;
        const id = uid("k");
        set((s) => ({
          knowledge: [
            {
              id,
              title,
              body: "",
              domain: init?.domain ?? "笔记",
              source: "manual",
              sourceTitle: "手动记录",
              masteredAt: todayISO(),
              reviewStage: 0,
              links: [],
            },
            ...s.knowledge,
          ],
        }));
        return id;
      },

      importKnowledge: (items) => {
        const norm = (t: string) => t.trim().toLowerCase();
        /* 标题 -> 已有笔记。注意：unresolved 占位**不算重复**——占位必须给后来导入的
         * 真笔记让位（原位升级），否则占位永远灰着、正文永远进不来（v18.1 修复的死代码根因） */
        const existing = new Map<string, KnowledgeItem>();
        for (const k of get().knowledge) existing.set(norm(k.title), k);
        const fresh: KnowledgeItem[] = [];
        const freshLinks: string[][] = [];
        const seen = new Set<string>();
        for (const i of items) {
          const t = norm(i.title);
          const dup = existing.get(t);
          if (!i.title || !t || seen.has(t)) continue;
          if (dup && !dup.unresolved) continue;
          seen.add(t);
          fresh.push({
            /* 收养同标题未解析占位的 id：后续双链解析与入链全部指向这个 id，原位升级不悬空 */
            id: dup && dup.unresolved ? dup.id : uid("k"),
            title: i.title,
            body: i.body,
            domain: i.domain,
            source: "obsidian",
            sourceTitle: i.sourceTitle,
            masteredAt: todayISO(),
            reviewStage: 0,
            /* Obsidian 参考类笔记不自动进复习队列（938 篇全进会把复习塞爆） */
            nextReviewAt: undefined,
            links: [],
            tags: i.tags && i.tags.length > 0 ? i.tags : undefined,
          });
          freshLinks.push(i.linkTitles ?? []);
        }
        /* 双链解析：标题（大小写不敏感）→ 笔记 id；
           解析不到的目标 = Obsidian「未解析链接」→ 建灰色占位笔记（unresolved），
           关系链绝不丢弃；之后真笔记导入时原位合并（见下方 upgrade 逻辑） */
        const placeholders: KnowledgeItem[] = [];
        const placeholderIds = new Map<string, string>(); // norm(title) -> id
        const byTitle = new Map<string, string>();
        for (const k of get().knowledge) byTitle.set(norm(k.title), k.id);
        for (const k of fresh) byTitle.set(norm(k.title), k.id);
        /* 历史遗留占位（此前导入建的）：真笔记来了要原位升级它们 */
        const existingPlaceholders = new Map<string, string>();
        for (const k of get().knowledge) if (k.unresolved) existingPlaceholders.set(norm(k.title), k.id);
        const resolveOrPlaceholder = (lt: string): string | null => {
          const t = norm(lt);
          if (!t) return null;
          const hit = byTitle.get(t);
          if (hit) return hit;
          let pid = placeholderIds.get(t);
          if (!pid) {
            pid = uid("k");
            placeholderIds.set(t, pid);
            byTitle.set(t, pid);
            placeholders.push({
              id: pid,
              title: lt.trim(),
              body: "",
              domain: "未解析链接",
              source: "obsidian",
              sourceTitle: "",
              masteredAt: todayISO(),
              reviewStage: 0,
              nextReviewAt: undefined,
              links: [],
              unresolved: true,
            });
          }
          return pid;
        };
        fresh.forEach((f, i) => {
          const ids = new Set<string>();
          for (const lt of freshLinks[i]) {
            const id = resolveOrPlaceholder(lt);
            if (id && id !== f.id) ids.add(id);
          }
          f.links = [...ids];
        });
        /* 真笔记升级占位：同标题 unresolved 占位（本批新建或历史遗留）→ 原位替换
         * （保留占位 id 与入链，指向它的链接天然有效）；被升级的真笔记/占位不再重复入列 */
        if (placeholders.length > 0 || existingPlaceholders.size > 0) {
          let knowledge = get().knowledge;
          const upgradedPh = new Set<string>(); // 占位 id -> 已被真笔记替换
          const upgradedFresh = new Set<string>(); // 真笔记 id -> 已占用占位名额
          for (const f of fresh) {
            const t = norm(f.title);
            const pid = placeholderIds.get(t) ?? existingPlaceholders.get(t);
            if (!pid) continue;
            const ph = knowledge.find((k) => k.id === pid);
            if (!ph?.unresolved) continue;
            upgradedPh.add(pid);
            upgradedFresh.add(f.id);
            knowledge = knowledge.map((k) =>
              k.id === pid
                ? { ...f, id: k.id, links: [...new Set([...f.links, ...k.links])] }
                : k
            );
          }
          if (upgradedPh.size > 0) {
            /* 占位 id 原位保留 → 所有指向它的链接天然有效，无需清理；
             * 以升级后的整库数组为基底（占位已被原位替换），再接上剩余新占位/新笔记 */
            const keptFresh = fresh.filter((f) => !upgradedFresh.has(f.id));
            const newPlaceholders = placeholders.filter((p) => !upgradedPh.has(p.id));
            set(() => ({ knowledge: [...newPlaceholders, ...keptFresh, ...knowledge] }));
            const added = keptFresh.length + upgradedPh.size;
            return { added, skipped: items.length - added };
          }
        }
        set((s) => ({ knowledge: [...placeholders, ...fresh, ...s.knowledge] }));
        return { added: fresh.length, skipped: items.length - fresh.length };
      },

      /** 重建全库关系链：扫描每篇正文的 [[标题]]，补齐导入时丢失的链接；
          保留现有人工/AI 建立的链接，解析不到的目标建「未解析链接」占位 */
      rebuildLinks: () => {
        const norm = (t: string) => t.trim().toLowerCase();
        const re = /!?\\?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
        const knowledge = get().knowledge;
        const byTitle = new Map<string, string>();
        for (const k of knowledge) if (!k.unresolved) byTitle.set(norm(k.title), k.id);
        const placeholders: KnowledgeItem[] = [];
        const phIds = new Map<string, string>();
        const resolve = (lt: string, selfId: string): string | null => {
          const t = norm(lt);
          if (!t) return null;
          const hit = byTitle.get(t);
          if (hit && hit !== selfId) return hit;
          if (hit === selfId) return null;
          let pid = phIds.get(t);
          if (!pid) {
            const existed = knowledge.find((k) => k.unresolved && norm(k.title) === t);
            if (existed) {
              pid = existed.id;
            } else {
              pid = uid("k");
              placeholders.push({
                id: pid,
                title: lt.trim(),
                body: "",
                domain: "未解析链接",
                source: "obsidian",
                sourceTitle: "",
                masteredAt: todayISO(),
                reviewStage: 0,
                nextReviewAt: undefined,
                links: [],
                unresolved: true,
              });
            }
            phIds.set(t, pid);
            byTitle.set(t, pid);
          }
          return pid !== selfId ? pid : null;
        };
        let rebuilt = 0;
        // id→有效性集合：旧版对每条 link 都全库线性扫描（O(N²·L)），降为 O(1) 查表
        const validIds = new Set(knowledge.filter((k) => !k.unresolved).map((k) => k.id));
        const next = knowledge.map((k) => {
          const oldValid = new Set(k.links.filter((l) => validIds.has(l)));
          const ids = new Set<string>(oldValid);
          if (!k.unresolved) {
            let m: RegExpExecArray | null;
            re.lastIndex = 0;
            while ((m = re.exec(k.body))) {
              const id = resolve(m[1].trim(), k.id);
              if (id) ids.add(id);
            }
          }
          if (ids.size !== k.links.length || [...ids].sort().join() !== [...k.links].sort().join()) {
            rebuilt += 1;
            return { ...k, links: [...ids] };
          }
          return k;
        });
        set(() => ({ knowledge: [...placeholders, ...next] }));
        return { touched: rebuilt, placeholders: placeholders.length };
      },
      updateKnowledge: (id, patch) =>
        set((s) => {
          const old = s.knowledge.find((k) => k.id === id);
          let knowledge = s.knowledge.map((k) => {
            if (k.id !== id) return k;
            // 只有内容性修订（标题/正文）才递增版本；复习状态等元数据更新不算改版
            const contentEdit = patch.title !== undefined || patch.body !== undefined;
            return {
              ...k,
              ...patch,
              ...(contentEdit
                ? { version: (k.version ?? 1) + 1, updatedAt: new Date().toISOString() }
                : {}),
            };
          });
          // 拖拽换文件夹时,新旧科目的 MOC 目录都要重算
          if (old && patch.domain !== undefined && patch.domain !== old.domain) {
            knowledge = withMoc(knowledge, (old.domain || "").split("/")[0]);
            knowledge = withMoc(knowledge, (patch.domain || "").split("/")[0]);
          }
          // 正文改了→重解析该篇 [[双链]] 进 links（只扫当前笔记：逐键编辑全库扫描是打字卡顿大头）
          if (patch.body !== undefined) knowledge = linkifyOne(knowledge, id);
          return { knowledge };
        }),
      enableReview: (id, enabled) =>
        set((s) => ({
          knowledge: s.knowledge.map((k) =>
            k.id === id ? { ...k, ...reviewPatch(enabled, todayISO()) } : k
          ),
        })),

      removeKnowledge: (id) =>
        set((s) => {
          const target = s.knowledge.find((k) => k.id === id);
          let k = s.knowledge
            .filter((x) => x.id !== id)
            .map((x) => ({ ...x, links: x.links.filter((l) => l !== id) }));
          if (target) k = withMoc(k, (target.domain || "").split("/")[0]);
          return { knowledge: k };
        }),
      recordReview: (id, ok) => {
        const done = (next: string | undefined, info: Partial<KnowledgeItem>) =>
          set((s) => ({
            knowledge: s.knowledge.map((k) =>
              k.id === id
                ? {
                    ...k,
                    ...info,
                    // lastReviewOk 只写不读，已删（types 里的可选字段留待小程序侧对齐）
                    nextReviewAt: next,
                  }
                : k
            ),
          }));
        const k = get().knowledge.find((x) => x.id === id);
        if (!k) return;
        const card = toFsrsCard(k);
        const result = FSRS.repeat(card, new Date())[ok ? Rating.Good : Rating.Again];
        const c = result.card;
        const fsrsState = {
          st: c.state as number,
          dif: c.difficulty,
          stb: c.stability,
          elapsed: c.elapsed_days,
          scheduled: c.scheduled_days,
          reps: c.reps,
          lapses: c.lapses,
          due: c.due.toISOString(),
          last: c.last_review ? c.last_review.toISOString() : null,
        };
        track("review_done", { ok });
        /* FSRS 新卡/重学的当日到期 → 顺延到明天（我们按天复习，不做分钟级） */
        const dueDate = new Date(c.due);
        const tomorrow = new Date(Date.now() + 86400000);
        const next = c.scheduled_days < 1 ? tomorrow : dueDate;
        done(next.toISOString().slice(0, 10), {
          fsrs: fsrsState,
          reviewStage: stageOf(c.scheduled_days),
          // v17 接线：复习通过会推进掌握状态（此前 recordReview 从不碰 masteryStatus，
          // 六级状态机的 durable 永远不可达——"复习固化记忆"的承诺在状态机里没有落点）
          masteryStatus: masteryFromReview(
            k.masteryStatus,
            ok,
            Math.max(0, c.reps - c.lapses),
            c.stability
          ),
        });
      },
      linkNotes: (fromId, toId) =>
        set((s) => ({
          knowledge: s.knowledge.map((k) => {
            if (k.id === fromId && !k.links.includes(toId))
              return { ...k, links: [...k.links, toId] };
            return k;
          }),
        })),

      addBook: (b) => set((s) => ({ books: [b, ...s.books] })),
      updateBook: (id, patch) =>
        set((s) => ({
          books: s.books.map((b) => (b.id === id ? { ...b, ...patch } : b)),
        })),
      updateBookChapter: (bookId, chapterId, patch) =>
        set((s) => ({
          books: s.books.map((b) =>
            b.id === bookId
              ? {
                  ...b,
                  chapters: b.chapters.map((c) => (c.id === chapterId ? { ...c, ...patch } : c)),
                }
              : b
          ),
        })),
      removeBook: (id) =>
        set((s) => ({ books: s.books.filter((b) => b.id !== id) })),
      addBookMsg: (id, msg) =>
        set((s) => ({
          books: s.books.map((b) =>
            b.id === id ? { ...b, chat: [...b.chat, msg] } : b
          ),
        })),
      addInsight: (bookId, text) =>
        set((s) => ({
          books: s.books.map((b) =>
            b.id === bookId
              ? {
                  ...b,
                  insights: [
                    { id: uid("i"), text, addedAt: todayISO() },
                    ...b.insights,
                  ],
                }
              : b
          ),
        })),
      toggleChapter: (bookId, chapterId) =>
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            return {
              ...b,
              chapters: b.chapters.map((c) =>
                c.id === chapterId
                  ? { ...c, status: c.status === "done" ? "todo" : "done" }
                  : c
              ),
            };
          }),
        })),

      /* ---- 阅读系统 V1.0（PRD 2026-11-05）---- */
      setBookGoal: (bookId, goal) =>
        set((s) => ({
          books: s.books.map((b) => (b.id === bookId ? { ...b, goal } : b)),
        })),
      regenerateBookRoute: (bookId, plan) =>
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            /* 旧章节的验收结果归档进 book.assessments（带章节标题冗余，换路线后仍可回看）；
             * 两代记录都要收：旧 verification（分数制）与新版 masteredAt（证据制）。
             * 对话/洞见/沉淀/学习状态一律不动——目标变化不丢记录（PRD 硬要求）。 */
            const archived = b.chapters.flatMap((c) => {
              const items: ChapterAssessment[] = [];
              if (c.verification) {
                items.push({
                  id: uid("as"),
                  chapterId: c.id,
                  kind: "explain",
                  question: `（旧路线归档）${c.focusQuestion}`,
                  answer: "",
                  level:
                    c.verification.level === "understood"
                      ? "mastered"
                      : c.verification.level === "partial"
                        ? "partial"
                        : "not",
                  evidence: `举例 ${c.verification.scores.example} / 迁移 ${c.verification.scores.transfer} / 贴合 ${c.verification.scores.similarity}`,
                  feedback: c.verification.suggestion,
                  at: c.verification.at,
                });
              } else if (c.masteredAt) {
                items.push({
                  id: uid("as"),
                  chapterId: c.id,
                  kind: "explain",
                  question: `（旧路线归档）${c.focusQuestion}`,
                  answer: "",
                  level: "mastered",
                  evidence: "该节点在新版验收流程下通过（证据见学习档案）",
                  feedback: "换路线前已验收掌握。",
                  at: c.masteredAt,
                });
              }
              return items;
            });
            return {
              ...b,
              map: plan.map ?? b.map,
              planSummary: plan.planSummary ?? b.planSummary,
              routeType: plan.routeType ?? b.routeType,
              chapters: plan.chapters,
              assessments: [...(b.assessments ?? []), ...archived],
            };
          }),
        })),
      setChapterStatus: (bookId, chapterId, status) =>
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            return {
              ...b,
              chapters: b.chapters.map((c) =>
                c.id === chapterId
                  ? {
                      ...c,
                      status,
                      /* 手动标记完成不算掌握：masteredAt 只能来自验收通过（PRD：已读完≠已掌握）。
                       * 回退到 todo/reading/skipped 时清掉 masteredAt，保持两态独立。 */
                      ...(status === "done" ? {} : { masteredAt: undefined }),
                    }
                  : c
              ),
            };
          }),
        })),
      moveChapter: (bookId, chapterId, dir) =>
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            const idx = b.chapters.findIndex((c) => c.id === chapterId);
            const to = idx + dir;
            if (idx < 0 || to < 0 || to >= b.chapters.length) return b;
            const chapters = [...b.chapters];
            [chapters[idx], chapters[to]] = [chapters[to], chapters[idx]];
            return { ...b, chapters };
          }),
        })),
      addChapterAssessment: (bookId, a) =>
        set((s) => ({
          books: s.books.map((b) =>
            b.id === bookId ? { ...b, assessments: [...(b.assessments ?? []), a] } : b
          ),
        })),
      markChapterMastered: (bookId, chapterId, evidence) => {
        /* v26.1 G1：验收通过事件——数据落库成功才算成功，刷新重放天然防重 */
        trackReading("node_assessment_completed", { bookId, chapterId, result: "mastered", source: "assess" });
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            return {
              ...b,
              chapters: b.chapters.map((c) =>
                c.id === chapterId ? { ...c, status: "done" as const, masteredAt: new Date().toISOString() } : c
              ),
              learning: {
                knownConcepts: b.learning?.knownConcepts ?? [],
                misconceptions: b.learning?.misconceptions ?? [],
                unresolvedQuestions: b.learning?.unresolvedQuestions ?? [],
                evidence: [
                  ...(b.learning?.evidence ?? []),
                  ...(evidence
                    ? [{ chapterId, text: evidence, at: new Date().toISOString() }]
                    : []),
                ],
              },
            };
          }),
        }));
      },
      addBookDeposit: (bookId, d) => {
        trackReading("deposit_created", { bookId, type: d.type });
        set((s) => ({
          books: s.books.map((b) =>
            b.id === bookId
              ? {
                  ...b,
                  deposits: [
                    { ...d, id: uid("dp"), at: new Date().toISOString() },
                    ...(b.deposits ?? []),
                  ],
                }
              : b
          ),
        }));
      },
      removeBookDeposit: (bookId, depositId) =>
        set((s) => ({
          books: s.books.map((b) =>
            b.id === bookId
              ? { ...b, deposits: (b.deposits ?? []).filter((d) => d.id !== depositId) }
              : b
          ),
        })),
      addBookTransfer: (bookId, t) => {
        trackReading("transfer_evaluated", { bookId, verdict: t.verdict, mode: t.mode ?? "independent", hintUsed: !!t.hintUsed });
        const transferId = uid("tf");
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            const rec: BookTransfer = { ...t, id: transferId, at: new Date().toISOString() };
            /* 正确应用 = 最有长期价值的实践证据：同步沉淀 practice + 学习证据（升级 PRD 2.5/2.6） */
            const deposit: BookDeposit = {
              id: uid("dp"),
              type: "practice",
              text: `【迁移应用】${t.task} → ${t.answer.slice(0, 200)}`,
              at: rec.at,
            };
            const learning: BookLearning = {
              knownConcepts: b.learning?.knownConcepts ?? [],
              misconceptions: b.learning?.misconceptions ?? [],
              unresolvedQuestions: b.learning?.unresolvedQuestions ?? [],
              evidence: [
                ...(b.learning?.evidence ?? []),
                { chapterId: t.chapterIds[0], text: `迁移应用（${t.verdict}）：${t.evidence.slice(0, 160)}`, at: rec.at },
              ],
            };
            return {
              ...b,
              transfers: [rec, ...(b.transfers ?? [])],
              ...(t.verdict === "used_correct" ? { deposits: [deposit, ...(b.deposits ?? [])] } : {}),
              learning,
            };
          }),
        }));
        return transferId;
      },
      attachTransferRecheck: (bookId, transferId, recheck) => {
        trackReading("transfer_evaluated", { bookId, stage: "recheck", result: recheck.verdict });
        set((s) => ({
          books: s.books.map((b) =>
            b.id === bookId
              ? {
                  ...b,
                  transfers: (b.transfers ?? []).map((t) => (t.id === transferId ? { ...t, recheck } : t)),
                }
              : b
          ),
        }));
      },
      updateBookLearning: (bookId, patch) => {
        if (patch.addMisconception) trackReading("misconception_created", { bookId, concept: patch.addMisconception.concept });
        if (patch.clarifyMisconception) trackReading("misconception_clarified", { bookId, concept: patch.clarifyMisconception });
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            const cur: BookLearning = {
              knownConcepts: b.learning?.knownConcepts ?? [],
              misconceptions: b.learning?.misconceptions ?? [],
              unresolvedQuestions: b.learning?.unresolvedQuestions ?? [],
              evidence: b.learning?.evidence ?? [],
            };
            const next: BookLearning = {
              knownConcepts: patch.knownConcepts
                ? [...new Set([...cur.knownConcepts, ...patch.knownConcepts])]
                : cur.knownConcepts,
              misconceptions: patch.addMisconception
                ? [
                    { ...patch.addMisconception, at: new Date().toISOString() },
                    ...cur.misconceptions.filter((m) => m.concept !== patch.addMisconception!.concept),
                  ].slice(0, 50)
                : patch.clarifyMisconception
                  ? cur.misconceptions.map((m) =>
                      m.concept === patch.clarifyMisconception ? { ...m, clarified: true } : m
                    )
                  : cur.misconceptions,
              unresolvedQuestions: patch.unresolvedQuestions
                ? [...new Set([...cur.unresolvedQuestions, ...patch.unresolvedQuestions])]
                : cur.unresolvedQuestions,
              evidence: patch.addEvidence
                ? [{ ...patch.addEvidence, at: new Date().toISOString() }, ...cur.evidence].slice(0, 200)
                : cur.evidence,
            };
            return { ...b, learning: next };
          }),
        }));
      },
      setBookReadStatus: (bookId, status) =>
        set((s) => ({
          books: s.books.map((b) => {
            if (b.id !== bookId) return b;
            return {
              ...b,
              readStatus: status,
              ...(status === "finished" ? { finishedAt: b.finishedAt ?? new Date().toISOString() } : {}),
              ...(status === "mastered" ? { masteredAt: new Date().toISOString() } : {}),
              ...(status === "reading" ? { status: "reading" as const } : {}),
              ...(status === "mastered" || status === "finished" ? { status: "done" as const } : {}),
            };
          }),
        })),

      addSession: (sess) => set((s) => ({ sessions: [sess, ...s.sessions] })),
      updateSession: (id, patch) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, ...patch } : x
          ),
        })),
      removeSession: (id) =>
        set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),
      addSessionMsg: (id, msg) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, messages: [...x.messages, msg] } : x
          ),
        })),
      appendAgentMsg: (msg, sessionId) => {
        /* v23.2：写入激活会话；v26.1：支持显式 sessionId（生成中途切会话，
         * 回答仍落回发起会话——串台根修）。
         * 隔离纪律：显式 sessionId（后台完成回写）时**不改 agentActiveId**——
         * 用户此刻可能在别的会话里，绝不能把视图拽回发起会话；
         * 仅无 sessionId（用户刚在当前会话发出消息）时才跟随激活。 */
        const explicit = typeof sessionId === "string" && sessionId;
        let resolved = "";
        set((s) => {
          let sessions = s.agentSessions;
          let activeId = explicit || s.agentActiveId || "";
          const valid = sessions.find((x) => x.id === activeId);
          if (!valid) {
            const now = new Date().toISOString();
            const fresh: AgentSession = {
              id: uid("as"),
              title: msg.role === "user" ? msg.content.slice(0, 24) || "新对话" : "新对话",
              messages: [],
              createdAt: now,
              updatedAt: now,
            };
            sessions = [fresh, ...sessions];
            activeId = fresh.id;
          }
          resolved = activeId;
          return {
            agentSessions: sessions.map((x) =>
              x.id === activeId
                ? {
                    ...x,
                    messages: [...x.messages, msg],
                    /* "新对话"占位标题在首条用户消息到达时替换成真实内容 */
                    title:
                      x.title === "新对话" && msg.role === "user"
                        ? msg.content.slice(0, 24) || x.title
                        : x.title,
                    updatedAt: new Date().toISOString(),
                  }
                : x
            ),
            /* 显式回写不拽动用户当前所在会话；无显式（用户刚发出）才跟随 */
            ...(explicit ? {} : { agentActiveId: activeId }),
          };
        });
        return resolved;
      },
      clearAgentChat: () =>
        set((s) => ({
          /* 语义跟随多会话：清空当前激活会话的消息；没有会话时清 legacy 字段 */
          agentSessions: s.agentSessions.map((x) =>
            x.id === s.agentActiveId ? { ...x, messages: [], updatedAt: new Date().toISOString() } : x
          ),
          ...(s.agentActiveId ? {} : { agentChat: [] }),
        })),
      newAgentSession: () => {
        const now = new Date().toISOString();
        const fresh: AgentSession = {
          id: uid("as"),
          title: "新对话",
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ agentSessions: [fresh, ...s.agentSessions], agentActiveId: fresh.id }));
        return fresh.id;
      },
      setAgentActive: (id) => set({ agentActiveId: id }),
      removeAgentSession: (id) =>
        set((s) => {
          const rest = s.agentSessions.filter((x) => x.id !== id);
          return {
            agentSessions: rest,
            agentActiveId: s.agentActiveId === id ? (rest[0]?.id ?? null) : s.agentActiveId,
          };
        }),

      addCustomPersona: (p) =>
        set((s) => ({ customPersonas: [p, ...s.customPersonas] })),
      removeCustomPersona: (id) =>
        set((s) => ({
          customPersonas: s.customPersonas.filter((p) => p.id !== id),
          sessions: s.sessions.filter((x) => x.personaId !== id),
        })),

      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      importData: (data) => {
        const clean = sanitizeBackup(data);
        if (!clean) return false;
        set((s) => {
          const incoming: Partial<Settings> = clean.settings ?? {};
          const settings = { ...s.settings, ...incoming };
          /* 导出的备份恒带 apiKey:""——不能因为恢复/导入把本机已配的 Key 抹掉。 */
          if (!incoming.apiKey) settings.apiKey = s.settings.apiKey;
          return {
            goals: clean.goals ?? s.goals,
            knowledge: backfillReviewDates(clean.knowledge ?? s.knowledge, todayISO()),
            books: clean.books ?? s.books,
            sessions: clean.sessions ?? s.sessions,
            customPersonas: clean.customPersonas ?? s.customPersonas,
            ...(clean.agentSessions ? { agentSessions: clean.agentSessions } : {}),
            ...(clean.folders ? { folders: clean.folders } : {}),
            settings,
          };
        });
        return true;
      },
      seedSampleGoal: () => {
        const id = uid("g");
        const kp = (t: string, kt: KnowledgeType) => ({ id: uid("kp"), text: t, knowledgeType: kt });
        const day = (n: number, title: string, kps: string[], st: NodeStatus): DayPlan => ({
          id: `d${n}`,
          phaseId: "p1",
          title: `Day ${n}：${title}`,
          knowledgePoints: kps.map((t) => kp(t, "concept")),
          resources: [
            { title: "Prompt Engineering Guide（官方）", url: "https://www.promptingguide.ai/zh", why: "系统性框架，当手册用", kind: "doc" as const, year: 2025 },
            { title: "Learn Prompting（免费开源课）", url: "https://learnprompting.org/zh/docs/introduction", why: "小步interactive", kind: "course" as const, year: 2025 },
          ],
          method: "读官方小节→写一个最小 prompt→跑一遍→按验收双轨自测",
          acceptance: [
            { id: uid("a"), kind: "explain" as const, question: "用自己的话说清：什么是 zero-shot / few-shot，差别在哪" },
            { id: uid("a"), kind: "apply" as const, question: "写一个让模型稳定输出 JSON 的 prompt，并贴出你跑通的结果" },
          ],
          status: st,
          attempts: 0,
          lesson: st === "active" ? `## 今日任务与用户背景
体验示例目标：把一个真实小技能走完「学习→产出→验收」闭环。

## ① 直接可学的资料
- [Prompt Engineering Guide 中文版](https://www.promptingguide.ai/zh) —— 先读 Zero-Shot 与 Few-Shot 两节
- [Learn Prompting 入门](https://learnprompting.org/zh/docs/introduction) —— 只看 Basics

## ② 知识点穷尽
- **zero-shot**：不给例子，直接下指令。适合任务边界清晰、模型见过的套路
- **few-shot**：给 2-3 个输入输出示例，让模型模仿格式
- **角色设定**：一句"你是…"能显著稳定输出风格
- **输出约束**：明确"只输出 JSON/不超过 100 字"比事后修剪省一半时间

## ③ 完整可运行示例

\`\`\`text
你是产品文案。
任务：把下面的功能点改写成一条朋友圈文案。
要求：不超过 50 字，带一个具体场景，不要形容词堆砌。
功能点：离线可用，数据存在本机。
\`\`\`
把上面的 prompt 原样粘进任意对话模型跑一遍，再改功能点重跑。

## ④ 验收
完成上方"验收标准"里的两题，提交评分。` : undefined,
        });
        const goal: Goal = {
          id,
          topic: "示例 · Prompt 编写入门",
          direction: "三天走通「学习→产出→验收」闭环（可随时删除）",
          domainKind: "coding",
          motivation: "体验产品流程",
          successCriteria: ["走完 Day1-3 并通过验收"],
          background: "会用聊天 AI，没系统学过提示词",
          weeklyHours: 3,
          status: "active",
          createdAt: new Date().toISOString(),
          quizLog: [],
          intakeTranscript: [],
          plan: {
            startDate: new Date().toISOString().slice(0, 10),
            createdAt: new Date().toISOString(),
            summary: "三天体验闭环：Day1 提示词基础 → Day2 结构化输出 → Day3 小项目验收",
            totalDays: 3,
            weeklyHours: 3,
            phases: [{ id: "p1", title: "阶段1 · 体验闭环", outcome: "能独立写出结构化 prompt 并通过验收", status: "active", dayIds: ["d1", "d2", "d3"], outline: ["基础", "结构化", "小项目"] }],
            days: { d1: day(1, "提示词基础：zero-shot / few-shot / 角色", ["zero-shot 与 few-shot 的区别", "角色设定与输出约束"], "active"), d2: day(2, "结构化输出与常见坑", ["JSON 输出约束", "失败模式与修复"], "locked"), d3: day(3, "小项目：把一个真实需求 prompt 化", ["需求→prompt 的转译"], "locked") },
          },
        };
        set((s) => ({ goals: [goal, ...s.goals] }));
        return id;
      },
      resetAll: () =>
        set({
          agentChat: [],
          agentSessions: [],
          agentActiveId: null,
          goals: [],
          knowledge: [],
          books: [],
          sessions: [],
          customPersonas: [],
          folders: [],
          settings: DEFAULT_SETTINGS,
          _storeUserId: get()._storeUserId,
        }),
    }),
    {
      name: "mentora-store-anon",
      version: 8,
      // 跳过 persist 的自动 rehydrate：水合完全由 setStoreUser() 同步掌控。
      // 否则刷新页面时 persist 会用 anon 仓异步覆盖内存,而此刻 setOptions 已换到用户仓——
      // 空状态随后被写进用户仓,goal 凭空消失(实测:导航后 3s goals 1→0,堆栈指向 persist setState)。
      skipHydration: true,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        agentChat: state.agentChat,
        agentSessions: state.agentSessions,
        agentActiveId: state.agentActiveId,
        goals: state.goals,
        knowledge: state.knowledge,
        books: state.books,
        sessions: state.sessions,
        customPersonas: state.customPersonas,
        folders: state.folders,
        settings: state.settings,
        _storeUserId: state._storeUserId,
      }),
      /* 与 setStoreUser 手动装载共用同一个累积式迁移（此前两份手工复制已经漂移，
       * 改这里修不到真实加载路径——收敛到 migrateState 后只有一份真相） */
      migrate: (persisted: unknown, version: number) =>
        migrateState(persisted as Partial<AppState> & { knowledge?: unknown[] }, version) as AppState,
    }
  )
);

const LEGACY_STORE_KEY = "mentora-store-v1";

/** 切换用户时更换 persist key，防止同一浏览器多账号数据串仓 */
export function setStoreUser(userId: string | null) {
  const key = userId ? `mentora-store-${userId}` : "mentora-store-anon";

  // 一次性迁移：旧固定 key -> 当前登录用户的专属 key（只迁一次，防止老用户丢数据）
  if (userId && typeof window !== "undefined") {
    try {
      const oldRaw = localStorage.getItem(LEGACY_STORE_KEY);
      const newRaw = localStorage.getItem(key);
      if (oldRaw && !newRaw) {
        localStorage.setItem(key, oldRaw);
        localStorage.removeItem(LEGACY_STORE_KEY);
      }
    } catch {
      /* 私密模式/配额满：旧数据没搬过来，而紧随其后的 setState 会往新 key 写一份
       * 小快照，让下次登录的 `!newRaw` 守卫失效、迁移永久关闭（UI 变成全新手空态）。
       * 旧 key 还留着，但必须让用户知道并先导出备份。 */
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("mentora:store-warning", {
            detail: "旧版数据没能搬进当前账号（本地存储可能已满）。请先到设置页「导出备份」，清出空间后重新登录。",
          })
        );
      }
    }
  }

  useAppStore.persist.setOptions({ name: key });

  // 同步加载目标仓（替代 persist.rehydrate 的异步加载）：
  // rehydrate 是异步的，期间任何 clearLocalStore/写入都会把空状态写进刚切换的仓，
  // 曾导致用户本地快照被清空（数据"消失"事故）。localStorage 读取是同步的，无竞态。
  const defaults = {
    agentChat: [] as ChatMsg[],
    agentSessions: [] as AgentSession[],
    agentActiveId: null as string | null,
    goals: [] as Goal[],
    knowledge: [] as KnowledgeItem[],
    books: [] as Book[],
    sessions: [] as CouncilSession[],
    customPersonas: [] as CustomPersona[],
    folders: [] as string[],
    settings: DEFAULT_SETTINGS,
  };
  let loaded: Partial<AppState> = {};
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: Record<string, unknown>; version?: number };
      const st = (parsed?.state ?? {}) as Partial<AppState> & { knowledge?: unknown[] };
      const ver = parsed?.version ?? 2;
      // 与 persist.migrate 共用的累积式迁移：旧手动链是 else-if 逐版判断，
      // v1/v2 仓跳过 v4 清洗、v7+ 仓漏 v8 书籍迁移——现在两条路径同一份实现。
      const migrated = migrateState(st, ver);
      lastDiskRaw = raw;
      /* 脏数据自愈：早期引导路径可能把 topic 写成空串 → 列表卡片标题空白。
       * 用 direction 兜底，再兜「未命名目标」。只补空值，不动正常数据。 */
      const fixedGoals = ((migrated.goals ?? []) as Goal[]).map((g) =>
        g.topic?.trim()
          ? g
          : { ...g, topic: g.direction?.trim()?.slice(0, 24) || "未命名目标" }
      );
      loaded = {
        ...migrated,
        knowledge: backfillReviewDates((migrated.knowledge ?? []) as KnowledgeItem[], todayISO()),
        goals: fixedGoals,
      };
    }
  } catch {
    /* 损坏的仓按空仓处理，但绝不静默覆盖：紧接的 setState 会走 persist 把默认值
     * 写回同一个 key，把可能部分可恢复的内容销毁。先把原始字符串留档，再提示用户。 */
    try {
      const raw = localStorage.getItem(key);
      if (raw) localStorage.setItem(`mentora-store-corrupt-${Date.now()}`, raw);
    } catch { /* 留档失败也不能崩 */ }
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("mentora:store-warning", {
          detail: "本地快照读取失败（数据已留档到 mentora-store-corrupt-*）。可在设置页「从云端恢复」，或用开发者工具导出该留档找回内容。",
        })
      );
    }
  }
  useAppStore.setState({
    ...defaults,
    ...loaded,
    _storeUserId: userId,
  } as Partial<AppState>);
}

/* 多标签页同步：学习窗口是新标签页（独立文档），两个标签各持一份内存状态。
 * 另一个标签写入 localStorage 后（storage 事件即时回采，focus/visibility 兜底），
 * 本页采用磁盘上的最新仓——否则回到计划页看到的还是打开学习窗口前的进度，
 * 像"刚学的东西消失了"。 */
let storeSyncBound = false;
export function bindStoreSync() {
  if (storeSyncBound || typeof window === "undefined") return;
  storeSyncBound = true;
  const adopt = () => {
    // 磁盘快照已落后于内存（配额写失败）：保留内存，否则旧快照会盖掉新生成的讲义
    if (isStoreDiskStale()) return;
    const name = (useAppStore.persist.getOptions() as { name?: string }).name;
    if (!name) return;
    try {
      const raw = localStorage.getItem(name);
      if (!raw) return;
      // 磁盘就是我们最后一次写/回采的内容：本地任何 set 都会同步触发 persist 写盘，
      // 内存与磁盘必然一致——跳过整仓双重 stringify（大库每次聚焦要阻塞数十 ms）
      if (raw === lastDiskRaw) return;
      lastDiskRaw = raw;
      const parsed = JSON.parse(raw) as { state?: Partial<AppState> };
      const st = parsed?.state;
      if (!st) return;
      const cur = useAppStore.getState();
      const next = {
        goals: st.goals ?? cur.goals,
        knowledge: st.knowledge ?? cur.knowledge,
        books: st.books ?? cur.books,
        sessions: st.sessions ?? cur.sessions,
        customPersonas: st.customPersonas ?? cur.customPersonas,
        folders: st.folders ?? cur.folders,
        settings: st.settings ?? cur.settings,
      };
      const now = {
        goals: cur.goals,
        knowledge: cur.knowledge,
        books: cur.books,
        sessions: cur.sessions,
        customPersonas: cur.customPersonas,
        folders: cur.folders,
        settings: cur.settings,
      };
      // 内容一致就不 setState：避免每次聚焦都整树重渲染
      if (JSON.stringify(next) === JSON.stringify(now)) return;
      useAppStore.setState(next as Partial<AppState>);
    } catch {
      /* 仓损坏/配额满时保留内存现状 */
    }
  };
  window.addEventListener("storage", (e) => {
    const name = (useAppStore.persist.getOptions() as { name?: string }).name;
    if (!name || !e.key || e.key === name) adopt();
  });
  window.addEventListener("focus", adopt);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") adopt();
  });
}

/* ------- 派生选择器 ------- */
export function useDueReviews(): KnowledgeItem[] {
  return useAppStore(
    useShallow((s) => {
      const today = todayISO();
      return s.knowledge.filter(
        (k) => k.nextReviewAt && k.nextReviewAt <= today
      );
    })
  );
}
