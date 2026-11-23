import { afterEach, describe, expect, it, vi } from "vitest";
import { startPlanTask, getRunningPlanTask, cancelPlanTask } from "../plan-tasks";

/* ============ 计划任务运行期心跳回归锁 ============
 * 背景：updatedAt 旧实现只在 start/finish 时写（emit 无心跳）。/learn/new 恢复路径
 * 用「KV running 且 updatedAt 超 180s」判定"被页面刷新中断"——用户切页 3 分钟后
 * 回来（任务还活着）、或开第二个标签页，都会命中误判：误导性 toast 诱发重复生成、
 * 双倍 AI 计费。另外 finishExisting 顶掉旧任务时只改状态不 abort——被顶掉的
 * streamChat 继续在后台烧 token。
 *
 * 修复：running 期间每 45s emit 一次（刷新 updatedAt 本地 + KV），「updatedAt 鲜度」
 * 从此真正代表任务存活（180s = 连续 4 拍未续期才判死）；finishExisting 补
 * controller.abort()，同目标同类任务"只允许一个在跑"的不变量才真正成立。 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 劫持全局 fetch，记录 KV POST 的 body（emit 是 fire-and-forget，resolve 一个 ok 即可） */
function stubFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const f = vi.fn(async (_url: string, init?: { body?: string }) => {
    if (init?.body) bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return { ok: true };
  });
  vi.stubGlobal("fetch", f);
  return bodies;
}

describe("plan-tasks 运行期心跳", () => {
  it("running 期间每 45s emit 一次（updatedAt/KV 持续续期），finish 后停止", async () => {
    vi.useFakeTimers();
    const bodies = stubFetch();
    const t = startPlanTask("goal-hb-live", "master");
    expect(bodies.length).toBe(1); // start 即 emit 一次
    expect(bodies[0].status).toBe("running");

    await vi.advanceTimersByTimeAsync(46_000); // 跨过第一拍
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(90_000); // 再两拍
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    expect(bodies.every((b) => b.status === "running")).toBe(true);

    t.finish(); // 完成态本身再 emit 一次，此后心跳必须停
    const afterFinish = bodies.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bodies.length).toBe(afterFinish);
    expect(getRunningPlanTask("goal-hb-live")).toBeNull();
  });

  it("finishExisting 顶掉旧任务时 abort 旧流（不 abort 就同目标双流并发、双倍计费）", () => {
    const first = startPlanTask("goal-hb-replace", "master");
    expect(first.signal.aborted).toBe(false);
    const second = startPlanTask("goal-hb-replace", "master");
    expect(first.signal.aborted).toBe(true);
    expect(getRunningPlanTask("goal-hb-replace")?.taskId).toBe(second.taskId);
    second.finish();
  });

  it("cancelPlanTask 终止心跳并 abort", async () => {
    vi.useFakeTimers();
    const bodies = stubFetch();
    const t = startPlanTask("goal-hb-cancel", "master");
    cancelPlanTask("goal-hb-cancel");
    expect(t.signal.aborted).toBe(true);
    const afterCancel = bodies.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(bodies.length).toBe(afterCancel);
  });
});
