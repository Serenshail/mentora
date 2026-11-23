"use client";

/* ============================================================
 * 阶段重排（V26.1 P0-B7/B11）：学习计划某阶段不满意时的结构级修改。
 * 三条路径共用一个纯函数入口：
 *   1. 主对话框 agent 工具 regenerate_phase（审批卡确认）
 *   2. 学习页阶段卡「重排本阶段」按钮（带完成日守卫）
 *   3. 恢复场景（goal 存在但 catalog 缺失时走原 ensure 流程）
 *
 * 纪律（PRD §5.2 修改规则 / §6.4 版本留痕）：
 *   - 只动目标阶段；其他阶段、已完成记录不动（setPhaseCatalog 只覆盖该阶段 days）。
 *   - 有已完成日的阶段必须 force=true 才允许重排（UI 先弹确认）。
 *   - 重排前快照旧目录进 goal.planHistory（V26.2-H5）；标题匹配的天沿用旧 id，
 *     成绩/quizLog 引用与「已完成 N 天」显示保留；旧天对象绝不删除。
 * ============================================================ */
import { streamChat, phaseListSchema, extractJson } from "@/lib/ai/client";
/* streamChat 用静态导入：同模块的 phaseListSchema/extractJson 已静态引入，
 * 函数内再 await import 同一模块不产生代码分割收益。 */
import { useAppStore } from "@/lib/store";
import { beginRequest, checkBudget, endRequest, type UsageSource } from "./request-ledger";
import type { Goal } from "@/lib/types";

export interface PhaseRegenResult {
  ok: boolean;
  content: string;
  summary: string;
}

