import { describe, expect, it, beforeEach } from "vitest";

/* ============ 审批门按会话归属：切会话不得销毁审批卡（回归锁，v3） ============
 * 背景：v2 里 pendingActions 是**单个组件 state**，switchSession 曾无条件清空它。
 * 审批卡只是 UI 快照，runAgent 仍 await 在 cb.requestApproval；卡片被清后又没有
 * 任何路径重新 set，用户批不了也拒不了 → 审批门永久挂起 → 全局 busy 恒 true →
 * 所有会话输入瘫痪。
 *
 * v3 的修法不是「加个守卫别清」而是**把运行态按会话存**（session-runtime）：
 * 审批卡属于发起会话的运行快照，切会话只是换视图，切回即重现；两个会话各自可以
 * 停在自己的审批门上互不影响。
 *
 * 本锁以运行管理器的真实行为为主（vitest 无 DOM），另取两条组件侧的锚点确保
 * 渲染与收口仍连着运行快照。 */

import {
  useRuntimeStore,
  registerApproval,
  recordApprovalDecision,
  resolveApproval,
  cancelRun,
  releaseRun,
  isInFlight,
  type SessionRun,
} from "../agent/session-runtime";
import type { ApprovalDecision, PendingAction } from "../agent/protocol";

function mkRun(sessionId: string, runId: string, over: Partial<SessionRun> = {}): SessionRun {
  return {
    runId,
    sessionId,
    seq: 1,
    status: "preparing",
    phase: "thinking",
    startedAt: Date.now(),
    headline: "正在理解你的问题…",
    plan: [],
    tools: [],
    phases: [],
    partialAnswer: "",
    pendingActions: [],
    ...over,
  };
}

const cardA: PendingAction = { id: "pa_a", kind: "edit_phase", label: "编辑计划", summary: "改标题", payload: {} };
const cardB: PendingAction = { id: "pa_b", kind: "save_note", label: "存笔记", summary: "存一篇", payload: {} };

beforeEach(() => {
  for (const sid of ["sA", "sB"]) {
    cancelRun(sid, "switch");
    useRuntimeStore.getState().dropSession(sid);
  }
});

describe("审批门按会话归属", () => {
  it("两个会话可以各自停在自己的审批门上，互不覆盖", () => {
    const st = useRuntimeStore.getState();
    st.startRun("sA", mkRun("sA", "r1"));
    st.startRun("sB", mkRun("sB", "r2"));
    useRuntimeStore.getState().patchRun("sA", "r1", { status: "awaiting_approval", pendingActions: [cardA] });
    useRuntimeStore.getState().patchRun("sB", "r2", { status: "awaiting_approval", pendingActions: [cardB] });

    expect(useRuntimeStore.getState().views.sA.run!.pendingActions.map((a) => a.id)).toEqual(["pa_a"]);
    expect(useRuntimeStore.getState().views.sB.run!.pendingActions.map((a) => a.id)).toEqual(["pa_b"]);
    // 两者都在等审批，都属于「在途」——没有任何全局锁把它们串起来
    expect(isInFlight(useRuntimeStore.getState().views.sA.run!.status)).toBe(true);
    expect(isInFlight(useRuntimeStore.getState().views.sB.run!.status)).toBe(true);
  });

  it("审批门 resolve 只影响自己的会话", () => {
    const decisions: ApprovalDecision[][] = [];
    registerApproval("sA", [cardA], (d) => decisions.push(d));
    registerApproval("sB", [cardB], (d) => decisions.push(d));
    resolveApproval("sA", [{ actionId: "pa_a", approved: true }]);
    expect(decisions).toEqual([[{ actionId: "pa_a", approved: true }]]);
    resolveApproval("sB", [{ actionId: "pa_b", approved: false }]);
    expect(decisions[1]).toEqual([{ actionId: "pa_b", approved: false }]);
  });

  it("「停止」把审批门里的每一张卡都判为拒绝（不能传空数组：runner 把缺决定当批准执行）", () => {
    let got: ApprovalDecision[] | null = null;
    registerApproval("sA", [cardA, cardB], (d) => {
      got = d;
    });
    cancelRun("sA", "user");
    expect(got).toEqual([
      { actionId: "pa_a", approved: false },
      { actionId: "pa_b", approved: false },
    ]);
  });

  it("迟到的旧 run 事件（runId 不符）不写入运行快照", () => {
    const st = useRuntimeStore.getState();
    st.startRun("sA", mkRun("sA", "r1"));
    // 别的运行（或本轮之前的运行）的迟到 delta
    useRuntimeStore.getState().patchRun("sA", "r0", { partialAnswer: "迟到的内容" });
    expect(useRuntimeStore.getState().views.sA.run!.partialAnswer).toBe("");
    // 带明确事件序号的乱序事件：低于当前序号即视为过时
    useRuntimeStore.getState().patchRun("sA", "r1", { partialAnswer: "先来的" });
    const cur = useRuntimeStore.getState().views.sA.run!;
    useRuntimeStore.getState().patchRun("sA", "r1", { partialAnswer: "过时的" }, cur.seq - 1);
    expect(useRuntimeStore.getState().views.sA.run!.partialAnswer).toBe("先来的");
  });

  it("releaseRun 之后不再接受任何事件", () => {
    const st = useRuntimeStore.getState();
    st.startRun("sA", mkRun("sA", "r1"));
    releaseRun("sA");
    useRuntimeStore.getState().patchRun("sA", "r1", { partialAnswer: "x" });
    expect(useRuntimeStore.getState().views.sA.run!.partialAnswer).toBe("x"); // 快照仍在（未被销毁）
    // 但审批句柄已清：没有 resolver 可被外部误触发
    let called = false;
    registerApproval("sA", [cardA], () => {
      called = true;
    });
    releaseRun("sA");
    resolveApproval("sA", [{ actionId: "pa_a", approved: true }]);
    expect(called).toBe(false);
  });
});

