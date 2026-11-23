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

/** 回归锁：结业笔记里的「掌握分布」必须按**全量**知识点统计。
 *  结业上下文为了提示词体积把知识点截到 slice(-200)（graduation.ts buildGraduationCtx），
 *  但掌握分布是写进笔记正文的结论，若从截断后的样本计数，长目标（>200 条）会只反映末尾
 *  200 条，与目标页 GraduationPanel 用全量 points 算的同名统计相互矛盾。 */

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

const TOTAL = 250;

/** 250 个知识点：最早的一条是 durable，其余 249 条 independent。
 *  截断 slice(-200) 只会留下末尾 200 条 independent——durable 恰好落在被截掉的部分。 */
const mkLongGoal = (): Goal => {
  const days: Record<string, unknown> = {};
  for (let i = 0; i < TOTAL; i++) {
    const id = `d${i}`;
    days[id] = {
      id,
      phaseId: "p1",
      title: `Day ${i + 1}`,
      status: "passed",
      attempts: 1,
      knowledgePoints: [
        {
          id: `k${i}`,
          text: `知识点 ${i + 1}`,
          masteryStatus: i === 0 ? "durable" : "independent",
          historicalHighest: i === 0 ? "durable" : "independent",
        },
      ],
      resources: [],
      acceptance: [],
      method: "",
    };
  }
  return {
    id: "g-long",
    topic: "长目标",
    direction: "",
    domainKind: "coding",
    motivation: "",
    background: "",
    weeklyHours: 8,
    successCriteria: ["走完"],
    status: "done",
    createdAt: "2026-10-01T00:00:00.000Z",
    quizLog: [],
    intakeTranscript: [],
    plan: {
      summary: "",
      totalDays: TOTAL,
      weeklyHours: 8,
      startDate: "2026-10-01",
      createdAt: "2026-10-01T00:00:00.000Z",
      phases: [{ id: "p1", title: "阶段1", outcome: "走完", dayIds: Object.keys(days), status: "passed" }],
      days: days as never,
    },
  };
};

describe("runGraduation 掌握分布按全量统计", () => {
  beforeEach(() => {
    useAppStore.setState({
      goals: [mkLongGoal()],
      knowledge: [],
      books: [],
      sessions: [],
      customPersonas: [],
      folders: [],
    } as never);
    vi.mocked(streamChat).mockReset();
    vi.mocked(streamChat).mockResolvedValue(
      JSON.stringify({ noteMarkdown: "# 结业\n\n走完了一个很长的目标。", nextSteps: ["A"] })
    );
  });

  it("超出 200 条的早期知识点仍计入掌握分布，并标注总条数", async () => {
    const r = await runGraduation("g-long");
    expect(r.ok).toBe(true);

    const note = useAppStore.getState().knowledge.find((k) => k.title === "结业 · 长目标");
    expect(note).toBeTruthy();
    const body = note!.body;

    // durable 只在第 1 条（被 slice(-200) 截掉），全量口径下必须出现
    expect(body).toContain("长期保持 1");
    expect(body).toContain("能独立完成 249");
    // 口径标注：分布覆盖 250 条，而不是模型看到的 200 条样本
    expect(body).toContain("知识点：250 条");
    // 截断样本不应渗进结论：模型只看到 200 条
    const ctxArg = JSON.parse(vi.mocked(streamChat).mock.calls[0][0].args!.ctx as string);
    expect(ctxArg.knowledgePoints.length).toBe(200);
  });
});
