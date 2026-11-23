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
  const pointsAll = days.flatMap((d) =>
    (d.knowledgePoints || []).map((k) => ({
      text: k.text,
      mastery: masteryBucket(k.masteryStatus),
      historicalHighest: k.historicalHighest || k.masteryStatus || "unknown",
      day: d.title,
    }))
  );
  /* 结业上下文必须截断：failures 早截了 8 条，知识点却全量带上——数百天长目标
   * 可有上万条，提示词能到几十万 token：小上下文模型直接 400，而 graduatedAt 只在
   * 成功后写入，用户每次重试都完整重放一遍巨型提示词（BYOK 真金白银 / 服务端占配额）。 */
  const points = pointsAll.slice(-200);
  /* 掌握分布是写进笔记正文的结论，必须按全量知识点统计（与目标页 learn/[id]/page.tsx
   * GraduationPanel 的同名统计同口径）；截断只限制模型看到的样本，不能改变结论口径。
   * 两者不一致时在笔记里标注样本量，读者才知道这份分布覆盖了多少条。 */
  const masteryCounts = new Map<MasteryStatus, number>();
  for (const p of pointsAll) {
    const m = p.historicalHighest as MasteryStatus;
    masteryCounts.set(m, (masteryCounts.get(m) ?? 0) + 1);
  }
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
    masteryCounts: Object.fromEntries(masteryCounts) as Partial<Record<MasteryStatus, number>>,
    knowledgePointsTotal: pointsAll.length,
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
      /* 流中段上游挂起时 UI 会永久 busy（服务端 45s 超时只覆盖到响应头） */
      signal: AbortSignal.timeout(60_000),
      onDelta: () => {},
    });
    parsed = graduationSchema.parse(extractJson(full));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  /* 掌握分布展示顺序 = MASTERY_ORDER 倒序（最强在前），不再手抄一份等级表。
   * 计数取自全量 masteryCounts（不是截断后的 ctx.knowledgePoints），与目标页统计一致。 */
  const masterLine = `- 掌握分布：${[...MASTERY_ORDER].reverse()
    .map((m) => {
      const n = ctx.masteryCounts[m] ?? 0;
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
    `- 知识点：${ctx.knowledgePointsTotal} 条`,
    masterLine,
    "",
    "## 下一步（只是建议，不会自动创建）",
    ...parsed.nextSteps.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");

  /* 写进第二大脑：source=learn，带目标标题方便回溯；不自动排复习（结业笔记是"索引型"内容）。
   * 笔记按 goal.id（tag）关联而非 topic 字符串：topic 是自由文本，两个目标同 topic 时
   * 按标题查找会指错笔记，且 addKnowledge 按标题去重会静默丢弃第二份新生成的正文。 */
  const goalTag = `goal:${goal.id}`;
  const state = useAppStore.getState();
  const owned = state.knowledge.find((k) => (k.tags ?? []).includes(goalTag));
  let noteId = owned?.id;
  if (noteId) {
    useAppStore.getState().updateKnowledge(noteId, { body });
  } else {
    const title = `结业 · ${goal.topic}`;
    const clash = state.knowledge.some((k) => k.title === title);
    if (clash) {
      /* 同名结业笔记属于别的目标（删目标重建/双同 topic）：createKnowledge 的标题
       * 自动唯一，不会被 addKnowledge 的标题去重吞掉。 */
      const id = useAppStore.getState().createKnowledge({ title, domain: `${goal.topic}/结业` });
      useAppStore.getState().updateKnowledge(id, {
        body,
        source: "learn",
        sourceTitle: goal.topic,
        masteryStatus: "durable",
        tags: [goalTag],
      });
      noteId = id;
    } else {
      useAppStore.getState().addKnowledge(
        [{ title, body, domain: `${goal.topic}/结业`, masteryStatus: "durable" }],
        "learn",
        goal.topic
      );
      const created = useAppStore
        .getState()
        .knowledge.find((k) => k.title === title && k.sourceTitle === goal.topic);
      if (created) {
        useAppStore.getState().updateKnowledge(created.id, {
          tags: [...(created.tags ?? []), goalTag],
        });
      }
      noteId = created?.id;
    }
  }

  useAppStore.getState().updateGoal(goal.id, {
    needsGraduation: false,
    graduatedAt: new Date().toISOString(),
    graduationNoteId: noteId,
    nextSteps: parsed.nextSteps,
  });

  return { ok: true, noteId, nextSteps: parsed.nextSteps };
}
