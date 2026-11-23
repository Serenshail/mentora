import { describe, expect, it, vi } from "vitest";

/* fix-01 批次回归锁：
 *  1. executeTool 写分发以 TOOLS[name].risk 为单一来源——regenerate_phase 必须走写入校验路径
 *     （此前手抄 spec 表漏掉它，被当只读分发、永远返回「未知只读工具」）。
 *  2. stripDirectives 行首 JSON 残留清理不再吞 markdown 链接/引用/对白行
 *     （此前 /^\s*["[\]{}].*$/gm 把行首为 [ " 的正文行整行删除）。
 *  3. executeAction 提供 signal 形参（停止按钮可中止在途 AI 生成）+ 未知 kind 安全返回失败。
 *
 * tool-executors/phase-regen 引用带 @/ 别名与浏览器 store 的模块，
 * 用工厂 mock 拦截（同 phase-align.test.ts / meta-filter.test.ts 先例）。 */
vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => ""),
  extractJson: () => {
    throw new Error("no json");
  },
  readingPlanSchema: {},
  phaseListSchema: {},
}));
vi.mock("@/lib/store", () => ({
  useAppStore: { getState: () => ({ goals: [], knowledge: [], books: [], sessions: [], settings: {} }), setState: () => {}, subscribe: () => () => {} },
}));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/track", () => ({ track: () => {} }));
vi.mock("@/lib/utils", () => ({
  uid: (p: string) => `${p}_test_${Math.random().toString(36).slice(2, 8)}`,
  todayISO: () => "2026-11-09",
}));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

import { stripDirectives } from "../agent/parse";
import { TOOLS, type ToolName } from "../agent/protocol";
import { alignPhaseDayIds } from "../agent/phase-regen";
import { executeAction, executeTool } from "../agent/tool-executors";

describe("fix-01: 写工具分发单一事实来源（TOOLS.risk，含 regenerate_phase）", () => {
  const writeTools = (Object.keys(TOOLS) as ToolName[]).filter((n) => TOOLS[n].risk === "write");

  it("regenerate_phase 在协议表里是 write 工具", () => {
    expect(TOOLS.regenerate_phase.risk).toBe("write");
    expect(writeTools).toContain("regenerate_phase");
  });

  it("协议表写工具清单（漂移时此清单需要有意更新）", () => {
    expect(writeTools.sort()).toEqual(
      [
        "save_note",
        "manage_goal",
        "update_note",
        "delete_note",
        "create_goal",
        "add_book",
        "create_session",
        "update_settings",
        "update_plan_resources",
        "regenerate_phase",
        "edit_phase",
        "edit_book_goal",
        "set_reading_progress",
        "move_chapter",
        "save_reading_deposit",
        "link_notes",
        "record_book_assessment",
        "update_book",
        "remove_book",
        "rebuild_reading_route",
        "restore_book_route",
        "manage_session",
        "forge_persona",
        "run_discussion",
        "set_participants",
      ].sort()
    );
  });

  it("executeTool 对 regenerate_phase 走写入路径（返回待确认 action，而非「未知只读工具」）", async () => {
    const out = await executeTool("regenerate_phase", {});
    /* 缺 topic 参数 → 写入校验路径的参数缺失错误，而不是「未知只读工具」 */
    expect(out.result.content).not.toContain("未知只读工具");
    expect(out.result.content).toBe("需要 topic");
  });

  it("memory/reminders 是 read（写分支在工具内部按 action 分流）", () => {
    expect(TOOLS.memory.risk).toBe("read");
    expect(TOOLS.reminders.risk).toBe("read");
  });
});

describe("fix-01: stripDirectives 不再吞行首 markdown 链接/引用行", () => {
  it("行首 markdown 链接行保留（此前被整行删除）", () => {
    const input = "参考链接如下：\n[原文出处](https://example.com/article)\n以上就是全部内容。";
    expect(stripDirectives(input)).toBe(input);
  });

  it("引用样式行 [1] 标题 保留", () => {
    const input = "参考：\n[1] Smith J. Some paper title. 2020.";
    expect(stripDirectives(input)).toContain("[1] Smith J. Some paper title. 2020.");
  });

  it("行首引号对白保留", () => {
    const input = '他说：\n"今天天气不错，我们去散步吧。"然后我们就出发了。';
    expect(stripDirectives(input)).toContain('"今天天气不错，我们去散步吧。"');
  });

  it("裸 JSON 对象残留行仍被删除", () => {
    expect(stripDirectives('回答正文\n{"name": "x"}\n尾部')).toBe("回答正文\n\n尾部");
  });

  it("裸 JSON 数组残留行仍被删除", () => {
    expect(stripDirectives('回答正文\n[{"a":1},{"b":2}]\n尾部')).toBe("回答正文\n\n尾部");
  });

  it("空数组残留行仍被删除", () => {
    expect(stripDirectives("回答正文\n[]\n尾部")).toBe("回答正文\n\n尾部");
  });

  it("裸字符串残留行仍被删除", () => {
    expect(stripDirectives('回答正文\n"一个字符串残留"\n尾部')).toBe("回答正文\n\n尾部");
  });

  it("围栏内 JSON 不受影响（占位符保护仍生效）", () => {
    const input = '```json\n{"keep": true}\n```\n尾部';
    expect(stripDirectives(input)).toBe(input);
  });
});

describe("fix-01: alignPhaseDayIds（重排 id 对齐，stub 天资源语义配套）", () => {
  const days: Record<string, { id: string; title: string }> = {
    d1: { id: "d1", title: "变量与类型" },
    d2: { id: "d2", title: "函数基础" },
  };

  it("标题相同的天沿用旧 id", () => {
    expect(alignPhaseDayIds(["d1", "d2"], days, ["函数基础", "变量与类型"])).toEqual(["d2", "d1"]);
  });

  it("新标题返回空串（由调用方生成新 id，进入时按 stub 展开）", () => {
    expect(alignPhaseDayIds(["d1"], days, ["全新主题"])).toEqual([""]);
  });

  it("重复标题不重复占用旧 id", () => {
    expect(alignPhaseDayIds(["d1"], days, ["变量与类型", "变量与类型"])).toEqual(["d1", ""]);
  });
});

describe("fix-01: executeAction 接收 AbortSignal（停止按钮中止面）", () => {
  it("未知 kind 携带 signal 调用安全返回失败（不炸、不误杀）", async () => {
    const res = await executeAction(
      { id: "pa_x", kind: "unknown_kind" as never, label: "x", summary: "x", payload: {} },
      new AbortController().signal
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("未知动作类型");
  });
});
