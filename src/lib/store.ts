"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type {
  Book,
  ChatMsg,
  CouncilSession,
  CustomPersona,
  Goal,
  KnowledgeItem,
  KnowledgeSource,
  Plan,
  QuizResult,
  Settings,
} from "./types";
import { nextReviewDate, todayISO, uid } from "./utils";

export const DEFAULT_SETTINGS: Settings = {
  provider: "demo", // "自动"：跟随服务端配置，无配置时回退演示模式
  apiKey: "",
  model: "",
  baseUrl: "",
  userName: "",
};

interface AppState {
  goals: Goal[];
  knowledge: KnowledgeItem[];
  books: Book[];
  sessions: CouncilSession[];
  customPersonas: CustomPersona[];
  folders: string[]; // 第二大脑的文件夹（Obsidian 式目录树）
  settings: Settings;

  addGoal: (g: Goal) => void;
  updateGoal: (id: string, patch: Partial<Goal>) => void;
  removeGoal: (id: string) => void;
  setPlan: (goalId: string, plan: Plan) => void;
  setPhasePlan: (goalId: string, phaseId: string, boundary: string, days: Plan["days"]) => void;
  setDayStatus: (
    goalId: string,
    dayId: string,
    status: "active" | "passed" | "skipped"
  ) => void;
  incrementAttempts: (goalId: string, dayId: string) => void;
  logQuiz: (goalId: string, result: QuizResult) => void;

  addFolder: (name: string) => void;
  removeFolder: (name: string) => void;
  addKnowledge: (
    items: { title: string; body?: string; domain: string }[],
    source: KnowledgeSource,
    sourceTitle: string
  ) => void;
  /** 新建空笔记并返回真实 id（标题自动唯一，保证重名不冲突） */
  createKnowledge: (init?: { title?: string; domain?: string }) => string;
  /** Obsidian 批量导入：按标题去重，双链自动解析为 id；返回新增/跳过数 */
  importKnowledge: (
    items: { title: string; body: string; domain: string; sourceTitle: string; linkTitles: string[]; tags?: string[] }[]
  ) => { added: number; skipped: number };
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

      addGoal: (g) => set((s) => ({ goals: [g, ...s.goals] })),
      updateGoal: (id, patch) =>
        set((s) => ({
          goals: s.goals.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        })),
      removeGoal: (id) =>
        set((s) => ({ goals: s.goals.filter((g) => g.id !== id) })),
      setPlan: (goalId, plan) =>
        set((s) => ({
          goals: s.goals.map((g) => (g.id === goalId ? { ...g, plan } : g)),
        })),
      setPhasePlan: (goalId, phaseId, boundary, days) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const phase = plan.phases.find((ph) => ph.id === phaseId);
            if (!phase) return g;
            const dayIds: string[] = [];
            for (const d of Object.values(days)) {
              plan.days[d.id] = d;
              dayIds.push(d.id);
            }
            phase.dayIds = dayIds;
            phase.boundary = boundary;
            phase.planned = true;
            if (phase.status === "locked") phase.status = "active";
            const first = plan.days[dayIds[0]];
            if (first && first.status === "locked") first.status = "active";
            return { ...g, plan };
          }),
        })),
      setDayStatus: (goalId, dayId, status) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const day = plan.days[dayId];
            if (!day) return g;
            day.status = status;
            day.completedAt = status === "active" ? undefined : todayISO();
            if (status === "passed" || status === "skipped")
              unlockNext({ ...g, plan }, dayId);
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
      removeFolder: (name) => set((s) => ({ folders: s.folders.filter((f) => f !== name) })),

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
            masteredAt: todayISO(),
            reviewStage: 0,
            nextReviewAt: todayISO(),
            links: [],
          }));
        set((s) => ({ knowledge: [...fresh, ...s.knowledge] }));
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
        const existing = new Set(get().knowledge.map((k) => norm(k.title)));
        const fresh: KnowledgeItem[] = [];
        const freshLinks: string[][] = [];
        const seen = new Set<string>();
        for (const i of items) {
          const t = norm(i.title);
          if (!i.title || !t || existing.has(t) || seen.has(t)) continue;
          seen.add(t);
          fresh.push({
            id: uid("k"),
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
        /* 双链两遍解析：标题（大小写不敏感）→ 笔记 id */
        const byTitle = new Map<string, string>();
        for (const k of [...get().knowledge, ...fresh]) byTitle.set(norm(k.title), k.id);
        fresh.forEach((f, i) => {
          const ids = new Set<string>();
          for (const lt of freshLinks[i]) {
            const id = byTitle.get(norm(lt));
            if (id && id !== f.id) ids.add(id);
          }
          f.links = [...ids];
        });
        set((s) => ({ knowledge: [...fresh, ...s.knowledge] }));
        return { added: fresh.length, skipped: items.length - fresh.length };
      },
      updateKnowledge: (id, patch) =>
        set((s) => ({
          knowledge: s.knowledge.map((k) =>
            k.id === id ? { ...k, ...patch } : k
          ),
        })),
      removeKnowledge: (id) =>
        set((s) => ({
          knowledge: s.knowledge
            .filter((k) => k.id !== id)
            .map((k) => ({ ...k, links: k.links.filter((l) => l !== id) })),
        })),
      recordReview: (id, ok) =>
        set((s) => ({
          knowledge: s.knowledge.map((k) => {
            if (k.id !== id) return k;
            const stage = ok ? k.reviewStage + 1 : Math.max(0, k.reviewStage - 1);
            const done = ok && stage >= 4;
            return {
              ...k,
              reviewStage: stage,
              lastReviewOk: ok,
              nextReviewAt: done ? undefined : nextReviewDate(stage),
            };
          }),
        })),
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
      resetAll: () =>
        set({
          goals: [],
          knowledge: [],
          books: [],
          sessions: [],
          customPersonas: [],
          settings: get().settings,
        }),
    }),
    {
      name: "mentora-store-v1",
      version: 2,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Partial<AppState> & { knowledge?: unknown[] };
        if (version < 2) {
          return {
            ...state,
            knowledge: migrateKnowledge(state.knowledge ?? []),
            customPersonas: state.customPersonas ?? [],
          } as AppState;
        }
        return state as AppState;
      },
    }
  )
);

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
