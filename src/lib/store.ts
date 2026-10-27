"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from "ts-fsrs";
import { useShallow } from "zustand/react/shallow";
import {
  NodeStatus,
  DayPlan,
} from "@/lib/types";
import type {
  Book,
  ChatMsg,
  CouncilSession,
  CustomPersona,
  Goal,
  KnowledgeItem,
  MasteryStatus,
  KnowledgeSource,
  KnowledgeType,
  Plan,
  QuizResult,
  Settings,
} from "./types";
import { todayISO, uid } from "./utils";
import { track } from "./track";

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
  removeKnowledge: (id: string) => void;
  recordReview: (id: string, ok: boolean) => void;
  linkNotes: (fromId: string, toId: string) => void;
  unlinkNotes: (fromId: string, toId: string) => void;

  addBook: (b: Book) => void;
  updateBook: (id: string, patch: Partial<Book>) => void;
  removeBook: (id: string) => void;
  addBookMsg: (id: string, msg: ChatMsg) => void;
  addInsight: (bookId: string, text: string) => void;
  toggleChapter: (bookId: string, chapterId: string) => void;

  addSession: (s: CouncilSession) => void;
  updateSession: (id: string, patch: Partial<CouncilSession>) => void;
  removeSession: (id: string) => void;
  addSessionMsg: (id: string, msg: ChatMsg) => void;

  addCustomPersona: (p: CustomPersona) => void;
  removeCustomPersona: (id: string) => void;

  setSettings: (patch: Partial<Settings>) => void;
  importData: (data: Partial<AppState>) => void;
  resetAll: () => void;
  seedSampleGoal: () => string;
}

/** 通过某天后解锁同阶段下一天 / 下一阶段首天 */
function unlockNext(goal: Goal, dayId: string) {
  if (!goal.plan) return;
  const day = goal.plan.days[dayId];
  if (!day) return;
  const phase = goal.plan.phases.find((p) => p.id === day.phaseId);
  if (!phase) return;

  const idx = phase.dayIds.indexOf(dayId);
  if (idx >= 0 && idx < phase.dayIds.length - 1) {
    const next = goal.plan.days[phase.dayIds[idx + 1]];
    if (next && next.status === "locked") next.status = "active";
  } else {
    phase.status = "passed";
    const pIdx = goal.plan.phases.findIndex((p) => p.id === phase.id);
    const nextPhase = goal.plan.phases[pIdx + 1];
    if (nextPhase && nextPhase.status === "locked") {
      nextPhase.status = "active";
      const first = goal.plan.days[nextPhase.dayIds[0]];
      if (first && first.status === "locked") first.status = "active";
    } else if (!nextPhase) {
      goal.status = "done";
    }
  }
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
    } catch (e) {
      const quota =
        e instanceof DOMException &&
        (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
      if (!quota) throw e;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("mentora:quota"));
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
function linkifyBodies(knowledge: KnowledgeItem[]): KnowledgeItem[] {
  const norm = (t: string) => t.trim().toLowerCase();
  const byTitle = new Map<string, string>();
  for (const k of knowledge) if (!k.unresolved) byTitle.set(norm(k.title), k.id);
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  return knowledge.map((k) => {
    const found: string[] = [];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(k.body || ""))) {
      const id = byTitle.get(norm(m[1]));
      if (id && id !== k.id) found.push(id);
    }
    if (!found.length) return k;
    const merged = [...new Set([...(k.links ?? []), ...found])];
    if (merged.length === (k.links?.length ?? 0)) return k;
    return { ...k, links: merged };
  });
}

/* ========= 掌握状态推进（v17 拆至纯模块 mastery.ts，可单测） =========
 * store 内部与外部调用点都从这里拿：行为与原 store 内联版一致，新增复习接线与 apply 迁移证据。 */
