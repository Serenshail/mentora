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
  /** 运行期心跳定时器：周期性 emit 刷新 updatedAt（本地 + KV）。
   *  旧实现 updatedAt 只在 start/finish 时写——切页 3 分钟后回来，还活着的任务
   *  也会被 /learn/new 的 180s 陈旧阈值误判为「被刷新中断」，误导性 toast 诱发
   *  重复生成、双倍 AI 计费。心跳让「updatedAt 鲜度」真正代表任务存活。 */
  heartbeat: ReturnType<typeof setInterval> | null;
};

const registry = new Map<string, Entry>(); // key = goalId

/** 心跳间隔：45s。180s 陈旧阈值 = 连续 4 拍未续期才判死，网络抖动漏一两拍不误报 */
const HEARTBEAT_MS = 45_000;

function startHeartbeat(entry: Entry) {
  entry.heartbeat = setInterval(() => {
    if (entry.state.status !== "running") return;
    emit(entry);
  }, HEARTBEAT_MS);
  /* Node 环境（vitest/SSR）下 unref，别让挂起的定时器钉住进程退出 */
  (entry.heartbeat as unknown as { unref?: () => void }).unref?.();
}

function stopHeartbeat(entry: Entry) {
  if (entry.heartbeat) {
    clearInterval(entry.heartbeat);
    entry.heartbeat = null;
  }
}

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
    heartbeat: null,
  };
  registry.set(goalId, entry);
  emit(entry);
  startHeartbeat(entry);
  return {
    taskId,
    signal: controller.signal,
    finish: (error?: string) => {
      const e = registry.get(goalId);
      if (!e || e.state.taskId !== taskId) return;
      stopHeartbeat(e);
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
  stopHeartbeat(e);
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
  const entry = registry.get(goalId);
  if (!entry) {
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
    stopHeartbeat(e);
    /* 旧流必须真停：旧实现只改状态不 abort——被顶掉的 streamChat 继续烧 token，
     * 且其 finish() 因 taskId 不匹配变成 no-op，同目标双流并发、双倍计费 */
    e.controller.abort();
    e.state.status = status;
    emit(e);
    registry.delete(goalId);
  }
}
