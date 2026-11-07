import { describe, expect, it, vi } from "vitest";

/* runner.ts 引用了带 @/ 别名的模块，而本仓库没有 vitest alias 配置；
 * 这里用工厂 mock 拦截这些导入，只为拿到纯函数 stripMetaSentences。
 * （被 mock 的模块在测试里不会被调用，工厂只需提供导入处用到的导出名。） */
vi.mock("@/lib/ai/client", () => ({
  streamChat: async () => "",
  extractJson: () => null,
  readingPlanSchema: {},
}));
vi.mock("@/lib/store", () => ({
  useAppStore: { getState: () => ({}), setState: () => {}, subscribe: () => () => {} },
}));
vi.mock("@/lib/rag", () => ({
  buildContext: async () => "",
  wikiRetrieve: async () => [],
}));
vi.mock("@/lib/utils", () => ({
  uid: (p?: string) => `${p ?? "id"}-x`,
  todayISO: () => "2026-01-01",
}));
vi.mock("@/lib/track", () => ({
  track: () => {},
}));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => null,
  classifyResource: () => "other",
  validateResources: () => [],
}));

import { stripMetaSentences } from "../agent/runner";

describe("stripMetaSentences（B12：剔除混入正文的英文私语/元话语句）", () => {
  it("移除混在中文段落中间的英文私语，其余保留", () => {
    const input = "我们先看整体思路。Fine. Give final answer briefly. 接下来进入第一部分。";
    const out = stripMetaSentences(input);
    expect(out).not.toContain("Fine");
    expect(out).not.toContain("final answer");
    expect(out).toContain("我们先看整体思路。");
    expect(out).toContain("接下来进入第一部分。");
  });

  it("整行英文私语（memory. Fine. Give final answer briefly.）被移除", () => {
    const input = "上文内容。\nmemory. Fine. Give final answer briefly.\n下文内容。";
    const out = stripMetaSentences(input);
    expect(out).not.toContain("memory");
    expect(out).not.toContain("briefly");
    expect(out).toContain("上文内容。");
    expect(out).toContain("下文内容。");
  });

  it("工具复述句（…\" to see stage list.\"）被移除，前后中文保留", () => {
    const input =
      "已生成你的学习卡片。\n\"Python 学习计划 · 学习总纲要\" to see stage list.\n下面正式开始。";
    const out = stripMetaSentences(input);
    expect(out).not.toContain("stage list");
    expect(out).toContain("已生成你的学习卡片。");
    expect(out).toContain("下面正式开始。");
  });

  it("工具复述句的行首/书名号变体同样被移除", () => {
    expect(stripMetaSentences("《快速上手指南》 to see stage list.")).toBe("");
    expect(
      stripMetaSentences("已就绪。Fine. Give final answer briefly.\n你好，我们开始今天的练习。"),
    ).toBe("已就绪。你好，我们开始今天的练习。");
  });

  it("中文元话语（先调用工具 / 确认卡 / 等待批准）被移除", () => {
    const out = stripMetaSentences(
      "好的，马上开始。我先调用工具生成练习题，用户会看到确认卡，批准后我再继续讲。开始学习吧。",
    );
    expect(out).not.toContain("调用工具");
    expect(out).not.toContain("确认卡");
    expect(out).toContain("好的，马上开始。");
    expect(out).toContain("开始学习吧。");
    expect(stripMetaSentences("我先调用工具查一下你的进度。")).toBe("");
    expect(stripMetaSentences("用户会看到确认卡，等待用户批准后我再汇报。")).toBe("");
  });

  it("代码块内容原样保留（含 meta 关键词的注释不误删）", () => {
    const input = [
      "看下面这个例子：",
      "",
      "```python",
      "# Give final answer briefly. Call the tool to confirm.",
      "print('final answer')  # to see stage list",
      "```",
      "",
      "以上就是全部代码。",
    ].join("\n");
    const out = stripMetaSentences(input);
    expect(out).toContain("# Give final answer briefly. Call the tool to confirm.");
    expect(out).toContain("print('final answer')  # to see stage list");
    expect(out).toContain("以上就是全部代码。");
  });

  it("未闭合的代码块也整体保护", () => {
    const input = "先看代码：\n```js\n// report the result briefly\nconst x = 1;";
    const out = stripMetaSentences(input);
    expect(out).toContain("// report the result briefly");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("先看代码：");
  });

  it("教学句含「调用栈」「工具函数」「调用工具函数」不被误删", () => {
    const input = "递归的每一层都会压入新的调用栈帧，工具函数 writeLog 负责把日志写到标准输出。";
    expect(stripMetaSentences(input)).toBe(input);
    expect(stripMetaSentences("你可以调用工具函数 parseLine 来解析这一行。")).toContain("调用工具函数");
    expect(stripMetaSentences("复杂度是 O(n log n)，因为每次都要重建调用栈。")).toBe(
      "复杂度是 O(n log n)，因为每次都要重建调用栈。",
    );
  });

  it("混排技术句保留（latinRatio 保护）", () => {
    const input = "Recursion 递归 works well 嵌套场景. The call stack 调用栈 grows.";
    expect(stripMetaSentences(input)).toContain("Recursion 递归 works well");
  });

  it("语言一致性：无汉字纯英文句整段移除（V26.1 用户实测泄漏形态）", () => {
    const r = stripMetaSentences("Recursion works well when the data is nested. The call stack grows on each level.");
    expect(r).toBe("");
  });

  it("空串与纯空白安全（无汉字规则下空白组亦剔除）", () => {
    expect(stripMetaSentences("")).toBe("");
    expect(stripMetaSentences("   \n\t  ")).toBe("");
    expect(stripMetaSentences("")).not.toContain("undefined");
  });
});

describe("无汉字纯外文句（语言一致性规则）", () => {
  it("here is a note per phase. Let me search. 整段剔除", () => {
    const r = stripMetaSentences("先看笔记。\nhere is a note per phase. Let me search.\n正文继续。");
    expect(r).toBe("先看笔记。\n正文继续。");
  });

  it("中段插入的纯英文句被剔除，前后中文保留", () => {
    const r = stripMetaSentences("顺序表的核心是连续内存。Let me search for it. 接下来讲扩容。");
    expect(r).toContain("顺序表的核心是连续内存");
    expect(r).toContain("接下来讲扩容");
    expect(r).not.toContain("Let me search");
  });

  it("代码块里的纯英文不受影响", () => {
    const r = stripMetaSentences("如下：\n```py\nprint('hello world only english')\n```\n完毕。");
    expect(r).toContain("print('hello world only english')");
  });
});
