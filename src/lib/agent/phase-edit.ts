"use client";

/* ============================================================
 * 学习计划「讨论后精确修改」（第一批 P0 核心，PRD-SEC5/L04/L05）
 *
 * 结构：computePhaseEdit 负责「方案先预览、批准后应用」（AG-02/AG-03）——
 *   1. 把模型表达的编辑集（changes）计算成带差异的草稿（仅计算，不写业务数据）；
 *   2. 草稿可被展示、被逐项修改（只更新受影响的阶段 / 天）；
 *   3. 用户批准后 applyPhaseEdit 才写入 store（先快照进 planHistory，可恢复 AG-04）。
 *
 * 纪律：
 *   - 绝不在此文件里直接持久化；所有写都由调用方经 store 快照 + 结构变更动作完成。
 *   - 阶段内天目录变更按标题对齐旧 id（复用 phase-regen 的 alignPhaseDayIds），
 *     已完成天的记录、成绩、笔记关联不因重排消失（AG-04/EX-07）。
 *   - 草稿只更新选定部分；拒绝/取消不产生任何业务写入（EX-05）。
 * ============================================================ */
import { useAppStore } from "@/lib/store";
import { alignPhaseDayIds } from "./phase-regen";
import type { Goal, Phase, Plan } from "@/lib/types";

/** 模型表达的编辑集：只描述「要改成什么」，由 computePhaseEdit 算出影响。 */
export interface PhaseEditChanges {
  /** 阶段元信息修改（标题/目标/预估天数）——不影响天目录 */
  phaseMeta?: Record<string, Partial<Pick<Phase, "title" | "outcome" | "estDays">>>;
  /** 新的阶段顺序（phaseId 列表）。缺省=保持不变 */
  phaseOrder?: string[];
  /** 要删除的阶段 id（只删空阶段；有进度需显式确认，由调用方守卫） */
  removePhaseIds?: string[];
  /** 新增的阶段（追加到末尾） */
  addPhases?: { title: string; outcome?: string; estDays?: number }[];
  /** 针对某阶段重新出一版天目录（标题列表；会按标题对齐旧 id） */
  phaseCatalogs?: Record<string, { title: string; knowledgePoints?: string[] }[]>;
  /** 某阶段边界（范围说明）改写 */
  boundaryChanges?: Record<string, string>;
}

interface DayDiff {
  kept: string[];
  added: string[];
  removed: string[];
  /** 修改前/后的完整天标题序列（场景1：审批卡必须列出具体内容） */
  oldTitles: string[];
  newTitles: string[];
  /** 新目录逐条 id（沿用旧 id 或生成占位） */
  newDayIds: string[];
}

export interface PhaseEditDraft {
  goalId: string;
  changes: PhaseEditChanges;
  perPhase: {
    phaseId: string;
    phaseTitle: string;
    meta?: Record<string, string>;
    newBoundary?: string;
    dayDiff?: DayDiff;
  }[];
  phaseOrderChanged: boolean;
  addedPhaseTitles: string[];
  removedPhaseTitles: string[];
  /** 被删阶段里已完成的学日数量（>0 时审批卡必须告警，AG-04/EX-07） */
  removedCompletedDays: number;
  /** 批准时相关阶段的基线签名（R4/EX-15：执行前比对，检测期间是否被并发修改） */
  baseSignature: string;
  /** 影响评估（人类可读） */
  impactText: string;
}

export interface PhaseEditResult {
  ok: boolean;
  content: string;
  summary: string;
}

export type ComputeEditOutcome =
  | { ok: false; content: string; summary: string }
  | { ok: true; draft: PhaseEditDraft };

