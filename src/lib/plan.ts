import type { GoalCard, PlanDraft } from "@/lib/ai/client";
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

  draft.phases.forEach((p, pi) => {
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
    void pi;
  });

  // 激活起点
  if (plan.phases[0]) {
    plan.phases[0].status = "active";
    const firstDay = plan.days[plan.phases[0].dayIds[0]];
    if (firstDay) firstDay.status = "active";
  }
  return plan;
}
