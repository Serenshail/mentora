import { describe, expect, it, vi } from "vitest";

/* ============ 空会话不算「本地有数据」（第二轮复核抓到的真实数据丢失） ============
 * 现场：S07 双账户走查里，切回账户 A 后界面只剩一个空对话，A 的历史不回来。
 * 根因：agent-home 挂载时保证「总有一个当前会话」，本地因此存在
 *       `agentSessions = [{ messages: [] }]` 的空壳；而 hasLocalData() 用
 *       `agentSessions.length > 0` 判「本地有数据」→ bootSync 认为无需拉云端 →
 *       真正的历史永远不恢复。cloudHasData() 又完全没算 agentSessions →
 *       「只有首页对话历史」的用户被判成云端空，反手用空壳覆盖云端。
 * 这里锁两个函数的判定口径（私有函数，用源码结构 + 行为双重断言）。 */

const src = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync("src/lib/auth-client.ts", "utf8") as string;
});

describe("hasLocalData / cloudHasData 口径", () => {
  it("本地判定只数「至少一条消息」的会话", () => {
    expect(src).toMatch(/const nonEmptyAgentSessions = \(s\.agentSessions \?\? \[\]\)\.filter\(\(x\) => \(x\.messages\?\.length \?\? 0\) > 0\)\.length;/);
    expect(src).toMatch(/nonEmptyAgentSessions >\s*0/);
    /* 反向断言：不得再直接拿 agentSessions.length 当数据量 */
    expect(src).not.toMatch(/\(s\.agentSessions\?\.length \?\? 0\) >/);
  });

  it("云端判定把 agentSessions 计入（否则会覆盖云端历史）", () => {
    expect(src).toMatch(/agentSessions\?: \{ messages\?: unknown\[\] \}\[\]/);
    expect(src).toMatch(/\(d\.agentSessions \?\? \[\]\)\.filter/);
  });
});

describe("行为验证（用最小复刻确认口径）", () => {
  /* 复刻两份实现的口径，确保「空壳不算数据」在语义上成立 */
  const hasLocal = (s: {
    goals: unknown[];
    knowledge: unknown[];
    books: unknown[];
    sessions: unknown[];
    customPersonas: unknown[];
    agentSessions: { messages: unknown[] }[];
  }) =>
    s.goals.length +
      s.knowledge.length +
      s.books.length +
      s.sessions.length +
      s.customPersonas.length +
      s.agentSessions.filter((x) => x.messages.length > 0).length >
    0;

  const empty = { goals: [], knowledge: [], books: [], sessions: [], customPersonas: [], agentSessions: [] };

  it("只有空壳会话 → 不算本地有数据", () => {
    expect(hasLocal({ ...empty, agentSessions: [{ messages: [] }] })).toBe(false);
  });

  it("会话里有消息 → 算本地有数据", () => {
    expect(hasLocal({ ...empty, agentSessions: [{ messages: [{ content: "hi" }] }] })).toBe(true);
  });

  it("有目标/笔记等任一真实数据 → 算本地有数据", () => {
    expect(hasLocal({ ...empty, goals: [{ id: "g" }] })).toBe(true);
  });
});