/** 规范化并校验编辑集：过滤无实际变化的项目；返回 cleaned 或错误信息 */
export function normalizeChanges(changes: PhaseEditChanges): { ok: true; changes: PhaseEditChanges } | { ok: false; error: string } {
  const c = changes;
  if (!c.phaseMeta && !c.phaseOrder && !c.removePhaseIds?.length && !c.addPhases?.length && !c.phaseCatalogs && !c.boundaryChanges) {
    return { ok: false, error: "没有可应用的修改内容。" };
  }
  const cleaned: PhaseEditChanges = {
    phaseMeta: c.phaseMeta ? Object.fromEntries(
      Object.entries(c.phaseMeta).filter(([, p]) => p && (p.title || p.outcome || typeof p.estDays === "number"))
    ) : undefined,
    phaseOrder: c.phaseOrder?.length ? [...c.phaseOrder] : undefined,
    removePhaseIds: c.removePhaseIds?.length ? [...c.removePhaseIds] : undefined,
    /* null 项守卫（与上面 phaseMeta 的 p && 同口径）：模型给出的数组里可能夹 null，
     * 直接 p.title 会抛 TypeError，把「没有可应用的修改内容」这类友好校验失败变成
     * 通用异常（runner 兜底成「工具执行失败：Cannot read properties of null」）。 */
    addPhases: c.addPhases?.length
      ? c.addPhases
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => ({ title: String(p.title ?? "").trim(), outcome: p.outcome, estDays: p.estDays }))
          .filter((p) => p.title)
      : undefined,
    phaseCatalogs: c.phaseCatalogs ? Object.fromEntries(
      Object.entries(c.phaseCatalogs).filter(
        ([, list]) => Array.isArray(list) && list.length && list.every((d) => d && String(d.title ?? "").trim())
      )
    ) : undefined,
    boundaryChanges: c.boundaryChanges ? Object.fromEntries(
      Object.entries(c.boundaryChanges).filter(([, b]) => typeof b === "string" && b.trim())
    ) : undefined,
  };
  const hasAny =
    cleaned.phaseMeta && Object.keys(cleaned.phaseMeta).length ||
    cleaned.phaseOrder !== undefined ||
    (cleaned.removePhaseIds?.length ?? 0) > 0 ||
    (cleaned.addPhases?.length ?? 0) > 0 ||
    cleaned.phaseCatalogs !== undefined && Object.keys(cleaned.phaseCatalogs).length > 0 ||
    cleaned.boundaryChanges !== undefined && Object.keys(cleaned.boundaryChanges).length > 0;
  if (!hasAny) return { ok: false, error: "没有可应用的修改内容。" };
  return { ok: true, changes: cleaned };
}

/** 计算一个阶段的天目录差异（纯函数，可单测）。旧 id 按标题对齐沿用（AG-04）。 */
export function diffPhaseDays(
  oldDayIds: string[],
  days: Record<string, { id: string; title: string }>,
  newTitles: string[]
): DayDiff {
  const aligned = alignPhaseDayIds(oldDayIds, days, newTitles);
  const newDayIds = newTitles.map((t, i) => aligned[i] || `day_${Math.random().toString(36).slice(2, 8)}`);
  /* 保留重复：阶段内出现同名天（如两个「复习」）时，Set 会把 3 天去重成 2 天，
   * 审批卡的「原 N 天」与「移出」清单随之失真——而审批卡正是用户做决定的依据。 */
  const oldTitles = oldDayIds.map((id) => days[id]?.title).filter((t): t is string => !!t);
  const norm = (t: string) => t.replace(/\s+/g, "");
  const kept = newTitles.filter((t) => oldTitles.some((o) => norm(o) === norm(t)));
  const added = newTitles.filter((t, i) => aligned[i] === "");
  /* 多重集差：新目录里保留了几次同名，就从旧清单里扣几次（不多扣、不少扣） */
  const keptCount = new Map<string, number>();
  for (const t of kept) keptCount.set(norm(t), (keptCount.get(norm(t)) ?? 0) + 1);
  const removed: string[] = [];
  for (const o of oldTitles) {
    const k = norm(o);
    const n = keptCount.get(k) ?? 0;
    if (n > 0) keptCount.set(k, n - 1);
    else removed.push(o);
  }
  return {
    kept,
    added,
    removed,
    oldTitles,
    newTitles,
    newDayIds,
  };
}

