import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  beginRun,
  cancelRun,
  controllerOf,
  isInFlight,
  registerApproval,
  useRuntimeStore,
  type SessionRun,
} from "../agent/session-runtime";
import type { ApprovalDecision, PendingAction } from "../agent/protocol";

/* ============ 停止与审批门的竞态（回归锁） ============
 * 背景：requestApproval 无条件 registerApproval 并把 status 翻回 awaiting_approval，
 * 不检查运行是否已被取消。用户点停止 → cancelRun（此刻 resolvers 里还没有门，删
 * controller 并 abort）→ 同轮 executeTool 因 abort 抛错被 runner 捕成普通失败 →
 * Promise.all 正常 resolve → runner 事后才调 cb.requestApproval → 组件把状态翻回
 * awaiting_approval 并注册一个永远无人 resolve 的新门，任务悬挂。
 * 修复在组件侧：开门前检查 controllerOf(sid)（cancelRun 已注销）与
 * status==="cancelling"，已取消就按「全部拒绝」收口。这里锁：
 *  1) 组件侧守卫存在且先于 registerApproval（静态扫描）；
 *  2) 守卫依赖的运行管理器契约真实成立：cancelRun 注销 controller、把在途状态翻成
 *     cancelling、并把已开的门按全部拒绝 resolve。 */

const HOME = readFileSync(join(process.cwd(), "src/components/agent-home.tsx"), "utf8");

const mkRun = (over: Partial<SessionRun> = {}): SessionRun => ({
  runId: "run_1",
  sessionId: "s1",
  seq: 1,
  status: "executing_tool",
  phase: "acting",
  startedAt: Date.now(),
  headline: "测试",
  plan: [],
  tools: [],
  phases: [],
  partialAnswer: "",
  pendingActions: [],
  ...over,
});

describe("组件侧：开门前必须先查取消状态", () => {
  it("requestApproval 含 controllerOf / cancelling 检查，取消时按全部拒绝收口", () => {
    const start = HOME.indexOf("const requestApproval =");
    const end = HOME.indexOf("const decide =", start);
    const body = HOME.slice(start, end);
    expect(body).toContain("!controllerOf(sid) || !cur || cur.status === \"cancelling\" || !isInFlight(cur.status)");
    expect(body).toContain("resolve(actions.map((a) => ({ actionId: a.id, approved: false })))");
    /* 检查必须发生在注册门之前（同一同步块内，单线程下不存在第三种交错） */
    expect(body.indexOf("const cancelled =")).toBeGreaterThan(-1);
    expect(body.indexOf("registerApproval(sid, actions, finish)")).toBeGreaterThan(body.indexOf("const cancelled ="));
  });

  it("onPhase 不把 cancelling 状态翻回 generating（停止反馈不被冲掉）", () => {
    expect(HOME).toContain('status: cur?.status === "cancelling" ? cur.status : status');
  });
});

describe("运行管理器契约：cancelRun 之后组件守卫的依据成立", () => {
  beforeEach(() => {
    cancelRun("s1"); // 清残留句柄/门
    useRuntimeStore.getState().clearRun("s1");
  });

  it("运行中点停止：controller 注销 + 在途状态进入 cancelling", () => {
    beginRun("s1", "run_1");
    useRuntimeStore.getState().startRun("s1", mkRun());
    expect(controllerOf("s1")).not.toBeNull();
    expect(isInFlight(useRuntimeStore.getState().views["s1"]!.run!.status)).toBe(true);

    cancelRun("s1", "user");
    expect(controllerOf("s1")).toBeNull();
    expect(useRuntimeStore.getState().views["s1"]!.run!.status).toBe("cancelling");
  });

  it("cancelRun 清掉已开的审批门：按全部拒绝 resolve（停止=逐卡拒绝），不悬挂", async () => {
    beginRun("s1", "run_1");
    useRuntimeStore.getState().startRun("s1", mkRun());
    const actions: PendingAction[] = [
      { id: "pa_1", kind: "save_note", label: "存笔记", summary: "s", payload: {} },
      { id: "pa_2", kind: "add_book", label: "加书", summary: "s", payload: {} },
    ];
    const decisions = await new Promise<ApprovalDecision[]>((resolve) => {
      registerApproval("s1", actions, resolve);
      cancelRun("s1", "user");
    });
    expect(decisions).toHaveLength(actions.length);
    expect(decisions.every((d) => d.approved === false)).toBe(true);
  });

  it("取消后 status=cancelling：组件守卫据此拦下迟到的开门请求", () => {
    beginRun("s1", "run_1");
    useRuntimeStore.getState().startRun("s1", mkRun());
    cancelRun("s1", "user");
    const cur = useRuntimeStore.getState().views["s1"]!.run!;
    /* 这两条就是组件 requestApproval 读取的信号，任一缺失守卫即失效 */
    expect(cur.status === "cancelling" || !isInFlight(cur.status) || !controllerOf("s1")).toBe(true);
  });
});
