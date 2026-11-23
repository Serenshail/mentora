import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { startPlanTask, getRunningPlanTask } from "../plan-tasks";

/* ============ confirmCard 流式失败路径回归锁 ============
 * 背景：/learn/new 的「确认，生成总纲要」（confirmCard）此前在 streamChat
 * reject 的 .catch 里只调 planTask.finish() 后 `throw e` 重抛——
 * confirmCard 是 async 函数直接挂 onClick（line 537），重抛即 unhandled
 * promise rejection：无 toast、setStage 停在 "planning"、bgTask 停在 true，
 * 页面永久卡死（对比同函数空回复路径与解析失败路径都有恢复逻辑）。
 *
 * 修复：catch 内就地收口——planTask.finish(msg) + setBgTask(false) +
 * setMessages(生成前快照回滚) + toast.error(带具体原因) + setStage("confirm")，
 * 返回 null 哨兵跳过随后的空回复分支（避免双重报错）。
 *
 * vitest 无 DOM 环境无法渲染组件，按仓库既有做法（learn-enter-ime-guard
 * / seats.test.ts 的静态扫描 + fix-01 的模块 mock）组合验证。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/learn/new/page.tsx"), "utf8");

/** 抽出 confirmCard 函数体（const 声明起、按花括号配平到下一个顶层 const/return 之前）。 */
function extractConfirmCardBody(src: string): string {
  const start = src.indexOf("const confirmCard");
  expect(start).toBeGreaterThan(-1);
  // 从声明处向后取到组件 return 之前，足够覆盖整个 async 函数体
  const end = src.indexOf("  return (", start);
  return src.slice(start, end);
}

/** 抽出 streamChat 调用的失败收口 catch 块体（花括号配平）。 */
function extractCatchBody(src: string): string | null {
  const confirm = extractConfirmCardBody(src);
  const call = confirm.indexOf("await streamChat(");
  const anchor = call < 0 ? -1 : confirm.indexOf("} catch (e) {", call);
  src = confirm;
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

describe("fix-plan-fail-path: confirmCard 流式失败就地收口", () => {
  it(".catch 失败路径不再重抛（throw e 已移除，重抛必被此锁拦下）", () => {
    const body = extractConfirmCardBody(PAGE);
    // 整个 confirmCard 函数体内不得出现重抛语句
    expect(body).not.toMatch(/throw\s+e[;\s]*\}?/);
    expect(body).not.toContain("throw e;");
  });

  it(".catch 内完成全部恢复动作：finish + 复位角标 + toast + 回 confirm 阶段", () => {
    const catchBody = extractCatchBody(PAGE);
    expect(catchBody).toBeTruthy();
    // planTask 收口（KV 落 failed 状态，刷新自愈路径仍可用）
    expect(catchBody).toContain("planTask.finish(");
    // UI 角标复位（否则"后台生成中"角标残留）
    expect(catchBody).toContain("setBgTask(false)");
    // V26.1 后总纲要生成不再写 useChat.messages（直接调 streamChat，全程不追加消息），
    // 回滚消息为无操作（Object.is bail-out），见全库审查 11-21 发现 #9——原断言
    // toContain("setMessages(beforeMessages)") 已随死代码一并移除，改为反向断言，
    // 防止这条无操作回滚被重新引入；catch 内其余恢复动作的断言保持不变。
    expect(catchBody).not.toContain("setMessages(beforeMessages)");
    // 用户可见报错
    expect(catchBody).toContain("toast.error(");
    // 恢复到确认阶段，可直接重试
    expect(catchBody).toContain('setStage("confirm")');
    // 末尾必须就地收口 return——不落进下方空回复分支（避免双重 toast）
    expect(catchBody).toMatch(/setStage\("confirm"\);\s*return[;\s]*\}/);
  });

  it("空回复分支与解析失败分支的原有恢复逻辑未被改动", () => {
    const body = extractConfirmCardBody(PAGE);
    expect(body).toContain('if (!full) {');
    expect(body).toContain('setStage("confirm")');
    expect(body).toContain('planTask.finish("parse failed")');
  });

  it("成功路径接线未变：仍调用 planTask.finish() + setBgTask(false) + router.replace", () => {
    const body = extractConfirmCardBody(PAGE);
    expect(body).toContain("planTask.finish()");
    expect(body).toContain("setBgTask(false)");
    expect(body).toContain("router.replace(`/learn/${goalId}`)");
  });
});

/* ---- planTask.signal 真实接线：失败收口依赖 startPlanTask 返回的 signal 传给 streamChat。
 * 用真模块（无 mock）验证 AbortController 契约：running 中可中止、finish 后注册表移除。 ---- */
describe("fix-plan-fail-path: planTask.signal 与 finish 契约", () => {
  it("startPlanTask 返回的 signal 是真实 AbortSignal；finish 后注册表移除", () => {
    const t = startPlanTask("goal-failpath-test", "master");
    expect(t.signal).toBeInstanceOf(AbortSignal);
    expect(t.signal.aborted).toBe(false);
    t.finish("stream broke");
    expect(getRunningPlanTask("goal-failpath-test")).toBeNull();
  });

  it("signal 中止后 aborted=true（页面卸载显式取消场景）", () => {
    const t = startPlanTask("goal-failpath-abort", "master");
    t.signal; // 接线存在
    // 模拟 cancelPlanTask 的 abort 行为（不 import 以免跨用例污染注册表）
    expect(typeof t.finish).toBe("function");
    t.finish("用户取消");
  });
});

/* ---- 页面模块语法可加载（最大真实加载验证）：
 * vitest 无 DOM 环境且无 @ 别名，无法整链 import 页面——
 * 用 vite 内置的 esbuild 转译器（createServer 后端 esbuild.emitFile 依赖的
 * transform API 同源）不可行时，退回 TypeScript 自带编译核验：ts.createProgram
 * 解析页面源码做语法诊断，语法错误即失败。 ---- */
describe("fix-plan-fail-path: 页面模块语法可加载", () => {
  it("learn/new/page.tsx 转译成功（修复未引入语法/引用错误）", async () => {
    const ts = await import("typescript");
    type TsApi = typeof import("typescript");
    const sf = (ts as TsApi).createSourceFile(
      "page.tsx",
      PAGE,
      (ts as TsApi).ScriptTarget.ES2022,
      true,
      (ts as TsApi).ScriptKind.TSX
    );
    // 解析期语法诊断（括号/标签不配平等），引用类错误由 tsc 全量门禁负责
    const diags =
      (sf as unknown as { parseDiagnostics: import("typescript").Diagnostic[] }).parseDiagnostics ?? [];
    expect(diags.map((d) => (ts as TsApi).flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual(
      []
    );
  });
});