/** 相关阶段的基线签名：标题/目标/预估天数/边界/目录标题序列。
 *  R4/EX-15：草稿批准到执行之间若这些被改，必须检测到并拒绝旧批准。 */
export function planSignature(plan: Plan, phaseIds?: string[]): string {
  const ids = phaseIds?.length ? phaseIds : plan.phases.map((p) => p.id);
  return JSON.stringify(
    plan.phases
      .filter((p) => ids.includes(p.id))
      .map((p) => ({
        id: p.id,
        title: p.title,
        outcome: p.outcome,
        estDays: p.estDays ?? null,
        boundary: p.boundary ?? "",
        catalog: (p.catalog ?? []).map((c) => c.title),
      }))
  );
}

/** 核心：把编辑集计算成带差异与影响的草稿（只计算，不写盘）。 */
export function computePhaseEdit(goal: Goal, inputChanges: PhaseEditChanges): ComputeEditOutcome {
  const norm = normalizeChanges(inputChanges);
  if (!norm.ok) return { ok: false, content: norm.error, summary: "无有效修改" };
  const changes = norm.changes;
  const plan = goal.plan;
  if (!plan) return { ok: false, content: "该目标还没有计划，无法编辑阶段。", summary: "无计划" };

  const perPhase: PhaseEditDraft["perPhase"] = [];
  const touchedMeta = changes.phaseMeta ? Object.keys(changes.phaseMeta) : [];
  const touchedCatalog = changes.phaseCatalogs ? Object.keys(changes.phaseCatalogs) : [];
  const touchedBoundary = changes.boundaryChanges ? Object.keys(changes.boundaryChanges) : [];
  const touched = new Set([...touchedMeta, ...touchedCatalog, ...touchedBoundary]);
  const removedSet = new Set(changes.removePhaseIds ?? []);

  /* AG-01/AG-08：输入必须指向真实阶段——未知 ID 一律拒绝，不能「伪成功应用一个空方案」。
   * 删除的 ID 也必须在计划里真实存在。 */
  const knownIds = new Set(plan.phases.map((p) => p.id));
  const unknown = [...touched, ...removedSet].filter((id) => !knownIds.has(id));
  if (unknown.length) {
    return {
      ok: false,
      content: `方案引用了不存在的阶段：${[...new Set(unknown)].join("、")}。请确认阶段 id 后重试。`,
      summary: "阶段不存在",
    };
  }

  /* AG-03：顺序里不得重复引用同一阶段（否则会把同一阶段塞进列表多次）。 */
  if (changes.phaseOrder) {
    const seen = new Set<string>();
    const dup = changes.phaseOrder.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    if (dup.length) {
      return { ok: false, content: `阶段顺序里重复引用了：${[...new Set(dup)].join("、")}。请每个阶段只出现一次。`, summary: "顺序重复" };
    }
    const missing = changes.phaseOrder.filter((id) => !knownIds.has(id));
    if (missing.length) {
      return { ok: false, content: `阶段顺序引用了不存在的阶段：${missing.join("、")}。`, summary: "阶段不存在" };
    }
  }

  for (const pid of plan.phases.map((p) => p.id)) {
    if (removedSet.has(pid)) continue;
    const ph = plan.phases.find((p) => p.id === pid)!;
    if (!touched.has(pid)) continue;
    const entry: (typeof perPhase)[number] = { phaseId: pid, phaseTitle: ph.title };
    if (changes.phaseMeta?.[pid]) {
      const m = changes.phaseMeta[pid];
      const meta: Record<string, string> = {};
      if (m.title && m.title !== ph.title) meta["标题"] = `${ph.title} → ${m.title}`;
      if (m.outcome && m.outcome !== ph.outcome) meta["阶段目标"] = `${ph.outcome.trim() || "（原无）"} → ${m.outcome}`;
      if (typeof m.estDays === "number" && m.estDays !== ph.estDays) meta["预估天数"] = `${ph.estDays ?? "未定"} → ${m.estDays} 天`;
      entry.meta = meta;
    }
    if (changes.boundaryChanges?.[pid]) {
      entry.newBoundary = changes.boundaryChanges[pid];
    }
    if (changes.phaseCatalogs?.[pid]) {
      entry.dayDiff = diffPhaseDays(ph.dayIds, plan.days, changes.phaseCatalogs[pid].map((d) => d.title));
    }
    perPhase.push(entry);
  }

  /* 阶段顺序变化判定 */
  const phaseOrderChanged = !!changes.phaseOrder && changes.phaseOrder.join("|") !== plan.phases.map((p) => p.id).join("|");
  const addedPhaseTitles = (changes.addPhases ?? []).map((p) => p.title);
  const removedPhaseTitles = (changes.removePhaseIds ?? [])
    .map((id) => plan.phases.find((p) => p.id === id)?.title)
    .filter((t): t is string => !!t);

  /* 被删阶段里的已完成天：AG-04 要求删除前明确告知影响（天对象保留，但不再计入当前路线） */
  let removedCompletedDays = 0;
  for (const pid of changes.removePhaseIds ?? []) {
    const ph = plan.phases.find((p) => p.id === pid);
    if (!ph) continue;
    removedCompletedDays += ph.dayIds.filter((id) => {
      const d = plan.days[id];
      return d && (d.status === "passed" || d.status === "skipped");
    }).length;
  }

  /* 影响评估（给审批卡与模型看）。PRD §5.3：至少显示目标项目、受影响阶段、原内容与新内容。
   * 场景1 要求：列出修改前后的具体内容，不能只报「新增几天、移除几天」。 */
  const lines: string[] = [];
  for (const e of perPhase) {
    if (e.meta && Object.keys(e.meta).length) lines.push(`阶段「${e.phaseTitle}」：${Object.values(e.meta).join("；")}`);
    if (e.newBoundary) lines.push(`阶段「${e.phaseTitle}」边界 → 「${e.newBoundary}」`);
    if (e.dayDiff) {
      const d = e.dayDiff;
      const before = e.dayDiff.oldTitles;
      const after = e.dayDiff.newTitles;
      lines.push(
        `阶段「${e.phaseTitle}」目录（原 ${before.length} 天 → 新 ${after.length} 天）：`
      );
      lines.push(`  原：${before.join("、") || "（空）"}`);
      lines.push(`  新：${after.join("、") || "（空）"}`);
      if (d.kept.length) lines.push(`  保留（沿用原 id、进度不丢）：${d.kept.join("、")}`);
      if (d.added.length) lines.push(`  新增：${d.added.join("、")}`);
      if (d.removed.length) lines.push(`  移出当前路线（成绩/笔记保留）：${d.removed.join("、")}`);
    }
  }
  if (phaseOrderChanged) {
    const nameOf = (id: string) => plan.phases.find((p) => p.id === id)?.title ?? id;
    lines.push(
      `阶段顺序：${plan.phases.map((p) => p.title).join(" > ")} → ${changes.phaseOrder!.map(nameOf).join(" > ")}`
    );
  }
  if (removedPhaseTitles.length) {
    lines.push(
      `删除阶段：${removedPhaseTitles.join("、")}` +
        (removedCompletedDays > 0
          ? `（⚠ 其中 ${removedCompletedDays} 个已完成的学习日将从当前路线移除，成绩与笔记保留、可追溯）`
          : "")
    );
  }
  if (addedPhaseTitles.length) lines.push(`新增阶段：${addedPhaseTitles.join("、")}`);

  /* 基线签名覆盖：被触及/被删除的阶段 + **顺序编辑时的全部阶段**。
   * R4/EX-15 承诺「批准到执行之间被并发修改则拒绝」：planSignature 的 JSON 顺序就是
   * plan.phases 的顺序，只签名 touched 会让「调整顺序 + 改某阶段标题」的混合草稿漏掉
   * 「order 里但未被 meta 触及」的阶段——另一标签页重排这些阶段时签名仍相等，
   * applyPhaseEdit 会按过期顺序覆盖最新结构。 */
  const signatureIds = changes.phaseOrder
    ? plan.phases.map((p) => p.id)
    : [...touched, ...removedSet];
  return {
    ok: true,
    draft: {
      goalId: goal.id,
      changes,
      perPhase,
      phaseOrderChanged,
      addedPhaseTitles,
      removedPhaseTitles,
      removedCompletedDays,
      baseSignature: planSignature(plan, signatureIds),
      impactText: lines.join("\n") || "（空方案）",
    },
  };
}

