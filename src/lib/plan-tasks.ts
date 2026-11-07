"use client";

/* ============================================================
 * 计划生成任务注册表（V26.1 P0：页面生命周期 ≠ 任务生命周期）
 *
 * 问题：总纲要/阶段目录生成是页面组件里的 streamChat，SPA 切页虽然
 * 不会杀死浮动的 Promise，但页面看不到"还在生成"，用户也无法知道
 * 结果何时落库；整页刷新更是彻底失联。
 *
 * 方案：模块级注册表（SPA 内切换页面存活）+ KV 状态持久化
 * （/api/tasks，整页刷新后仍可查询"这个目标的任务发生过、状态如何"）。
 * 页面通过 usePlanTask(goalId) 订阅：生成完成 → store 已自动更新 → UI 反映。
 * ============================================================ */

export type PlanTaskKind = "master" | "phase" | "day";
export type PlanTaskStatus = "running" | "completed" | "failed" | "interrupted";

export interface PlanTaskState {
  taskId: string;
  goalId: string;
  kind: PlanTaskKind;
  status: PlanTaskStatus;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

type Entry = {
  state: PlanTaskState;
  controller: AbortController;
  listeners: Set<(s: PlanTaskState) => void>;
};

const registry = new Map<string, Entry>(); // key = goalId

function emit(entry: Entry) {
  entry.state = { ...entry.state, updatedAt: new Date().toISOString() };
  for (const cb of entry.listeners) {
    try {
      cb(entry.state);
    } catch { /* 订阅者异常不影响任务 */ }
  }
  /* KV 状态持久化（fire-and-forget）：整页刷新后仍可查询任务发生过 */
  fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry.state),
    keepalive: true,
  }).catch(() => {});
}

export function startPlanTask(goalId: string, kind: PlanTaskKind): {
  taskId: string;
  signal: AbortSignal;
  finish: (error?: string) => void;
} {
  finishExisting(goalId, kind, "interrupted"); // 同目标同类任务只允许一个在跑
  const taskId = `pt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const entry: Entry = {
    state: {
      taskId, goalId, kind, status: "running",
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    controller,
    listeners: new Set(),
  };
  registry.set(goalId, entry);
  emit(entry);
  return {
    taskId,
    signal: controller.signal,
    finish: (error?: string) => {
      const e = registry.get(goalId);
      if (!e || e.state.taskId !== taskId) return;
      e.state.status = error ? "failed" : "completed";
      if (error) e.state.error = error.slice(0, 200);
      emit(e);
      registry.delete(goalId);
    },
  };
}

/** 页面卸载不应终止任务——但显式 stop 必须终止 */
export function cancelPlanTask(goalId: string): void {
  const e = registry.get(goalId);
  if (!e) return;
  e.controller.abort();
  e.state.status = "failed";
  e.state.error = "用户取消";
  emit(e);
  registry.delete(goalId);
}

export function getRunningPlanTask(goalId: string): PlanTaskState | null {
  return registry.get(goalId)?.state ?? null;
}

export function subscribePlanTask(goalId: string, cb: (s: PlanTaskState) => void): () => void {
  let entry = registry.get(goalId);
  if (!entry) {
    entry = { state: null as unknown as PlanTaskState, controller: new AbortController(), listeners: new Set() } as Entry;
    // 无在跑任务时返回空订阅（页面自己决定是否查 KV）
    return () => {};
  }
  entry.listeners.add(cb);
  cb(entry.state);
  return () => entry.listeners.delete(cb);
}

function finishExisting(goalId: string, kind: PlanTaskKind, status: PlanTaskStatus) {
  const e = registry.get(goalId);
  if (e && e.state.kind === kind && e.state.status === "running") {
    e.state.status = status;
    emit(e);
    registry.delete(goalId);
  }
}
