import { describe, expect, it } from "vitest";
import {
  advancePlan, callSignature, MAX_TOOL_ROUNDS, stepPlanForward, TOOLS, type PlanStep,
} from "../agent/protocol";
import { parseDirectives, stripDirectives, ToolCallAggregator } from "../agent/parse";

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

  it("空围栏被清掉（流式黑条根因）", () => {
    expect(stripDirectives("第一段\n```\n```\n第二段")).toBe("第一段\n\n第二段");
    expect(stripDirectives("正文\n```js\n\n```\n结尾")).toBe("正文\n\n结尾");
    expect(stripDirectives("正文\r\n```json\r\n\r\n```\r\n结尾")).toBe("正文\n\n结尾");
  });

  it("有内容的代码块必须保留", () => {
    const code = "解释：\n```js\nconst a = 1;\n```";
    expect(stripDirectives(code)).toBe(code);
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

  it("v2：并行 tool 块全部进 tools 数组（v1 是死代码）", () => {
    const d = parseDirectives(
      '先查再读。\n```tool\n{"name":"search_brain","args":{"query":"闭包"}}\n```\n```tool\n{"name":"read_context","args":{}}\n```'
    );
    expect(d.tools).toHaveLength(2);
    expect(d.tools?.[0].name).toBe("search_brain");
    expect(d.tools?.[1].name).toBe("read_context");
    expect(d.tool?.name).toBe("search_brain");
  });
});

describe("ToolCallAggregator（原生 tool_calls 流式聚合）", () => {
  it("分片聚合出完整调用", () => {
    const agg = new ToolCallAggregator();
    agg.feed([{ index: 0, id: "c1", function: { name: "sea", arguments: "{\"qu" } }]);
    agg.feed([{ index: 0, function: { name: "rch_brain", arguments: "ery\":\"闭包\"}" } }]);
    agg.feed([
      { index: 1, id: "c2", function: { name: "read_context", arguments: "{}" } },
    ]);
    const calls = agg.finish();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ id: "c1", name: "search_brain", argsRaw: '{"query":"闭包"}' });
    expect(calls[1].name).toBe("read_context");
  });

  it("空聚合 isEmpty", () => {
    const agg = new ToolCallAggregator();
    expect(agg.isEmpty).toBe(true);
    expect(agg.finish()).toEqual([]);
  });
});

describe("stepPlanForward（计划单步推进，修复 v1 双推进）", () => {
  const base: PlanStep[] = [
    { id: "s0", text: "检索", status: "in_progress" },
    { id: "s1", text: "整理", status: "pending" },
    { id: "s2", text: "保存", status: "pending" },
  ];

  it("一次只推进一步", () => {
    const next = stepPlanForward(base);
    expect(next[0].status).toBe("completed");
    expect(next[1].status).toBe("in_progress");
    expect(next[2].status).toBe("pending");
  });

  it("最后一步完成后没有新 in_progress", () => {
    const done = base.map((s) => ({ ...s, status: s.id === "s2" ? "in_progress" : "completed" })) as PlanStep[];
    const next = stepPlanForward(done);
    expect(next.every((s) => s.status === "completed")).toBe(true);
  });
});

describe("callSignature（打转守卫）", () => {
  it("相同工具相同参数签名一致；参数顺序无关", () => {
    expect(callSignature("search_brain", { query: "闭包", limit: 3 })).toBe(
      callSignature("search_brain", { limit: 3, query: "闭包" })
    );
    expect(callSignature("search_brain", { query: "闭包" })).not.toBe(
      callSignature("search_brain", { query: "协程" })
    );
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
