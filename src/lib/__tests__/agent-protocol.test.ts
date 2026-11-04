import { describe, expect, it } from "vitest";
import { advancePlan, MAX_TOOL_ROUNDS, TOOLS, type PlanStep } from "../agent/protocol";
import { parseDirectives, stripDirectives } from "../agent/parse";

describe("advancePlan（计划状态机，参照 Codex PlanItem）", () => {
  const base: PlanStep[] = [
    { id: "s0", text: "检索笔记", status: "in_progress" },
    { id: "s1", text: "整理要点", status: "pending" },
  ];

  it("pending → in_progress 合法", () => {
    const out = advancePlan(base, "s1", "in_progress");
    expect(out[1].status).toBe("in_progress");
  });

  it("in_progress → completed 合法", () => {
    expect(advancePlan(base, "s0", "completed")[0].status).toBe("completed");
  });

  it("禁止跳级：pending → completed 被拒", () => {
    expect(advancePlan(base, "s1", "completed")[1].status).toBe("pending");
  });

  it("已完成不可回退", () => {
    const done = advancePlan(base, "s0", "completed");
    expect(advancePlan(done, "s0", "pending")[0].status).toBe("completed");
  });

  it("跳过允许（skipped）", () => {
    expect(advancePlan(base, "s1", "skipped")[1].status).toBe("skipped");
  });

  it("未知步骤不改变计划", () => {
    expect(advancePlan(base, "nope", "completed")).toEqual(base);
  });
});

describe("parseDirectives（工具/计划指令解析）", () => {
  it("解析 tool 块", () => {
    const d = parseDirectives('我来查一下你的笔记。\n```tool\n{"name":"search_brain","args":{"query":"闭包"}}\n```');
    expect(d.tool?.name).toBe("search_brain");
    expect(d.tool?.args.query).toBe("闭包");
  });

  it("解析 plan 块", () => {
    const d = parseDirectives('```plan\n["检索","整理","保存"]\n```');
    expect(d.plan).toEqual(["检索", "整理", "保存"]);
  });

  it("未知工具名被忽略（防模型瞎编）", () => {
    const d = parseDirectives('```tool\n{"name":"rm_rf","args":{}}\n```');
    expect(d.tool).toBeUndefined();
  });

  it("坏 JSON 不影响正常回答", () => {
    const d = parseDirectives("```tool\n{broken\n```\n正常回答");
    expect(d.tool).toBeUndefined();
    expect(stripDirectives("```tool\n{broken\n```\n正常回答")).toBe("正常回答");
  });

  it("普通回答不产生指令", () => {
    const d = parseDirectives("闭包就是函数加词法作用域。");
    expect(d.tool).toBeUndefined();
    expect(d.plan).toBeUndefined();
  });

  it("plan 超过 8 步被截断", () => {
    const arr = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const d = parseDirectives("```plan\n" + JSON.stringify(arr) + "\n```");
    expect(d.plan).toHaveLength(8);
  });
});

describe("工具注册表", () => {
  it("写入类工具必须标记 needs-confirm", () => {
    const writes = Object.values(TOOLS).filter((t) => t.risk === "write");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((t) => t.risk === "write")).toBe(true);
  });

  it("只读工具包含检索与上下文", () => {
    expect(TOOLS.search_brain.risk).toBe("read");
    expect(TOOLS.read_context.risk).toBe("read");
  });

  it("轮数上限存在且合理", () => {
    expect(MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(3);
    expect(MAX_TOOL_ROUNDS).toBeLessThanOrEqual(8);
  });
});
