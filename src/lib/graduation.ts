import { extractJson, graduationSchema, streamChat } from "./ai/client";
import { useAppStore } from "./store";
import { MASTERY_LABELS, MASTERY_ORDER, type Goal, type MasteryStatus } from "./types";

/** 结业回路（v21）：最后一个阶段过门后，把"完成"变成一次可回看、可继续的动作。
 *
 *  为什么放在客户端而不是 store：
 *  - store 必须是纯状态（可测试、可序列化），不能在里面调模型；
 *  - 结业失败不能影响目标完成状态——目标已经 done，结业只是"补一份总结"。
 *
 *  幂等：goal.graduatedAt 有值就直接返回，重复进入页面不会重复生成笔记。 */

function masteryBucket(m?: string): MasteryStatus {
  return (m as MasteryStatus) || "unknown";
}

/** 把目标压成模型能读的最小上下文：只给真实存在的事实，不给全量笔记 */
function buildGraduationCtx(goal: Goal) {
  const days = goal.plan ? Object.values(goal.plan.days) : [];
  const done = days.filter((d) => d.status === "passed" || d.status === "skipped");
  const points = days.flatMap((d) =>
    (d.knowledgePoints || []).map((k) => ({
      text: k.text,
      mastery: masteryBucket(k.masteryStatus),
      historicalHighest: k.historicalHighest || k.masteryStatus || "unknown",
      day: d.title,
    }))
  );
  const failures = (goal.quizLog || [])
    .filter((q) => !q.passed)
    .slice(0, 8)
    .map((q) => ({
      day: q.dayId,
      forced: q.forced,
      missed: (q.items || []).filter((i) => i.verdict === "incorrect").map((i) => i.question).slice(0, 3),
    }));
  return {
    topic: goal.topic,
    direction: goal.direction,
    domainKind: goal.domainKind,
    weeklyHours: goal.weeklyHours,
    successCriteria: goal.successCriteria,
    phases: (goal.plan?.phases || []).map((p) => ({ title: p.title, outcome: p.outcome })),
    totalDays: days.length,
    completedDays: done.length,
    knowledgePoints: points,
    failures,
  };
}

/** 生成结业笔记 + 下一步建议，写进第二大脑并标记目标已结业。
 *  返回 { ok, noteId?, nextSteps?, error? } */
export async function runGraduation(goalId: string): Promise<{
  ok: boolean;
  noteId?: string;
  nextSteps?: string[];
  error?: string;
}> {
  const st = useAppStore.getState();
  const goal = st.goals.find((g) => g.id === goalId);
  if (!goal) return { ok: false, error: "目标不存在" };
  if (goal.graduatedAt) return { ok: true, noteId: goal.graduationNoteId, nextSteps: goal.nextSteps };

  const ctx = buildGraduationCtx(goal);
  let parsed;
  try {
    const full = await streamChat({
      task: "graduation",
      args: { ctx: JSON.stringify(ctx, null, 1) },
      messages: [{ role: "user", content: "生成结业总结与下一步建议。" }],
      temperature: 0.4,
      onDelta: () => {},
    });
    parsed = graduationSchema.parse(extractJson(full));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const masterLine = `- 掌握分布：${(["durable", "transferable", "independent", "guided", "exposed", "unknown"] as MasteryStatus[])
    .map((m) => {
      const n = ctx.knowledgePoints.filter((k) => k.historicalHighest === m).length;
      return n ? `${MASTERY_LABELS[m]} ${n}` : "";
    })
    .filter(Boolean)
    .join(" · ")}`;

  const body = [
    parsed.noteMarkdown,
    "",
    "---",
    "",
    `- 目标：${goal.topic}${goal.direction ? `（${goal.direction}）` : ""}`,
    `- 完成度：${ctx.completedDays}/${ctx.totalDays} 天`,
    masterLine,
    "",
    "## 下一步（只是建议，不会自动创建）",
    ...parsed.nextSteps.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");

  /* 写进第二大脑：source=learn，带目标标题方便回溯；不自动排复习（结业笔记是"索引型"内容） */
  const note = useAppStore.getState().knowledge.find(
    (k) => k.title === `结业 · ${goal.topic}` && k.sourceTitle === goal.topic
  );
  let noteId = note?.id;
  if (!noteId) {
    useAppStore.getState().addKnowledge(
      [{ title: `结业 · ${goal.topic}`, body, domain: `${goal.topic}/结业`, masteryStatus: "durable" }],
      "learn",
      goal.topic
    );
    noteId = useAppStore
      .getState()
      .knowledge.find((k) => k.title === `结业 · ${goal.topic}` && k.sourceTitle === goal.topic)?.id;
  }

  useAppStore.getState().updateGoal(goal.id, {
    needsGraduation: false,
    graduatedAt: new Date().toISOString(),
    graduationNoteId: noteId,
    nextSteps: parsed.nextSteps,
  });

  return { ok: true, noteId, nextSteps: parsed.nextSteps };
}

export { MASTERY_ORDER };