/** 重排进度回调（学习页把 thinking 透到 bgGen，等待期才有「模型思考中」反馈） */
export interface PhaseRegenHooks {
  onThink?: () => void;
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
  /* quizLog 类型上必填，但仓库里 4 处消费点都做了空值防御（app-context.ts:28、
   * study-heatmap.tsx、life-workspace.tsx、graduation.ts）——migrateState 不给旧数据补
   * 该字段，旧版 localStorage 重 hydration 后可为 undefined。此处不设防会抛 TypeError，
   * 且本函数在 regeneratePhase 的 try 之外调用，异常会绕过「重排失败：…原目录未动」。 */
  const weakPoints = (goal.quizLog ?? [])
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
 * V26.2-H5：新目录与旧天按标题对齐——标题匹配的天沿用旧 id，
 * quizLog/成绩引用与「已完成 N 天」显示因此保留（PRD §6.4：不得因重排清空进度）。
 * 未匹配的新天返回 ""（由调用方生成新 id，进入时按 stub 展开）。纯函数可单测。
 */
export function alignPhaseDayIds(
  oldDayIds: string[],
  days: Record<string, { id: string; title: string }>,
  newTitles: string[]
): string[] {
  const norm = (t: string) => t.replace(/\s+/g, "");
  const byTitle = new Map<string, string>();
  for (const id of oldDayIds) {
    const d = days[id];
    if (!d) continue;
    const k = norm(d.title);
    if (!byTitle.has(k)) byTitle.set(k, id);
  }
  const used = new Set<string>();
  return newTitles.map((t) => {
    const hit = byTitle.get(norm(t));
    if (hit && !used.has(hit)) {
      used.add(hit);
      return hit;
    }
    return "";
  });
}

/**
 * 重排一个阶段的天级目录（结构性修改）。
 * force=true 时忽略已完成日守卫（UI 已确认过）。
 * V26.2-H5 纪律：重排前快照旧目录进 goal.planHistory（可回看，最多 5 次）；
 * 标题匹配的天沿用旧 id（成绩/quizLog 引用与完成状态保留），其余按新 id stub 展开；
 * 旧天对象从不删除——未匹配的成为孤儿数据留在 plan.days，绝不丢用户记录。
 */
export async function regeneratePhase(
  goalId: string,
  phaseId: string,
  userNote: string,
  force = false,
  signal?: AbortSignal,
  hooks?: PhaseRegenHooks
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
  try {
    /* 构造 ctx 也放进 try：它对旧数据（quizLog 缺失、天的 knowledgePoints 畸形）
     * 可能抛错，落在 try 外会绕过下面「重排失败：…原目录未动」的错误路径。 */
    const built = buildPhaseCtx(goal, phaseId, userNote);
    if (!built) return { ok: false, content: "阶段数据异常。", summary: "数据异常" };
    /* 真实 provider 请求必须记账（request-ledger v2 承诺「任一触顶即拒绝」）：
     * 全仓库此前只有 runner.chat() 走 checkBudget/beginRequest，本路径与 run_discussion
     * 等工具触发的调用都绕过了账本——用户看到的「provider 上限」对它们不成立。 */
    const identity = { userId: store._storeUserId ?? null, sessionId: `phase:${goalId}`, runId: `regen:${phaseId}` };
    const gate = checkBudget({ ...identity, task: "plan", layer: "provider" });
    if (!gate.ok) return { ok: false, content: gate.reason, summary: "已达上限" };
    const rec = beginRequest({ ...identity, task: "plan", round: 0, layer: "provider" });
    /* 显式类型：TS 会把「只在回调里赋值」的变量收窄成 never（与 runner.ts 同款写法） */
    let usage = null as null | { inputTokens?: number; outputTokens?: number; cachedTokens?: number };
    let raw: string;
    try {
      raw = await streamChat({
        task: "plan",
        args: { mode: "phase-list", ctx: built.ctx, maxDays: built.maxDays },
        messages: [{ role: "user", content: `用户对这个阶段不满意（${userNote || "想换一批角度"}），请重新输出这个阶段的学习日目录（最多 ${built.maxDays} 天，只要 JSON）。不要重复旧目录的切分角度。` }],
        temperature: 0.5,
        signal, // agent 审批后执行路径透传（学习页按钮路径不传，行为不变）
        /* 等待反馈：整段目录生成可达数十秒，此前 onDelta 为空函数、无 onThink，
         * 学习页只能干等一条几秒即消失的 toast。透传思考心跳给 UI。 */
        onDelta: () => {},
        onThink: () => hooks?.onThink?.(),
        onUsage: (u) => { usage = u; },
      });
    } catch (e) {
      const aborted = !!signal?.aborted || (e instanceof Error && e.name === "AbortError");
      endRequest(rec.id, { ok: false, error: aborted ? "cancelled" : e instanceof Error ? e.message : "unknown" });
      throw e;
    }
    const src: UsageSource = usage ? "provider" : "unknown";
    endRequest(rec.id, {
      ok: true,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedTokens: usage?.cachedTokens,
      usageSource: src,
    });
    const list = phaseListSchema.parse(extractJson(raw));
    /* 模型返回后**重验**目标与阶段：await 期间（可达数十秒）用户可能在另一标签页/
     * 学习页删除了该阶段或整目标。store 的 setPhaseCatalog/snapshotPhase 对不存在的
     * goal/phase 一律静默 no-op，若此处仍用旧快照写入并返回 ok:true，就是谎报成功。
     * 顺带用最新 goal.plan.days 对齐旧 id（旧快照的天表可能已过期）。 */
    const fresh = useAppStore.getState().goals.find((g) => g.id === goalId);
    const freshPhase = fresh?.plan?.phases.find((ph) => ph.id === phaseId);
    if (!fresh?.plan || !freshPhase) {
      return { ok: false, content: "重排期间该阶段（或所属目标）已被删除，本次结果未写入——原数据未动。", summary: "阶段已不存在" };
    }
    const boundary = list.boundary?.trim() || freshPhase.boundary || "";
    const days = list.days.slice(0, built.maxDays);
    if (days.length === 0) return { ok: false, content: "模型返回了空目录，未做任何修改。", summary: "空目录" };

    /* V26.2-H5：重排前快照旧目录（PRD §6.4 版本留痕），然后按标题对齐沿用旧 id。 */
    store.snapshotPhase(goalId, phaseId, userNote || "阶段重排");
    const aligned = alignPhaseDayIds(
      freshPhase.dayIds,
      fresh.plan.days,
      days.map((d) => d.title)
    );
    store.setPhaseCatalog(
      goalId,
      phaseId,
      boundary,
      days.map((d, i) => ({
        id: aligned[i] || `day_${Math.random().toString(36).slice(2, 8)}`,
        title: d.title,
        knowledgePoints: d.knowledgePoints.map((k) => (typeof k === "string" ? k : k.text)),
      }))
    );
    return {
      ok: true,
      content: `「${freshPhase.title}」已重排为 ${days.length} 天：${days.map((d) => d.title).join("、")}。旧的阶段目录已替换，逐天内容会在你进入该天时重新展开。`,
      summary: `${days.length} 天`,
    };
  } catch (e) {
    /* 用户取消与真实失败要区分（UI 据此显示「已取消」而非错误）。 */
    const aborted = !!signal?.aborted || (e instanceof Error && e.name === "AbortError");
    return {
      ok: false,
      content: aborted ? "已取消重排——原目录未动。" : `重排失败：${e instanceof Error ? e.message : "未知错误"}——原目录未动。`,
      summary: aborted ? "已取消" : "失败",
    };
  }
}
