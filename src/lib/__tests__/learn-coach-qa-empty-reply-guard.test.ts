import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ AskCoach 空回复守卫（回归锁） ============
 * 背景：AskCoach 的 send 在 streamChat 正常结束但正文为空时（BYOK 自定义端点返回
 * 200 空正文），仍向持久化 qa 追加一条空 assistant 消息且无任何报错——界面空气泡、
 * 该空消息还占用后续 newQa.slice(-6) 的历史窗口稀释上下文。use-chat.ts 对同一情况
 * 显式定义为必须报错的缺陷（setError「模型返回了空回复，请重试」）。
 *
 * 修复：content = full || buf；有内容才 appendDayQa，否则显式 toast 报错。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

const coach = PAGE.slice(
  PAGE.indexOf("function AskCoach"),
  PAGE.indexOf("/* ================= 随手记")
);

describe("learn/[id] AskCoach：空回复不落库且必须报错", () => {
  it("不再无条件构造并追加 finalQa（旧实现的空气泡来源）", () => {
    expect(coach).not.toMatch(/const finalQa/);
  });

  it("content 为空（full 与流式缓冲均空）时不 appendDayQa，显式报错", () => {
    expect(coach).toMatch(/const content = full \|\| buf;/);
    expect(coach).toMatch(/if \(content\) \{\s*\n\s*appendDayQa\(goal\.id, day\.id, \{/);
    expect(coach).toMatch(/toast\.error\("模型返回了空回复，请重试"\);/);
  });

  it("判空先于 appendDayQa 的 assistant 分支（不落库空气泡）", () => {
    const contentAt = coach.indexOf("const content = full || buf;");
    const appendAt = coach.indexOf("appendDayQa(goal.id, day.id, {", contentAt);
    const errAt = coach.indexOf('toast.error("模型返回了空回复，请重试")');
    expect(appendAt).toBeGreaterThan(contentAt);
    expect(errAt).toBeGreaterThan(appendAt);
  });
});
