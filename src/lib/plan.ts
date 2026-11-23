import type { GoalCard, PlanDraft, MasterPlanDraft, PhasePlanDraft } from "@/lib/ai/client";
import type { Plan } from "@/lib/types";
import { addDays, todayISO, uid } from "@/lib/utils";

/* draftToPlan（整计划）与 phaseDraftToDay（总纲要→逐阶段单日展开）共用同一套映射，
 * 保证 resources/example/acceptance 口径永远一致：schema 特意容错解析的 year/kind/evergreen
 * 必须带上，否则 rankResources 的 kind 权重与 evergreen 降权会在「总纲要→逐阶段」主流程
 * 静默失效（曾因两处逐字重复、修改只落一处而出过事故）。新增字段/改容错逻辑只改这里一处。 */
type ResourceDraft = {
  title: string;
  url?: string | null;
  why: string;
  year?: number | null;
  kind?: string | null;
  evergreen?: boolean | null;
};
type ExampleDraft = {
  title: string;
  description: string;
  code?: string | null;
};
type AcceptanceDraft = {
  kind: "explain" | "apply" | "oral" | "essay" | "build";
  question: string;
  hint?: string | null;
};

function mapResources(resources: ResourceDraft[]) {
  return resources.map((r) => ({
    title: r.title,
    url: r.url || undefined,
    why: r.why,
    year: r.year ?? undefined,
    kind: r.kind ?? undefined,
    evergreen: r.evergreen ?? undefined,
  }));
}

function mapExample(example: ExampleDraft | null | undefined) {
  return example
    ? { title: example.title, description: example.description, code: example.code || undefined }
    : undefined;
}

function mapAcceptance(acceptance: AcceptanceDraft[]) {
  return acceptance.map((a) => ({
    id: uid("ac"),
    kind: a.kind,
    question: a.question,
    hint: a.hint || undefined,
  }));
}

/** 模型产出的计划草稿 → 带状态机的正式计划（第一阶段首天激活，其余锁定）。
 *  @deprecated 整计划一步生成的旧链路，真实链路已改为 masterDraftToPlan + phaseDraftToDay；
 *  仅 plan-draft-mapping 回归锁作为「映射同口径」的参照实现调用，勿在新代码中使用。 */
export function draftToPlan(draft: PlanDraft, card: GoalCard): Plan {
  const plan: Plan = {
    summary: draft.summary,
    totalDays: draft.totalDays,
    weeklyHours: card.weeklyHours || draft.weeklyHours,
    startDate: addDays(1, todayISO()),
    phases: [],
    days: {},
    createdAt: new Date().toISOString(),
  };

  draft.phases.forEach((p) => {
    const phaseId = uid("ph");
    const dayIds: string[] = [];
    p.days.forEach((d) => {
      const dayId = uid("day");
      dayIds.push(dayId);
      plan.days[dayId] = {
        id: dayId,
        phaseId,
        title: d.title,
        knowledgePoints: d.knowledgePoints.map((t) => ({ id: uid("kp"), text: t })),
        resources: mapResources(d.resources),
        method: d.method,
        example: mapExample(d.example),
        acceptance: mapAcceptance(d.acceptance),
        status: "locked",
        attempts: 0,
      };
    });
    plan.phases.push({
      id: phaseId,
      title: p.title,
      outcome: p.outcome,
      dayIds,
      status: "locked",
    });
  });

  // 激活起点
  if (plan.phases[0]) {
    plan.phases[0].status = "active";
    const firstDay = plan.days[plan.phases[0].dayIds[0]];
    if (firstDay) firstDay.status = "active";
  }
  return plan;
}


export function phaseName(title: string): string {
  const withoutOrdinal = title.trim().replace(/^(?:(?:(?:第\s*)?(?:\d+|[一二三四五六七八九十]+)\s*阶段|阶段\s*(?:\d+|[一二三四五六七八九十]+))\s*[·、：:.—–-]\s*)+/u, "");
  return withoutOrdinal || title;
}

/* ---------------- 计划类笔记标题契约（唯一真源） ----------------
 * 纲要笔记的 [[wikilink]]（learn/new 生成总纲要时写入正文）必须与阶段/总纲要笔记
 * 实际落库标题（learn/[id] 生成阶段目录时写入）逐字符一致——wiki-links 的索引按
 * 标题精确匹配，失配即链接静默变成 unresolved 空占位（用户点开是空笔记，无报错）。
 * 此前两个页面各自硬编码拼接同一格式字符串，任何一侧改文案/分隔符都会全链悬空；
 * 两处必须经由这两个函数取标题，不许再手拼。 */
export function planOutlineNoteTitle(topic: string): string {
  return `${topic} 学习计划 · 学习总纲要`;
}

export function planPhaseNoteTitle(topic: string, phaseTitle: string): string {
  return `${topic} 学习计划 · ${phaseTitle}`;
}

/** 总纲要 → Plan（只有 phases 骨架，无天；第一阶段激活、待生成天级计划） */
export function masterDraftToPlan(draft: MasterPlanDraft, card: GoalCard): Plan {
  const plan: Plan = {
    summary: draft.summary,
    totalDays: draft.phases.reduce((a, p) => a + (p.estDays ?? 0), 0),
    weeklyHours: card.weeklyHours,
    startDate: addDays(1, todayISO()),
    phases: [],
    days: {},
    createdAt: new Date().toISOString(),
  };
  draft.phases.forEach((p, pi) => {
    const phaseId = uid("ph");
    plan.phases.push({
      id: phaseId,
      title: phaseName(p.title),
      outcome: p.outcome,
      dayIds: [],
      status: pi === 0 ? "active" : "locked",
      outline: p.outline,
      boundary: p.boundary || undefined,
      estDays: p.estDays || undefined,
      planned: false,
    });
  });
  return plan;
}

/** 单日详情草稿 → DayPlan（目录 id 复用；状态由 setDayDetail 按占位继承） */
export function phaseDraftToDay(
  d: PhasePlanDraft["days"][number],
  phaseId: string,
  dayId: string
): Plan["days"][string] {
  return {
    id: dayId,
    phaseId,
    title: d.title,
    knowledgePoints: d.knowledgePoints.map((t) => {
      if (typeof t === "string") return { id: uid("kp"), text: t };
      return { id: uid("kp"), text: t.text, knowledgeType: t.knowledgeType };
    }),
    resources: mapResources(d.resources),
    method: d.method,
    example: mapExample(d.example),
    acceptance: mapAcceptance(d.acceptance),
    status: "locked",
    attempts: 0,
  };
}
