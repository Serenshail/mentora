import type { GoalCard, PlanDraft, MasterPlanDraft, PhasePlanDraft } from "@/lib/ai/client";
import type { Plan } from "@/lib/types";
import { addDays, todayISO, uid } from "@/lib/utils";

/** 模型产出的计划草稿 → 带状态机的正式计划（第一阶段首天激活，其余锁定） */
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
        resources: d.resources.map((r) => ({
          title: r.title,
          url: r.url || undefined,
          why: r.why,
          year: r.year ?? undefined,
          kind: r.kind ?? undefined,
          evergreen: r.evergreen ?? undefined,
        })),
        method: d.method,
        example: d.example
          ? {
              title: d.example.title,
              description: d.example.description,
              code: d.example.code || undefined,
            }
          : undefined,
        acceptance: d.acceptance.map((a) => ({
          id: uid("ac"),
          kind: a.kind,
          question: a.question,
          hint: a.hint || undefined,
        })),
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
      title: `阶段${pi + 1} · ${p.title}`,
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
    /* 与 draftToPlan 同一口径：schema 特意容错解析的 year/kind/evergreen 必须带上，
     * 否则 rankResources 的 kind 权重与 evergreen 降权在「总纲要→逐阶段」主流程静默失效 */
    resources: d.resources.map((r) => ({
      title: r.title,
      url: r.url || undefined,
      why: r.why,
      year: r.year ?? undefined,
      kind: r.kind ?? undefined,
      evergreen: r.evergreen ?? undefined,
    })),
    method: d.method,
    example: d.example
      ? { title: d.example.title, description: d.example.description, code: d.example.code || undefined }
      : undefined,
    acceptance: d.acceptance.map((a) => ({
      id: uid("ac"),
      kind: a.kind,
      question: a.question,
      hint: a.hint || undefined,
    })),
    status: "locked",
    attempts: 0,
  };
}
