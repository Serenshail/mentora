import { beforeEach, describe, expect, it, vi } from "vitest";

/* Node 环境没有 localStorage：zustand persist 的 setItem 会炸。给个最小内存实现。 */
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() { return mem.size; },
    },
    configurable: true,
  });
}

/** 结业回路回归锁（v21）：
 *  目标最后一个阶段过门后，必须留下"可回看的资产"与"下一步建议"，且重复进入不能重复生成。
 *  这里直接测纯逻辑（store 状态 + graduation 落库语义），不调真实模型。 */

vi.mock("../ai/client", () => ({
  streamChat: vi.fn(),
  extractJson: (t: string) => JSON.parse(t),
  graduationSchema: {
    parse: (v: unknown) => v as { noteMarkdown: string; nextSteps: string[] },
  },
}));

import { streamChat } from "../ai/client";
import { useAppStore } from "../store";
import { runGraduation } from "../graduation";
import type { Goal } from "../types";

const mkGoal = (over: Partial<Goal> = {}): Goal => ({
  id: "g1",
  topic: "Python",
  direction: "能写数据脚本",
  domainKind: "coding",
  motivation: "自动化",
  background: "会 Excel",
  weeklyHours: 8,
  successCriteria: ["独立写脚本"],
  status: "done",
  createdAt: "2026-10-01T00:00:00.000Z",
  quizLog: [{ dayId: "d1", date: "2026-10-02", passed: false, forced: false, items: [{ itemId: "a0", question: "变量是什么", userAnswer: "x", verdict: "incorrect", feedback: "" }] }],
  intakeTranscript: [],
  plan: {
    summary: "先语法后实战",
    totalDays: 2,
    weeklyHours: 8,
    startDate: "2026-10-01",
    createdAt: "2026-10-01T00:00:00.000Z",
    phases: [{ id: "p1", title: "阶段1", outcome: "能写脚本", dayIds: ["d1", "d2"], status: "passed" }],
    days: {
      d1: {
        id: "d1", phaseId: "p1", title: "Day 1：变量", status: "passed", attempts: 1,
        knowledgePoints: [{ id: "k1", text: "变量赋值", masteryStatus: "independent", historicalHighest: "independent" }],
        resources: [], acceptance: [], method: "",
      },
      d2: {
        id: "d2", phaseId: "p1", title: "Day 2：控制流", status: "passed", attempts: 1,
        knowledgePoints: [{ id: "k2", text: "if/else", masteryStatus: "transferable", historicalHighest: "transferable" }],
        resources: [], acceptance: [], method: "",
      },
    },
  },
  ...over,
});

describe("runGraduation 结业回路", () => {
  beforeEach(() => {
    useAppStore.setState({
      goals: [mkGoal()],
      knowledge: [],
      books: [],
      sessions: [],
      customPersonas: [],
      folders: [],
    } as never);
    vi.mocked(streamChat).mockReset();
  });

  it("生成结业笔记：写进第二大脑并标记 graduatedAt", async () => {
    vi.mocked(streamChat).mockResolvedValue(
      JSON.stringify({
        noteMarkdown: "# 结业\n\n你最终能独立写数据脚本，核心能力是变量与控制流。",
        nextSteps: ["做一个真实的数据清洗脚本", "补一点异常处理", "读一份官方最佳实践"],
      })
    );
    const r = await runGraduation("g1");
    expect(r.ok).toBe(true);
    expect(r.noteId).toBeTruthy();

    const st = useAppStore.getState();
    const g = st.goals[0];
    expect(g.graduatedAt).toBeTruthy();
    expect(g.needsGraduation).toBeFalsy();
    expect(g.nextSteps?.length).toBe(3);

    const note = st.knowledge.find((k) => k.title === "结业 · Python");
    expect(note).toBeTruthy();
    expect(note!.body).toContain("下一步");
    expect(note!.body).toContain("2/2 天");          // 完成度落进笔记
    expect(note!.body).toContain("能迁移");           // 掌握分布落进笔记
  });

  it("幂等：已结业的目标再调用不重复生成笔记、不再调模型", async () => {
    vi.mocked(streamChat).mockResolvedValue(
      JSON.stringify({ noteMarkdown: "# 结业\n\n第一版结业内容，足够长以通过校验。", nextSteps: ["A"] })
    );
    await runGraduation("g1");
    const calls = vi.mocked(streamChat).mock.calls.length;
    const noteCount = useAppStore.getState().knowledge.filter((k) => k.title === "结业 · Python").length;
    expect(noteCount).toBe(1);

    const again = await runGraduation("g1");
    expect(again.ok).toBe(true);
    expect(vi.mocked(streamChat).mock.calls.length).toBe(calls);   // 没再调模型
    expect(useAppStore.getState().knowledge.filter((k) => k.title === "结业 · Python").length).toBe(1);
  });

  it("模型失败时不标记结业，目标仍保持完成态（可重试）", async () => {
    vi.mocked(streamChat).mockRejectedValue(new Error("模型 45 秒没响应"));
    const r = await runGraduation("g1");
    expect(r.ok).toBe(false);
    const g = useAppStore.getState().goals[0];
    expect(g.status).toBe("done");
    expect(g.graduatedAt).toBeFalsy();     // 没写成结业，下次还能重试
    expect(useAppStore.getState().knowledge.length).toBe(0);
  });

  it("目标不存在时安全返回", async () => {
    const r = await runGraduation("nope");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不存在");
  });
});
