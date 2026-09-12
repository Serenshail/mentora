"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import type {
  Book,
  ChatMsg,
  CouncilSession,
  Goal,
  KnowledgeItem,
  KnowledgeSource,
  Plan,
  QuizResult,
  Settings,
} from "./types";
import { nextReviewDate, todayISO, uid } from "./utils";

export const DEFAULT_SETTINGS: Settings = {
  provider: "demo",
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
  settings: Settings;

  addGoal: (g: Goal) => void;
  updateGoal: (id: string, patch: Partial<Goal>) => void;
  removeGoal: (id: string) => void;
  setPlan: (goalId: string, plan: Plan) => void;
  setDayStatus: (
    goalId: string,
    dayId: string,
    status: "active" | "passed" | "skipped"
  ) => void;
  incrementAttempts: (goalId: string, dayId: string) => void;
  logQuiz: (goalId: string, result: QuizResult) => void;

  addKnowledge: (items: { text: string; domain: string }[], source: KnowledgeSource, sourceTitle: string) => void;
  recordReview: (id: string, ok: boolean) => void;
  removeKnowledge: (id: string) => void;

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

  setSettings: (patch: Partial<Settings>) => void;
  importData: (data: {
    goals?: Goal[];
    knowledge?: KnowledgeItem[];
    books?: Book[];
    sessions?: CouncilSession[];
    settings?: Settings;
  }) => void;
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
    // 阶段最后一天：阶段完成，解锁下一阶段首天
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

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      goals: [],
      knowledge: [],
      books: [],
      sessions: [],
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
      setDayStatus: (goalId, dayId, status) =>
        set((s) => ({
          goals: s.goals.map((g) => {
            if (g.id !== goalId || !g.plan) return g;
            const plan = structuredClone(g.plan);
            const day = plan.days[dayId];
            if (!day) return g;
            day.status = status;
            day.completedAt = status === "active" ? undefined : todayISO();
            if (status === "passed" || status === "skipped") unlockNext({ ...g, plan }, dayId);
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

      addKnowledge: (items, source, sourceTitle) =>
        set((s) => {
          const existing = new Set(s.knowledge.map((k) => k.text));
          const fresh: KnowledgeItem[] = items
            .filter((i) => i.text && !existing.has(i.text))
            .map((i) => ({
              id: uid("k"),
              text: i.text,
              domain: i.domain,
              source,
              sourceTitle,
              masteredAt: todayISO(),
              reviewStage: 0,
              nextReviewAt: todayISO(), // 当天即可首刷
            }));
          return { knowledge: [...fresh, ...s.knowledge] };
        }),
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
      removeKnowledge: (id) =>
        set((s) => ({ knowledge: s.knowledge.filter((k) => k.id !== id) })),

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

      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      importData: (data) =>
        set((s) => ({
          goals: data.goals ?? s.goals,
          knowledge: data.knowledge ?? s.knowledge,
          books: data.books ?? s.books,
          sessions: data.sessions ?? s.sessions,
          settings: { ...s.settings, ...(data.settings ?? {}) },
        })),
      resetAll: () =>
        set({
          goals: [],
          knowledge: [],
          books: [],
          sessions: [],
          settings: get().settings,
        }),
    }),
    { name: "mentora-store-v1" }
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