export { advanceMastery, masteryFromQuiz, masteryFromReview, maxStatus } from "./mastery";
import { masteryFromReview } from "./mastery";

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
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
            if ((status === "passed" && !gate) || status === "skipped")
              unlockNext({ ...g, plan }, dayId);
            /* 结业标记两条路径都要覆盖：正常过门（completeTransfer）与强制跳过（这里）。
             * 判定依据是 unlockNext 之后 goal.status 是否变成 done。 */
            if (g.status === "done" && !g.graduatedAt && !g.needsGraduation) {
              return { ...g, plan, needsGraduation: true };
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
            unlockNext({ ...g, plan }, dayId);
            /* 结业回路（v21）：最后一个阶段过门后 goal.status 变 done。
             * 在这里标记 needsGraduation，由 UI 一次性生成结业笔记+下一步建议——
             * 不在 store 里同步调模型（store 必须保持纯状态）。 */
            if (g.status === "done" && !g.graduatedAt) {
              return { ...g, plan, needsGraduation: true };
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
      logQuiz: (goalId, result) =>
        set((s) => ({
          goals: s.goals.map((g) =>
            g.id === goalId ? { ...g, quizLog: [result, ...g.quizLog] } : g
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
            nextReviewAt: todayISO(),
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
            set((s) => ({ knowledge: [...newPlaceholders, ...keptFresh, ...knowledge] }));
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
        const next = knowledge.map((k) => {
          const oldValid = new Set(
            k.links.filter((l) => knowledge.some((t) => t.id === l && !t.unresolved))
          );
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
        set((s) => ({ knowledge: [...placeholders, ...next] }));
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
          // 正文改了→重新解析 [[双链]] 进 links,图谱/反链实时同步
          if (patch.body !== undefined) knowledge = linkifyBodies(knowledge);
          return { knowledge };
        }),
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
                    lastReviewOk: ok,
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
      unlinkNotes: (fromId, toId) =>
        set((s) => ({
          knowledge: s.knowledge.map((k) =>
            k.id === fromId
              ? { ...k, links: k.links.filter((l) => l !== toId) }
              : k
          ),
        })),

      addBook: (b) => set((s) => ({ books: [b, ...s.books] })),
      updateBook: (id, patch) =>
        set((s) => ({
          books: s.books.map((b) => (b.id === id ? { ...b, ...patch } : b)),
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

      addCustomPersona: (p) =>
        set((s) => ({ customPersonas: [p, ...s.customPersonas] })),
      removeCustomPersona: (id) =>
        set((s) => ({
          customPersonas: s.customPersonas.filter((p) => p.id !== id),
          sessions: s.sessions.filter((x) => x.personaId !== id),
        })),

      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      importData: (data) =>
        set((s) => ({
          goals: data.goals ?? s.goals,
          knowledge: data.knowledge ?? s.knowledge,
          books: data.books ?? s.books,
          sessions: data.sessions ?? s.sessions,
          customPersonas: data.customPersonas ?? s.customPersonas,
          settings: { ...s.settings, ...(data.settings ?? {}) },
        })),
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
      version: 5,
      // 跳过 persist 的自动 rehydrate：水合完全由 setStoreUser() 同步掌控。
      // 否则刷新页面时 persist 会用 anon 仓异步覆盖内存,而此刻 setOptions 已换到用户仓——
      // 空状态随后被写进用户仓,goal 凭空消失(实测:导航后 3s goals 1→0,堆栈指向 persist setState)。
      skipHydration: true,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        goals: state.goals,
        knowledge: state.knowledge,
        books: state.books,
        sessions: state.sessions,
        customPersonas: state.customPersonas,
        folders: state.folders,
        settings: state.settings,
        _storeUserId: state._storeUserId,
      }),
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Partial<AppState> & { knowledge?: unknown[] };
        if (version < 2) {
          return {
            ...state,
            knowledge: linkifyBodies(migrateKnowledge(state.knowledge ?? [])),
            customPersonas: state.customPersonas ?? [],
          } as AppState;
        }
        // v3:把已有笔记正文里的 [[双链]] 一次性解析进 links,旧图谱立即有连线
        if (version < 3) {
          return { ...state, knowledge: linkifyBodies((state.knowledge ?? []) as KnowledgeItem[]) } as AppState;
        }
        // v4:清洗历史脏正文——"Day N：Day N：" 重复前缀(早期生成 bug 的残留),一次性自愈
        if (version < 4) {
          const fixed = ((state.knowledge ?? []) as KnowledgeItem[]).map((k) =>
            k.body && /Day\s*\d+[：:]\s*Day\s*\d+[：:]/.test(k.body)
              ? { ...k, body: k.body.replace(/(Day\s*\d+[：:])\s*Day\s*\d+[：:]\s*/g, "$1 ") }
              : k
          );
          return { ...state, knowledge: linkifyBodies(fixed) } as AppState;
        }
        // v5:修复分批生成时代产生的重复/乱序天标题——每个阶段按 dayIds 顺序重编 "Day N：",
        // 重复的天（旧 bug 生成的 Day1,Day2,Day1,Day2…）保留内容、顺序归位。
        if (version < 5) {
          const goals = (state.goals ?? []).map((g) => {
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
          return { ...state, goals } as AppState;
        }
        return state as AppState;
      },
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
      /* 私密模式/localStorage 满时忽略 */
    }
  }

  useAppStore.persist.setOptions({ name: key });

  // 同步加载目标仓（替代 persist.rehydrate 的异步加载）：
  // rehydrate 是异步的，期间任何 clearLocalStore/写入都会把空状态写进刚切换的仓，
  // 曾导致用户本地快照被清空（数据"消失"事故）。localStorage 读取是同步的，无竞态。
  const defaults = {
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
      // 与 persist.migrate 完全同一套迁移:同步加载路径也要跑(v2/v3 双链解析/v4 Day 前缀清洗/v5 天标题重编)。
      // 此前 v<2 分支只跑 migrateKnowledge 漏了 linkifyBodies——老用户图谱/反链为空。
      let knowledge = st.knowledge ?? [];
      if (ver < 2) knowledge = linkifyBodies(migrateKnowledge(knowledge));
      else if (ver < 3) knowledge = linkifyBodies(knowledge as KnowledgeItem[]);
      else if (ver < 4)
        knowledge = linkifyBodies(
          (knowledge as KnowledgeItem[]).map((k) =>
            k.body && /Day\s*\d+[：:]\s*Day\s*\d+[：:]/.test(k.body)
              ? { ...k, body: k.body.replace(/(Day\s*\d+[：:])\s*Day\s*\d+[：:]\s*/g, "$1 ") }
              : k
          )
        );
      let goals = st.goals ?? [];
      if (ver < 5) {
        goals = (goals as Goal[]).map((g) => {
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
      }
      loaded = { ...st, knowledge, goals };
    }
  } catch {
    /* 损坏的仓按空仓处理，绝不写入破坏 */
  }
  useAppStore.setState({
    ...defaults,
    ...loaded,
    _storeUserId: userId,
  } as Partial<AppState>);
}

export function clearLocalStore() {
  useAppStore.setState({
    goals: [],
    knowledge: [],
    books: [],
    sessions: [],
    customPersonas: [],
    folders: [],
    settings: DEFAULT_SETTINGS,
    _storeUserId: useAppStore.getState()._storeUserId,
  });
}

/* 多标签页同步：学习窗口是新标签页（独立文档），两个标签各持一份内存状态。
 * 另一个标签写入 localStorage 后，本页在重新可见时采用磁盘上的最新仓——
 * 否则回到计划页看到的还是打开学习窗口前的进度，像"刚学的东西消失了"。 */
let storeSyncBound = false;
export function bindStoreSync() {
  if (storeSyncBound || typeof window === "undefined") return;
  storeSyncBound = true;
  const adopt = () => {
    const name = (useAppStore.persist.getOptions() as { name?: string }).name;
    if (!name) return;
    try {
      const raw = localStorage.getItem(name);
      if (!raw) return;
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
export function useActiveGoal(): Goal | undefined {
  return useAppStore((s) => s.goals.find((g) => g.status === "active"));
}

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