/** 草稿的可读预览（审批卡 / 学习页展示用）。 */
export function summarizeDraft(d: PhaseEditDraft): string {
  return d.impactText;
}

/** 把草稿应用到 store（先快照，再结构变更）。调用方必须已取得用户批准。
 *  R1：边界修改独立写入（不再依赖是否有天目录变更）。
 *  R2：任何结构变更（删除/排序/增删阶段）先做整计划快照。
 *  R4：执行前比对基线签名，期间被并发修改则拒绝，不静默覆盖（EX-15）。 */
export function applyPhaseEdit(draft: PhaseEditDraft): PhaseEditResult {
  const store = useAppStore.getState();
  const goal = store.goals.find((g) => g.id === draft.goalId);
  if (!goal?.plan) return { ok: false, content: "目标已不存在。", summary: "未找到" };

  try {
    /* 0) R4：冲突检测——相关阶段在批准后被改过就拒绝，让用户重新决定。
     * 签名集合必须与 computePhaseEdit 写 baseSignature 时完全一致（顺序编辑时是全阶段），
     * 否则「调顺序 + 改标题」的混合草稿会漏检未被 meta 触及的阶段。 */
    const touchedIds = draft.changes.phaseOrder
      ? goal.plan.phases.map((p) => p.id)
      : [...new Set([...draft.perPhase.map((e) => e.phaseId), ...(draft.changes.removePhaseIds ?? [])])];
    const nowSig = planSignature(goal.plan, touchedIds);
    if (draft.baseSignature && nowSig !== draft.baseSignature) {
      return {
        ok: false,
        content:
          "检测到冲突：方案展示之后，这些阶段已被修改（可能是另一个标签页或另一处操作）。为避免覆盖你的新改动，本次未应用。\n" +
          "请重新生成方案：再描述一次你想怎么改，我会基于最新内容重新展示差异，确认后再应用。",
        summary: "检测到冲突",
      };
    }

    /* 1) 快照。结构变更（增删/排序）无法用单阶段表达 → 整计划快照（R2）；
     *    纯元信息/目录/边界改动 → 逐阶段快照（保留既有粒度）。 */
    const hasStructural = !!(
      draft.changes.removePhaseIds?.length ||
      draft.changes.addPhases?.length ||
      draft.phaseOrderChanged
    );
    if (hasStructural) {
      store.snapshotPlan(draft.goalId, "计划结构修改", draft.perPhase[0]?.phaseId);
    }
    for (const e of draft.perPhase) {
      store.snapshotPhase(draft.goalId, e.phaseId, "方案修改");
    }

    /* 2) 阶段元信息（R3：与快照同源，恢复时可还原）。
     *    只写真正变化的字段：每个 store 动作都会 structuredClone 整个 plan（连同 MB 级
     *    讲义/答疑缓存），无变化的调用是纯浪费——一次批准可能冻结 UI 数百 ms。 */
    for (const e of draft.perPhase) {
      const meta = draft.changes.phaseMeta?.[e.phaseId];
      if (!meta) continue;
      const curPhase = useAppStore.getState().goals.find((g) => g.id === draft.goalId)
        ?.plan?.phases.find((p) => p.id === e.phaseId);
      if (!curPhase) continue;
      const patch: { title?: string; outcome?: string; estDays?: number } = {};
      if (meta.title !== undefined && meta.title !== curPhase.title) patch.title = meta.title;
      if (meta.outcome !== undefined && meta.outcome !== curPhase.outcome) patch.outcome = meta.outcome;
      if (typeof meta.estDays === "number" && meta.estDays !== curPhase.estDays) patch.estDays = meta.estDays;
      if (Object.keys(patch).length) store.updatePhaseMeta(draft.goalId, e.phaseId, patch);
    }

    /* 3) 边界（R1）：独立写入，不依赖是否同时改了天目录。无变化不写（同上）。 */
    for (const e of draft.perPhase) {
      const boundary = draft.changes.boundaryChanges?.[e.phaseId];
      if (boundary === undefined) continue;
      const curPhase = useAppStore.getState().goals.find((g) => g.id === draft.goalId)
        ?.plan?.phases.find((p) => p.id === e.phaseId);
      if (curPhase && curPhase.boundary === boundary) continue;
      store.updatePhaseBoundary(draft.goalId, e.phaseId, boundary);
    }

    /* 4) 阶段天目录（重出一版目录，按标题对齐旧 id）。边界已在上一步写入，此处只更新目录 */
    for (const e of draft.perPhase) {
      const catalog = draft.changes.phaseCatalogs?.[e.phaseId];
      if (!catalog || !e.dayDiff) continue;
      const curBoundary = useAppStore
        .getState()
        .goals.find((g) => g.id === draft.goalId)
        ?.plan?.phases.find((p) => p.id === e.phaseId)?.boundary;
      store.setPhaseCatalog(
        draft.goalId,
        e.phaseId,
        curBoundary ?? "",
        catalog.map((d, i) => ({
          id: e.dayDiff!.newDayIds[i],
          title: d.title,
          knowledgePoints: d.knowledgePoints ?? [],
        }))
      );
    }

    /* 5) 阶段顺序 + 增删阶段。纯元信息/目录/边界编辑不需要整替阶段列表——
     *    旧实现无条件 replacePhases，等于再对整个 plan 做一次 structuredClone。 */
    if (hasStructural) {
      const cur = useAppStore.getState().goals.find((g) => g.id === draft.goalId);
      if (cur?.plan) {
        let phases = [...cur.plan.phases];
        if (draft.changes.removePhaseIds?.length) {
          phases = phases.filter((p) => !draft.changes.removePhaseIds!.includes(p.id));
        }
        if (draft.changes.addPhases?.length) {
          const base = phases.length ? phases[phases.length - 1].id : "ph_a";
          const lastIdx = phases.reduce((m, p, i) => Math.max(m, i + 1), 0);
          const withAdded = draft.changes.addPhases.map((ap, i) => ({
            id: `${base}_${lastIdx}${i}`,
            title: ap.title,
            outcome: ap.outcome ?? "",
            dayIds: [],
            status: "locked" as const,
            estDays: ap.estDays,
          }));
          phases = [...phases, ...withAdded];
        }
        if (draft.changes.phaseOrder) {
          /* R5：已在校验层拒绝重复 ID；此处用 Set 再兜底，保证不重复 */
          const byId = new Map(phases.map((p) => [p.id, p]));
          const seen = new Set<string>();
          const ordered: Phase[] = [];
          for (const id of draft.changes.phaseOrder) {
            const p = byId.get(id);
            if (p && !seen.has(id)) {
              seen.add(id);
              ordered.push(p);
            }
          }
          const leftover = phases.filter((p) => !seen.has(p.id));
          phases = [...ordered, ...leftover];
        }
        store.replacePhases(draft.goalId, phases);
      }
    }

    return { ok: true, content: `已应用方案。\n${draft.impactText}\n（修改前版本已存入历史，可在学习页恢复）`, summary: "已应用" };
  } catch (e) {
    return { ok: false, content: `应用失败：${e instanceof Error ? e.message : "未知错误"}`, summary: "失败" };
  }
}