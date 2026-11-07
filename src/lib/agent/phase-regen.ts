"use client";

/* ============================================================
 * 阶段重排（V26.1 P0-B7/B11）：学习计划某阶段不满意时的结构级修改。
 * 三条路径共用一个纯函数入口：
 *   1. 主对话框 agent 工具 regenerate_phase（审批卡确认）
 *   2. 学习页阶段卡「重排本阶段」按钮（带完成日守卫）
 *   3. 恢复场景（goal 存在但 catalog 缺失时走原 ensure 流程）
 *
 * 纪律（PRD §5.2 修改规则）：
 *   - 只动目标阶段；其他阶段、已完成记录不动（setPhaseCatalog 只覆盖该阶段 days）。
 *   - 有已完成日的阶段必须 force=true 才允许重排（UI 先弹确认）。
 *   - 重排后旧 catalog 丢弃、天回到 stub 态——已完成记录按 store 语义保留成绩但重置结构。
 * ============================================================ */
import { streamChat, phaseListSchema, extractJson } from "@/lib/ai/client";
import { useAppStore } from "@/lib/store";
import type { Goal } from "@/lib/types";

export interface PhaseRegenResult {
  ok: boolean;
  content: string;
  summary: string;
}

/** 从 goal/phase 构造与学习页 genCtx 同格式的 ctx（主对话框拿不到页面闭包，独立构造） */
function buildPhaseCtx(goal: Goal, phaseId: string, userNote: string): { ctx: string; maxDays: number } | null {
  const plan = goal.plan;
  const phase = plan?.phases.find((ph) => ph.id === phaseId);
  if (!plan || !phase) return null;
  const days = Object.values(plan.days);
  const mastered = days
    .filter((d) => d.status === "passed" || d.status === "skipped")
    .flatMap((d) => d.knowledgePoints.map((k) => k.text));
  const weakPoints = goal.quizLog
    .filter((q) => !q.passed)
    .slice(0, 5)
    .flatMap((q) => {
      const d = plan.days[q.dayId];
      return d ? [`${d.title}（${q.items.filter((i) => i.verdict === "incorrect").length} 题未过）`] : [];
    });
  const maxDays = Math.min(Math.max(phase.estDays ?? 6, 2), 8);
  const oldDays = (phase.catalog ?? []).map((c) => c.title);
  const ctx = JSON.stringify({
    goal: {
      topic: goal.topic,
      direction: goal.direction,
      background: goal.background,
      domainKind: goal.domainKind,
      weeklyHours: goal.weeklyHours,
    },
    phase: {
      title: phase.title,
      outcome: phase.outcome,
      estDays: phase.estDays,
      oldDayTitles: oldDays,
    },
    mastered,
    weakPoints,
    userNote,
  });
  return { ctx, maxDays };
}

/** 有多少已完成/跳过的天（UI 决定是否弹确认 + 审批卡警告文案） */
export function countCompletedDays(goalId: string, phaseId: string): number {
  const goal = useAppStore.getState().goals.find((g) => g.id === goalId);
  const phase = goal?.plan?.phases.find((ph) => ph.id === phaseId);
  if (!goal?.plan || !phase) return 0;
  return phase.dayIds.filter((id) => {
    const d = goal.plan!.days[id];
    return d && (d.status === "passed" || d.status === "skipped");
  }).length;
}

/**
 * 重排一个阶段的天级目录（结构性修改）。
 * force=true 时忽略已完成日守卫（UI 已确认过）；dayIds 里已存在的天按顺序沿用 id 以保留记录引用。
 */
export async function regeneratePhase(
  goalId: string,
  phaseId: string,
  userNote: string,
  force = false
): Promise<PhaseRegenResult> {
  const store = useAppStore.getState();
  const goal = store.goals.find((g) => g.id === goalId);
  const phase = goal?.plan?.phases.find((ph) => ph.id === phaseId);
  if (!goal?.plan || !phase) {
    return { ok: false, content: "没有找到目标或阶段。", summary: "未找到" };
  }
  const completed = countCompletedDays(goalId, phaseId);
  if (completed > 0 && !force) {
    return {
      ok: false,
      content: `该阶段已有 ${completed} 个完成/跳过的学习日。重排会改变结构——请确认后再执行（UI 会先弹确认）。`,
      summary: "需确认",
    };
  }
  const built = buildPhaseCtx(goal, phaseId, userNote);
  if (!built) return { ok: false, content: "阶段数据异常。", summary: "数据异常" };

  try {
    const { streamChat } = await import("@/lib/ai/client");
    const raw = await streamChat({
      task: "plan",
      args: { mode: "phase-list", ctx: built.ctx, maxDays: built.maxDays },
      messages: [{ role: "user", content: `用户对这个阶段不满意（${userNote || "想换一批角度"}），请重新输出这个阶段的学习日目录（最多 ${built.maxDays} 天，只要 JSON）。不要重复旧目录的切分角度。` }],
      temperature: 0.5,
      onDelta: () => {},
    });
    const list = phaseListSchema.parse(extractJson(raw));
    const boundary = list.boundary?.trim() || phase.boundary || "";
    const days = list.days.slice(0, built.maxDays);
    if (days.length === 0) return { ok: false, content: "模型返回了空目录，未做任何修改。", summary: "空目录" };

    /* setPhaseCatalog 保留已完成天的成绩（store 语义：按 title 保留 quizLog 引用），
     * 结构重置为 stub——用户重进后逐天重新展开。 */
    store.setPhaseCatalog(
      goalId,
      phaseId,
      boundary,
      days.map((d) => ({
        id: `day_${Math.random().toString(36).slice(2, 8)}`,
        title: d.title,
        knowledgePoints: d.knowledgePoints.map((k) => (typeof k === "string" ? k : k.text)),
      }))
    );
    return {
      ok: true,
      content: `「${phase.title}」已重排为 ${days.length} 天：${days.map((d) => d.title).join("、")}。旧的阶段目录已替换，逐天内容会在你进入该天时重新展开。`,
      summary: `${days.length} 天`,
    };
  } catch (e) {
    return { ok: false, content: `重排失败：${e instanceof Error ? e.message : "未知错误"}——原目录未动。`, summary: "失败" };
  }
}
