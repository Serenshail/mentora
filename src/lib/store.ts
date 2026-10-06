"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from "ts-fsrs";
import { useShallow } from "zustand/react/shallow";
import {
  MASTERY_ORDER,
} from "@/lib/types";
import type {
  Book,
  ChatMsg,
  CouncilSession,
  CustomPersona,
  Goal,
  KnowledgeItem,
  MasteryStatus,
  GradingResult,
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

/* ========= 掌握状态推进（Learn Anything assessment-integrity） =========
 * 规则：L1-L4 提示下完成最高只记 guided；L5 完整示范后原题不得记 independent；
 * 结论对但依据错不升级；一次偶然答对不覆盖此前引导证据（historicalHighest 保底）。
 * ungradable 不算任何证据。 */
export function advanceMastery(
  cur: MasteryStatus | undefined,
  hist: MasteryStatus | undefined,
  verdict: GradingResult,
  hintLevel: number | undefined
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
    else next = maxStatus("independent", base); // 无提示答对
  } else if (verdict === "partially_correct") {
    next = maxStatus("guided", base === "unknown" ? "exposed" : base);
  } else {
    // incorrect：不升级；连续错误由 FSRS/复习队列处理,不在此降级历史
    next = base === "unknown" ? "exposed" : base;
  }
  return { next, hist: idx(next) > idx(h) ? next : h };
}

function maxStatus(a: MasteryStatus, b: MasteryStatus): MasteryStatus {
  return MASTERY_ORDER.indexOf(a) >= MASTERY_ORDER.indexOf(b) ? a : b;
}

/** 验收通过后,把本日知识点按判分/提示等级推进掌握状态并同步进第二大脑的对应笔记 */
export function masteryFromQuiz(items: { verdict: GradingResult; hintLevel?: number }[]): MasteryStatus {
  // 取所有题里最弱的证据作为本日知识点的保守估计（Learn Anything:证据从紧不从松）
  let worst: MasteryStatus = "durable";
  for (const it of items) {
    const { next } = advanceMastery("unknown", undefined, it.verdict, it.hintLevel);
    if (MASTERY_ORDER.indexOf(next) < MASTERY_ORDER.indexOf(worst)) worst = next;
  }
  return worst === "durable" ? "independent" : worst; // 单日到不了 durable(需延迟复习)
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
        /* 双链解析：标题（大小写不敏感）→ 笔记 id；
           解析不到的目标 = Obsidian「未解析链接」→ 建灰色占位笔记（unresolved），
           关系链绝不丢弃；之后真笔记导入时原位合并（见下方 upgrade 逻辑） */
        const placeholders: KnowledgeItem[] = [];
        const placeholderIds = new Map<string, string>(); // norm(title) -> id
        const byTitle = new Map<string, string>();
        for (const k of get().knowledge) byTitle.set(norm(k.title), k.id);
        for (const k of fresh) byTitle.set(norm(k.title), k.id);
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
        /* 真笔记升级占位：同标题 unresolved 占位 → 原位替换（保留 id 与入链），不占去重名额 */
        let knowledge = get().knowledge;
        if (placeholders.length > 0) {
          const upgraded = new Set<string>(); // 占位 id -> 已被真笔记替换
          for (const f of fresh) {
            const pid = placeholderIds.get(norm(f.title));
            if (!pid) continue;
            const ph = knowledge.find((k) => k.id === pid);
            if (!ph?.unresolved) continue;
            upgraded.add(pid);
            knowledge = knowledge.map((k) =>
              k.id === pid
                ? { ...f, id: k.id, links: [...new Set([...f.links, ...k.links])] }
                : k
            );
          }
          if (upgraded.size > 0) {
            /* 占位 id 原位保留 → 所有指向它的链接天然有效，无需清理 */
            const keptFresh = fresh.filter((f) => !upgraded.has(f.id));
            const newPlaceholders = placeholders.filter((p) => !upgraded.has(p.id));
            set((s) => ({ knowledge: [...newPlaceholders, ...keptFresh, ...s.knowledge] }));
            const added = keptFresh.length + upgraded.size;
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
        /* FSRS 新卡/重学的当日到期 → 顺延到明天（我们按天复习，不做分钟级） */
        const dueDate = new Date(c.due);
        const tomorrow = new Date(Date.now() + 86400000);
        const next = c.scheduled_days < 1 ? tomorrow : dueDate;
        done(next.toISOString().slice(0, 10), {
          fsrs: fsrsState,
          reviewStage: stageOf(c.scheduled_days),
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
      version: 4,
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
      // 与 persist.migrate 同一套迁移:同步加载路径也要跑(v3 双链解析/v4 Day 前缀清洗)
      let knowledge = st.knowledge ?? [];
      if (ver < 2) knowledge = migrateKnowledge(knowledge);
      else if (ver < 4) knowledge = linkifyBodies(
        ver < 4
          ? ((knowledge as KnowledgeItem[]).map((k) =>
              k.body && /Day\s*\d+[：:]\s*Day\s*\d+[：:]/.test(k.body)
                ? { ...k, body: k.body.replace(/(Day\s*\d+[：:])\s*Day\s*\d+[：:]\s*/g, "$1 ") }
                : k
            ))
          : (knowledge as KnowledgeItem[])
      );
      loaded = { ...st, knowledge };
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
