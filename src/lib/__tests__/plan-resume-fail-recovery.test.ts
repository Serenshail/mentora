import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  startPlanTask,
  subscribePlanTask,
  getRunningPlanTask,
  type PlanTaskState,
} from "../plan-tasks";

/* ============ 后台总纲要任务「恢复路径」失败收口回归锁 ============
 * 背景：/learn/new 切页再回来时走 subscribePlanTask 恢复路径。旧实现只处理
 * completed，任务失败（BYOK 配额耗尽/网络故障）时 stage 停在 planning，页面只渲染
 * 转圈 + "…" 占位，输入区被隐藏、无错误、无重试入口——用户只能自己再切一次页。
 *
 * 修复：订阅回调补 failed/interrupted 分支——复位 bgTask、用已确认字段重建目标卡、
 * 退回 confirm（字段不全退回 chat，至少输入框可用）、toast 报错。
 *
 * vitest 无 DOM，沿用仓库既有做法：静态扫描 + plan-tasks 真模块行为验证。 */

// Windows 检出（core.autocrlf）下源码是 CRLF；测试锚点按 LF 书写，必须先归一化，
// 否则 extract 永远返回 null（与本次修复无关的假阴性）。
const PAGE = readFileSync(join(process.cwd(), "src/app/learn/new/page.tsx"), "utf8").replace(
  /\r\n/g,
  "\n"
);

/** 抽出恢复路径的 subscribePlanTask 调用块（花括号配平）。 */
function extractResumeSubscription(src: string): string | null {
  const anchor = src.indexOf("if (getRunningPlanTask(resumeId)) {");
  if (anchor === -1) return null;
  const open = src.indexOf("{", anchor);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    const ch = src[end];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(open, end + 1);
}

describe("fix-plan-resume-fail: 恢复路径订阅必须收口 failed/interrupted", () => {
  it("订阅回调同时分支 completed 与 failed/interrupted", () => {
    const block = extractResumeSubscription(PAGE);
    expect(block).toBeTruthy();
    expect(block).toContain('st.status === "completed"');
    // 失败/中断用守卫式早退（`!== "failed" && !== "interrupted"` → return）
    expect(block).toContain('st.status !== "failed"');
    expect(block).toContain('st.status !== "interrupted"');
  });

  it("失败分支做完整恢复：复位角标 + 重建目标卡 + 退回 confirm/chat + 报错", () => {
    const block = extractResumeSubscription(PAGE)!;
    expect(block).toContain("setBgTask(false)");
    expect(block).toContain("cardFromConfirmedGoal(");
    expect(block).toMatch(/setStage\(rebuiltCard \? "confirm" : "chat"\)/);
    expect(block).toContain("toast.error(");
    // 失败后绝不能继续停在 planning（转圈态）
    expect(block).not.toMatch(/setStage\("planning"\);\s*return/);
  });

  it("重建目标卡的 helper 存在且不依赖未定义字段（draft 草稿返回 null 兜底）", () => {
    expect(PAGE).toContain("function cardFromConfirmedGoal(");
    const helper = PAGE.slice(
      PAGE.indexOf("function cardFromConfirmedGoal("),
      PAGE.indexOf("/** 流式期间只显示正文")
    );
    expect(helper).toContain('goal.status === "draft"');
    expect(helper).toContain("return null");
  });

  it("confirmCard 空回复分支也 finish 任务（否则注册表残留 running，恢复路径再次卡死）", () => {
    const emptyBranch = PAGE.slice(
      PAGE.indexOf("if (!full) {"),
      PAGE.indexOf("if (!full) {") + 400
    );
    expect(emptyBranch).toContain("planTask.finish(");
  });
});

/* ---- 真模块行为：failed 状态确实会 emit 给订阅者 ---- */
describe("fix-plan-resume-fail: plan-tasks 失败广播契约", () => {
  it("finish(error) 向订阅者广播 failed + error，并从注册表移除", () => {
    const goalId = "goal-resume-fail-broadcast";
    const task = startPlanTask(goalId, "master");
    const seen: PlanTaskState[] = [];
    subscribePlanTask(goalId, (s) => seen.push(s));

    // 订阅即刻回放当前 running 状态（页面据此进入 planning，不应误判失败）
    expect(seen[0]?.status).toBe("running");

    task.finish("配额耗尽");
    const last = seen[seen.length - 1];
    expect(last.status).toBe("failed");
    expect(last.error).toBe("配额耗尽");
    expect(getRunningPlanTask(goalId)).toBeNull();
  });

  it("interrupted（同目标重复启动/超时自愈）同样落在 failed 之外的可恢复状态", () => {
    const goalId = "goal-resume-fail-interrupt";
    const first = startPlanTask(goalId, "master");
    const seen: PlanTaskState[] = [];
    subscribePlanTask(goalId, (s) => seen.push(s));

    // 再启一个同类任务：旧任务被标记 interrupted 并广播
    const second = startPlanTask(goalId, "master");
    expect(seen[seen.length - 1].status).toBe("interrupted");
    expect(getRunningPlanTask(goalId)?.taskId).toBe(second.taskId);

    second.finish();
    first.finish("晚到的失败不应覆盖新任务"); // 旧 taskId 已被删除，guard 直接返回
    expect(getRunningPlanTask(goalId)).toBeNull();
  });
});
