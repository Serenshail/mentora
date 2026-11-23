import { describe, expect, it, beforeEach, afterAll } from "vitest";

/* ============ 会话运行管理器（T1 / CX-01 / CX-02）行为锁 ============
 * 「每个会话独立运行」必须是真隔离，不是同一个组件实例换了个名字：
 *  - 草稿/附件/滚动位按会话保存，切会话不互相覆盖；
 *  - 两个会话可以同时在途（无全局 busy），请求区间可以重叠；
 *  - 取消只影响本会话；
 *  - 刷新后不能续跑的任务标 interrupted，不重放写入；
 *  - 账户切换清空运行态并取消旧用户任务。
 * 这些都是纯逻辑（zustand + 模块级句柄），可以在 vitest 里直接跑。 */

/* node 环境没有 window/localStorage：只补最小实现，让「在途标记」可测。 */
class FakeStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const fake = new FakeStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: fake };
afterAll(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

import {
  useRuntimeStore,
  beginRun,
  cancelRun,
  controllerOf,
  isRunning,
  markInterruptedOnLoad,
  registerApproval,
  releaseRun,
  resetRuntimeForAccount,
  resolveApproval,
  describeHeadline,
  type SessionRun,
} from "../agent/session-runtime";

function mkRun(sessionId: string, runId: string, over: Partial<SessionRun> = {}): SessionRun {
  return {
    runId,
    sessionId,
    seq: 1,
    status: "generating",
    phase: "answering",
    startedAt: Date.now(),
    headline: "",
    plan: [],
    tools: [],
    phases: [],
    partialAnswer: "",
    pendingActions: [],
    ...over,
  };
}

beforeEach(() => {
  for (const sid of ["sA", "sB", "sC"]) {
    cancelRun(sid, "switch");
    useRuntimeStore.getState().dropSession(sid);
  }
  fake.clear();
});

describe("T1 会话隔离：草稿 / 附件 / 滚动位", () => {
  it("草稿按会话保存，切会话不互相覆盖", () => {
    const st = useRuntimeStore.getState();
    st.setDraft("sA", "A 的草稿");
    st.setDraft("sB", "B 的草稿");
    expect(useRuntimeStore.getState().drafts.sA).toBe("A 的草稿");
    expect(useRuntimeStore.getState().drafts.sB).toBe("B 的草稿");
    st.setDraft("sA", "A 改了");
    expect(useRuntimeStore.getState().drafts.sB).toBe("B 的草稿");
  });

  it("附件与滚动位置同样按会话独立", () => {
    const st = useRuntimeStore.getState();
    st.setAttachment("sA", { dataUrl: "data:image/png;base64,x", name: "a.png", w: 10, h: 10 });
    st.setScrollTop("sA", 120);
    st.setScrollTop("sB", 900);
    expect(useRuntimeStore.getState().attachments.sA?.name).toBe("a.png");
    expect(useRuntimeStore.getState().attachments.sB).toBeUndefined();
    expect(useRuntimeStore.getState().scrollTops.sA).toBe(120);
    expect(useRuntimeStore.getState().scrollTops.sB).toBe(900);
  });

  it("dropSession 只清掉该会话的草稿/附件/运行态", () => {
    const st = useRuntimeStore.getState();
    st.setDraft("sA", "A");
    st.setDraft("sB", "B");
    st.startRun("sA", mkRun("sA", "r1"));
    st.dropSession("sA");
    const after = useRuntimeStore.getState();
    expect(after.drafts.sA).toBeUndefined();
    expect(after.views.sA).toBeUndefined();
    expect(after.drafts.sB).toBe("B");
  });
});

describe("T1 并发：两个会话同时在途", () => {
  it("两个会话各自有 controller，都不是全局锁", () => {
    const acA = beginRun("sA", "r1");
    const acB = beginRun("sB", "r2");
    expect(controllerOf("sA")).toBe(acA);
    expect(controllerOf("sB")).toBe(acB);
    expect(acA.signal.aborted).toBe(false);
    expect(acB.signal.aborted).toBe(false);
    useRuntimeStore.getState().startRun("sA", mkRun("sA", "r1"));
    useRuntimeStore.getState().startRun("sB", mkRun("sB", "r2"));
    expect(isRunning("sA")).toBe(true);
    expect(isRunning("sB")).toBe(true);
  });

  it("取消 B 不影响 A", () => {
    beginRun("sA", "r1");
    const acB = beginRun("sB", "r2");
    useRuntimeStore.getState().startRun("sA", mkRun("sA", "r1"));
    useRuntimeStore.getState().startRun("sB", mkRun("sB", "r2"));
    cancelRun("sB", "user");
    expect(acB.signal.aborted).toBe(true);
    expect(controllerOf("sA")).not.toBeNull();
    expect(useRuntimeStore.getState().views.sB.run!.status).toBe("cancelling");
    expect(useRuntimeStore.getState().views.sA.run!.status).toBe("generating");
  });

  it("同会话重复发起：beginRun 会先中止上一个 controller（同会话一次一项任务）", () => {
    const first = beginRun("sA", "r1");
    beginRun("sA", "r2");
    expect(first.signal.aborted).toBe(true);
  });

  it("取消后迟到的事件仍被 runId 挡住", () => {
    beginRun("sA", "r1");
    useRuntimeStore.getState().startRun("sA", mkRun("sA", "r1"));
    cancelRun("sA", "user");
    // 官方收尾（releaseRun + clearRun）后不应再有写入
    releaseRun("sA");
    useRuntimeStore.getState().clearRun("sA");
    useRuntimeStore.getState().patchRun("sA", "r1", { partialAnswer: "迟到的正文" });
    expect(useRuntimeStore.getState().views.sA?.run ?? null).toBeNull();
  });
});

describe("T1 刷新中断：不重放、不伪造完成", () => {
  it("站内往返保留还在运行的回答", () => {
    const controller = beginRun("sA", "r1");
    useRuntimeStore.getState().startRun("sA", mkRun("sA", "r1"));
    expect(markInterruptedOnLoad()).toEqual([]);
    expect(controller.signal.aborted).toBe(false);
    expect(isRunning("sA")).toBe(true);
  });

  it("刷新后把在途会话标 interrupted 并清掉在途标记", () => {
    beginRun("sA", "r1");
    const stored = fake.getItem("mentora:agent:inflight");
    expect(stored).not.toBeNull();
    releaseRun("sA");
    fake.setItem("mentora:agent:inflight", stored!);
    const ids = markInterruptedOnLoad();
    expect(ids).toContain("sA");
    const run = useRuntimeStore.getState().views.sA.run!;
    expect(run.status).toBe("interrupted");
    expect(run.partialAnswer).toBe("");
    expect(describeHeadline(run)).toContain("中断");
    // 标记已清：再调一次不会重复标
    expect(markInterruptedOnLoad()).toEqual([]);
  });
});

describe("T1 账户切换：取消旧用户任务并清空运行态", () => {
  it("切换账户清空草稿/运行态并中止在途请求", () => {
    const ac = beginRun("sA", "r1");
    useRuntimeStore.getState().startRun("sA", mkRun("sA", "r1"));
    useRuntimeStore.getState().setDraft("sA", "旧用户草稿");
    resetRuntimeForAccount(null); // 首次只登记身份
    expect(useRuntimeStore.getState().drafts.sA).toBe("旧用户草稿");
    resetRuntimeForAccount("u_1"); // 真正的切换
    expect(ac.signal.aborted).toBe(true);
    expect(useRuntimeStore.getState().drafts.sA).toBeUndefined();
    expect(useRuntimeStore.getState().views.sA).toBeUndefined();
    resetRuntimeForAccount("u_1"); // 同账户重复调用是空操作
    useRuntimeStore.getState().setDraft("sA", "新用户草稿");
    resetRuntimeForAccount("u_1");
    expect(useRuntimeStore.getState().drafts.sA).toBe("新用户草稿");
  });
});

describe("T1 审批门：取消即逐张拒绝", () => {
  it("registerApproval + cancelRun → 所有卡 approved:false", () => {
    let got: { actionId: string; approved: boolean }[] | null = null;
    registerApproval(
      "sC",
      [
        { id: "a1", kind: "edit_phase", label: "编辑计划", summary: "", payload: {} },
        { id: "a2", kind: "save_note", label: "存笔记", summary: "", payload: {} },
      ],
      (d) => {
        got = d;
      }
    );
    cancelRun("sC", "user");
    expect(got).toEqual([
      { actionId: "a1", approved: false },
      { actionId: "a2", approved: false },
    ]);
  });

  it("resolveApproval 后句柄释放，重复 resolve 不二次触发", () => {
    let n = 0;
    registerApproval("sC", [], () => n++);
    resolveApproval("sC", []);
    resolveApproval("sC", []);
    expect(n).toBe(1);
  });
});