/* ---- 组件侧锚点：渲染与收口仍连着会话运行快照 ---- */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../../components/agent-home.tsx", import.meta.url)),
  "utf8"
);

describe("AgentHome 审批卡接线", () => {
  it("审批卡从当前会话的运行快照渲染，不再另存一份组件 state", () => {
    expect(SRC).toMatch(/const pendingActions = run\?\.pendingActions \?\? \[\];/);
    expect(SRC).toMatch(/run\.pendingActions\.map\(/);
  });

  it("逐卡决定经 recordApprovalDecision 记入按会话隔离的门（P1-1）", () => {
    expect(SRC).toMatch(/recordApprovalDecision\(sid, actionId, approved\)/);
    expect(SRC).toMatch(/registerApproval\(sid, actions, finish\)/);
    /* 反向断言：决定不得再存组件级 ref（跨会话共享会丢已批决定 → runner 当批准执行） */
    expect(SRC).not.toMatch(/decisionsRef/);
    expect(SRC).not.toMatch(/approvalResolveRef/);
  });

  it("切换会话不再清空审批卡（切走隐藏、切回重现）", () => {
    const at = SRC.indexOf("const switchSession =");
    const swBody = SRC.slice(at, SRC.indexOf("};", at));
    expect(swBody).not.toMatch(/setPendingActions\(\[\]\)/);
  });
});

describe("审批决定按会话隔离（P1-1 回归锁：行为级）", () => {
  it("A 门已批一张卡后，B 开新门不丢失 A 的决定；A 收口时两个决定都在", () => {
    const decisionsA: ApprovalDecision[][] = [];
    const decisionsB: ApprovalDecision[][] = [];
    registerApproval("sA", [cardA, cardB], (d) => decisionsA.push(d));
    // B 开门（旧实现会把组件级 decisionsRef 重置为空，丢掉 A 已批的 pa_a）
    registerApproval("sB", [cardB], (d) => decisionsB.push(d));
    recordApprovalDecision("sA", "pa_a", true);
    recordApprovalDecision("sB", "pa_b", false);
    expect(decisionsB).toEqual([[{ actionId: "pa_b", approved: false }]]);
    // A 的第二张卡在 B 开门之后才批：pa_a 的决定必须还在
    recordApprovalDecision("sA", "pa_b", true);
    expect(decisionsA).toEqual([
      [
        { actionId: "pa_a", approved: true },
        { actionId: "pa_b", approved: true },
      ],
    ]);
  });

  it("部分决定 + 「停止」：停止的逐卡拒绝覆盖已记的决定（不执行任何写入）", () => {
    let got: ApprovalDecision[] | null = null;
    registerApproval("sA", [cardA, cardB], (d) => {
      got = d;
    });
    recordApprovalDecision("sA", "pa_a", true); // 用户批了第一张，然后点了停止
    cancelRun("sA", "user");
    expect(got).toEqual([
      { actionId: "pa_a", approved: false },
      { actionId: "pa_b", approved: false },
    ]);
  });
});
