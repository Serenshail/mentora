import { beforeEach, describe, expect, it, vi } from "vitest";

/* ============ LLMWiki 编译：模型乱输出不得逃出编译循环（回归锁） ============
 * 背景：extractJson（ai/json.ts）对候选串做 JSON.parse——模型只吐字面量 `null`
 * 时 JSON.parse("null") 返回 null 而不抛错，`{"links":"标题"}` 这类形状错误同样
 * 解析成功。旧实现只把 extractJson 调用包在 try 里，随后的 `ops.links ?? []`
 * 在 try 之外解引用：ops 为 null 时抛 TypeError，不被本函数捕获，既冲掉已累计的
 * linked/merges/conflicts，又中断剩余目标；调用方（note-workspace.tsx「AI 整理」）
 * 只能显示笼统的「wiki 编译失败」。
 * 修复：解析后校验必须是普通对象（null/数组/标量按单篇失败计入 failed/lastError
 * 并 continue），links 非数组或含非字符串条目时安全降级为空/过滤。
 * 本测试直接跑 runWikiCompile（只 mock 网络与 store），断言不抛错、失败可见、
 * 且循环继续处理后续目标。 */

const probe = vi.hoisted(() => ({
  replies: [] as string[],
  calls: 0,
}));

vi.mock("@/lib/ai/client", async () => {
  const { extractJson } = await import("@/lib/ai/json");
  return {
    // 逐次返回模型"原文"；用真实 extractJson，才能覆盖 null/错形状的解析路径
    streamChat: vi.fn(async () => {
      const reply = probe.replies[probe.calls] ?? "null";
      probe.calls++;
      return reply;
    }),
    extractJson,
  };
});

interface MockNote {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  links?: string[];
  unresolved?: boolean;
}

const state = vi.hoisted(() => ({
  notes: [] as MockNote[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
}));

vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({
      knowledge: state.notes,
      updateKnowledge: (id: string, patch: Record<string, unknown>) => {
        state.updates.push({ id, patch });
        const n = state.notes.find((x) => x.id === id);
        if (n) Object.assign(n, patch);
      },
    }),
  },
}));

function seed(): void {
  state.notes.length = 0;
  state.updates.length = 0;
  state.notes.push(
    { id: "n1", title: "Alpha", body: "alpha 概念 正文", tags: [], links: [] },
    { id: "n2", title: "Beta", body: "beta 概念 正文", tags: [], links: [] },
    { id: "n3", title: "Gamma", body: "gamma 概念 正文", tags: [], links: [] }
  );
}

describe("runWikiCompile：模型输出 null / 形状错误不得抛出并中断整轮编译", () => {
  beforeEach(() => {
    seed();
    probe.replies = [];
    probe.calls = 0;
  });

  it("首个目标返回字面量 null：计入 failed 且循环继续处理后续目标", async () => {
    probe.replies = ["null", '{"links":["Beta"]}', '{"links":["Alpha"]}'];
    const { runWikiCompile } = await import("@/lib/wiki-compile");

    // 旧实现这里抛 TypeError（Cannot read properties of null (reading 'links')）
    const r = await runWikiCompile(3);

    expect(r.failed).toBe(1);
    expect(r.lastError).toBeTruthy();
    expect(probe.calls).toBe(3); // 未中断：三个目标都被尝试
    expect(r.linked).toBeGreaterThanOrEqual(1); // 后续目标照常建链
    expect(r.processed).toBeGreaterThanOrEqual(2);
  });

  it("links 非数组（字符串/对象）时安全降级，不抛错", async () => {
    probe.replies = ['{"links":"Beta"}', '{"links":{"a":1}}', '{"links":[1,2,{"x":1}]}'];
    const { runWikiCompile } = await import("@/lib/wiki-compile");

    const r = await runWikiCompile(3);

    expect(r.failed).toBe(0);
    expect(r.linked).toBe(0);
    expect(r.processed).toBe(3);
    expect(state.updates).toHaveLength(0);
  });

  it("links 数组混入非字符串条目：跳过脏条目，合法标题仍建链", async () => {
    probe.replies = ['{"links":[null,42,{"t":"Beta"},"Beta"]}'];
    const { runWikiCompile } = await import("@/lib/wiki-compile");

    const r = await runWikiCompile(1);

    expect(r.failed).toBe(0);
    expect(r.linked).toBe(1);
    expect(state.updates).toEqual([{ id: "n1", patch: { links: ["n2"] } }]);
  });

  it("顶层返回数组（不是对象）也按单篇失败处理，不中断", async () => {
    probe.replies = ['["Beta"]', '{"links":["Beta"]}', '{"links":["Alpha"]}'];
    const { runWikiCompile } = await import("@/lib/wiki-compile");

    const r = await runWikiCompile(3);

    expect(r.failed).toBe(1);
    expect(probe.calls).toBe(3);
    expect(r.linked).toBeGreaterThanOrEqual(1);
  });
});
