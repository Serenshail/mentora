import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 取消终态不得伪装成功（回归锁，v3 会话级运行态） ============
 * 背景：runAgent 的取消路径是正常 resolve —— runner.ts 在 full === null / signal.aborted
 * 时先 cb.onPhase("cancelled") 再 return answer()。因此用户点「停止」走的是 send() 的
 * **成功分支**，那里若无条件把 running 阶段标 done，折叠摘要就会渲染绿勾 +「回答中」，
 * 取消态完全不可见，违反「失败/取消明确标出，不伪装成功」。
 *
 * v3 把终态算成 run.status（cancelled/partial/completed/failed），由运行管理器承载；
 * tracePhasesOf 只从真实事件推阶段，取消时不产生绿勾。 */

import { useRuntimeStore, cancelRun, tracePhasesOf, describeHeadline, isInFlight, type SessionRun } from "../agent/session-runtime";

function mkRun(over: Partial<SessionRun> = {}): SessionRun {
  return {
    runId: "r1",
    sessionId: "sA",
    seq: 1,
    status: "generating",
    phase: "answering",
    startedAt: 1_000,
    headline: "",
    plan: [],
    tools: [],
    phases: [],
    partialAnswer: "已经流出的一半",
    pendingActions: [],
    ...over,
  };
}

beforeEach(() => {
  cancelRun("sA", "switch");
  useRuntimeStore.getState().dropSession("sA");
});

describe("取消/失败终态的轨迹与摘要", () => {
  it("停止先把状态置为 cancelling（UI 立刻有反馈），再落 cancelled", () => {
    useRuntimeStore.getState().startRun("sA", mkRun());
    cancelRun("sA", "user");
    // cancelRun 内已把在途 run 标 cancelling（真实 UI 在 200ms 内即可读到）
    expect(useRuntimeStore.getState().views.sA.run!.status).toBe("cancelling");
  });

  it("cancelled 的轨迹不含「回答中 completed」绿勾", () => {
    const phases = tracePhasesOf(mkRun({ status: "cancelled", finishedAt: 5_000, partialAnswer: "" }));
    const answering = phases.find((p) => p.label === "回答中")!;
    expect(answering.state).toBe("cancelled");
    expect(phases.some((p) => p.label === "回答中" && p.state === "done")).toBe(false);
  });

  it("failed 的轨迹明确标红，不冒充完成", () => {
    const phases = tracePhasesOf(mkRun({ status: "failed", finishedAt: 5_000 }));
    expect(phases.find((p) => p.label === "回答中")!.state).toBe("failed");
  });

  it("completed 才出现 done 与真实耗时", () => {
    const phases = tracePhasesOf(mkRun({ status: "completed", finishedAt: 5_000, firstDeltaAt: 2_000 }));
    const answering = phases.find((p) => p.label === "回答中")!;
    expect(answering.state).toBe("done");
    expect(answering.durationMs).toBe(3_000);
  });

  it("摘要行按终态如实表述", () => {
    expect(describeHeadline(mkRun({ status: "cancelling" }))).toBe("正在停止…");
    expect(describeHeadline(mkRun({ status: "failed", error: "上游 500" }))).toContain("上游 500");
    expect(describeHeadline(mkRun({ status: "awaiting_approval", pendingActions: [{ id: "a", kind: "edit_phase", label: "编辑计划", summary: "", payload: {} }] }))).toContain("编辑计划");
  });

  it("只有心跳、还没有任何证据时，摘要只说等待（PRD §5.2 禁止空转标签）", () => {
    /* 不得出现「正在理解你的问题/正在分析/正在思考」这类没有证据的猜测 */
    for (const phase of ["thinking", "acting"] as const) {
      const h = describeHeadline(mkRun({ partialAnswer: "", plan: [], tools: [], phase }));
      expect(h).toBe("正在等待模型响应");
      expect(h).not.toMatch(/理解你的问题|正在分析|正在思考/);
    }
    /* 正文真流出来了才允许说「正在回答」 */
    expect(describeHeadline(mkRun({ partialAnswer: "半句", plan: [], tools: [], phase: "answering" }))).toBe("正在回答…");
  });

  it("isInFlight 覆盖 queued/preparing/generating/executing/awaiting/cancelling，不含终态", () => {
    for (const s of ["queued", "preparing", "generating", "executing_tool", "awaiting_approval", "cancelling"] as const) {
      expect(isInFlight(s)).toBe(true);
    }
    for (const s of ["completed", "partial", "failed", "cancelled", "interrupted"] as const) {
      expect(isInFlight(s)).toBe(false);
    }
  });
});

/* ---- 组件侧锚点 ---- */
const SRC = readFileSync(
  fileURLToPath(new URL("../../components/agent-home.tsx", import.meta.url)),
  "utf8"
);

describe("AgentHome 取消终态接线", () => {
  it("onPhase 把取消标记写进按会话隔离的 run 快照（P1-3）", () => {
    expect(SRC).toMatch(/onPhase: \(ph\) => \{/);
    expect(SRC).toMatch(/cancelled: ph === "cancelled" \? true : cur\?\.cancelled/);
    /* 反向断言：不得再用组件级 ref（跨会话污染——A 停止后 B 会被误标已停止） */
    expect(SRC).not.toMatch(/cancelledRef/);
  });

  it("收尾状态由 run.cancelled / ac.signal 推导，而不是无条件 completed", () => {
    expect(SRC).toMatch(/const cancelled = !!runAtEnd\?\.cancelled \|\| ac\.signal\.aborted;/);
    expect(SRC).toMatch(/cancelled \? "cancelled" : partial \? "partial" : "completed"/);
  });

  it("onPhase 同时推动状态机流转（preparing → generating/executing_tool，P2-8）", () => {
    expect(SRC).toMatch(/ph === "acting" \? "executing_tool" : "generating"/);
  });
});
