import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import type { CouncilSession } from "../types";
import { parseDirectives, stripDirectives } from "../agent/parse";
import { TOOLS } from "../agent/protocol";
import { diffPhaseDays, normalizeChanges, computePhaseEdit, planSignature } from "../agent/phase-edit";
import type { Goal, Phase } from "../types";

/* ============ 修复批 b12 回归锁（20 条发现的纯函数/契约部分） ============
 * 只锁「改前必失败、改后必通过」的确定性行为；跨文件结构性条目（账本口径、
 * 并发重验）在实现处有注释与调用方，不在此重复断言实现细节。 */

describe("parse.ts：stripDirectives 不再吞正常教学内容", () => {
  it("句中含「禁止/只给」的教学句完整保留（此前整句被删）", () => {
    const a = "在 C 语言里，gets 函数是禁止使用的，因为缓冲区溢出风险。建议改用 fgets。";
    expect(stripDirectives(a)).toBe(a);
    const b = "老师只给了一个提示，剩下的要自己推导。第一步先写出边界条件。";
    expect(stripDirectives(b)).toBe(b);
  });

  it("模型复述指令的句子仍被删除（句首即规则词）", () => {
    expect(stripDirectives("这里是答案。\n不要输出解释。")).toBe("这里是答案。");
    expect(stripDirectives("（不要输出解释）闭包是函数加词法作用域。")).toBe("");
  });

  it("独立成行的中文引号对白保留；纯残留字符串仍删", () => {
    const dialogue = '回答正文\n"好的，我们明天开始"\n尾部';
    expect(stripDirectives(dialogue)).toContain('"好的，我们明天开始"');
    expect(stripDirectives('回答正文\n"一个字符串残留"\n尾部')).toBe("回答正文\n\n尾部");
  });
});

describe("parse.ts：parseDirectives 校验与坏块上报", () => {
  it("原型链属性不得穿过工具名校验（Object.hasOwn）", () => {
    expect("toString" in TOOLS).toBe(true); // 前提：in 会命中原型链
    const d = parseDirectives('```tool\n{"name":"toString"}\n```');
    expect(d.tool).toBeUndefined();
    expect(d.badToolBlocks).toBe(1);
  });

  it("坏 JSON tool 块计入 badToolBlocks（不再静默丢弃）", () => {
    const d = parseDirectives("```tool\n{broken\n```\n正常回答");
    expect(d.tool).toBeUndefined();
    expect(d.badToolBlocks).toBe(1);
  });

  it("合法 tool 块 badToolBlocks 为 0", () => {
    const d = parseDirectives('```tool\n{"name":"search_brain","args":{"query":"闭包"}}\n```');
    expect(d.tool?.name).toBe("search_brain");
    expect(d.badToolBlocks).toBe(0);
  });
});

describe("phase-edit.ts：normalizeChanges 对 null 项走校验失败而非抛 TypeError", () => {
  it("addPhases 含 null 不抛错", () => {
    const bad = { addPhases: [null, { title: "实战" }] } as unknown as Parameters<typeof normalizeChanges>[0];
    expect(() => normalizeChanges(bad)).not.toThrow();
    const r = normalizeChanges(bad);
    if (!r.ok) throw new Error("should be ok");
    expect(r.changes.addPhases).toEqual([{ title: "实战", outcome: undefined, estDays: undefined }]);
  });

  it("phaseCatalogs 含 null 项不抛错，该阶段被过滤", () => {
    const bad = {
      phaseCatalogs: { p1: [null], p2: [{ title: "Day 1" }] },
    } as unknown as Parameters<typeof normalizeChanges>[0];
    expect(() => normalizeChanges(bad)).not.toThrow();
    const r = normalizeChanges(bad);
    if (!r.ok) throw new Error("should be ok");
    expect(Object.keys(r.changes.phaseCatalogs ?? {})).toEqual(["p2"]);
  });
});

describe("phase-edit.ts：diffPhaseDays 保留同名天的真实计数", () => {
  it("阶段内有同名天时，oldTitles 不因 Set 去重而少计", () => {
    const days = {
      d1: { id: "d1", title: "复习" },
      d2: { id: "d2", title: "复习" },
      d3: { id: "d3", title: "实战" },
    };
    const d = diffPhaseDays(["d1", "d2", "d3"], days, ["复习", "实战"]);
    expect(d.oldTitles).toEqual(["复习", "复习", "实战"]); // 原 3 天，不是 2 天
    /* 新目录只保留一次「复习」→ 另一个「复习」进移出清单 */
    expect(d.removed).toEqual(["复习"]);
  });
});

describe("phase-edit.ts：顺序编辑的基线签名覆盖全阶段", () => {
  const mkGoal = (phases: Phase[]): Goal => ({
    id: "g-b12", topic: "P", direction: "", domainKind: "coding", motivation: "", background: "",
    weeklyHours: 5, successCriteria: [], status: "active", createdAt: "2026-11-01",
    quizLog: [], intakeTranscript: [],
    plan: {
      summary: "s", totalDays: 3, weeklyHours: 5, startDate: "2026-11-01", createdAt: "2026-11-01",
      phases,
      days: {},
    },
  });

  it("含 phaseOrder 的草稿：未被 meta 触及的阶段也进签名（并发重排会被检出）", () => {
    const phases: Phase[] = [
      { id: "p1", title: "A", outcome: "", status: "active", dayIds: [] },
      { id: "p2", title: "B", outcome: "", status: "locked", dayIds: [] },
      { id: "p3", title: "C", outcome: "", status: "locked", dayIds: [] },
    ];
    const r = computePhaseEdit(mkGoal(phases), {
      phaseMeta: { p1: { title: "A2" } },
      phaseOrder: ["p3", "p1", "p2"],
    });
    if (!r.ok) throw new Error("should be ok");
    /* 基线签名必须包含全部阶段：改 p2 的标题（未被 meta 触及）应改变签名 */
    const sig = r.draft.baseSignature;
    const p2Changed = phases.map((p) => (p.id === "p2" ? { ...p, title: "B2" } : p));
    const plan2 = mkGoal(p2Changed).plan!;
    expect(planSignature(plan2)).not.toBe(sig);
  });
});

/* ---------- 圆桌引擎：takePendingRetry 取出即清空 + 单人失败留痕 ---------- */
let chatImpl: (mode?: string) => Promise<string> = async () => "";
vi.mock("@/lib/ai/client", () => ({
  streamChat: (req: { args?: Record<string, unknown> }) => {
    const mode = (req.args ?? {}).mode as string | undefined;
    return chatImpl(mode);
  },
  extractJson: () => { throw new Error("no json"); },
  readingPlanSchema: {},
  phaseListSchema: {},
  personaDistillSchema: {},
}));
vi.mock("@/lib/track", () => ({ track: () => {}, trackReading: () => {} }));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

import { runDiscussion, takePendingRetry } from "../agent/council-engine";
import { seatById } from "../ai/persona-meta";

const seatPersonas = () =>
  ["naval", "jobs", "taleb"].map((id) => ({ id, name: seatById(id)?.name ?? id, system: undefined }));

const baseSession = (): CouncilSession => ({
  id: "s-b12",
  personaId: "roundtable",
  participants: ["naval", "jobs", "taleb"],
  title: "b12",
  messages: [],
  createdAt: "2026-11-01",
});

beforeEach(() => {
  useAppStore.setState({
    sessions: [baseSession()],
    customPersonas: [],
    goals: [],
    books: [],
    knowledge: [],
  } as Partial<ReturnType<typeof useAppStore.getState>>);
  chatImpl = async (mode) => (mode === "host" ? "纪要" : "发言");
});

describe("council-engine：takePendingRetry 契约（取出即清空）", () => {
  it("取出后会话上的 pendingRetry 被清空；无挂起时返回 null", () => {
    useAppStore.setState((s) => ({
      sessions: s.sessions.map((x) => ({
        ...x,
        pendingRetry: { question: "q", goodTakes: {}, failedSeatIds: ["jobs"], hostFailed: false },
      })),
    }));
    const pr = takePendingRetry("s-b12");
    expect(pr?.failedSeatIds).toEqual(["jobs"]);
    expect(useAppStore.getState().sessions[0].pendingRetry ?? null).toBeNull();
    expect(takePendingRetry("s-b12")).toBeNull();
  });

  it("重试轮被取消：仍待重试的席位回写，已完成席位不进 failedSeatIds", async () => {
    const ac = new AbortController();
    chatImpl = async (mode) => {
      if (mode === "take") {
        await new Promise((r) => setTimeout(r, 80));
        return "迟到发言";
      }
      return "发言";
    };
    useAppStore.setState((s) => ({
      sessions: s.sessions.map((x) => ({
        ...x,
        pendingRetry: { question: "q", goodTakes: { naval: "已有" }, failedSeatIds: ["jobs"], hostFailed: false },
      })),
    }));
    const pr = takePendingRetry("s-b12")!;
    const runP = runDiscussion({
      sessionId: "s-b12",
      question: pr.question,
      userMessage: "",
      participants: seatPersonas(),
      mode: "roundtable",
      goodTakes: pr.goodTakes,
      onlySeats: pr.failedSeatIds,
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const result = await runP;
    expect(result.status).toBe("cancelled");
    const after = useAppStore.getState().sessions[0].pendingRetry;
    expect(after).toBeTruthy();
    expect(after!.failedSeatIds).toEqual(["jobs"]); // 未完成 → 仍挂起
    expect(after!.failedSeatIds).not.toContain("naval"); // 已完成席位不重复重跑
  });
});

describe("council-engine：单人模式失败在会话里留痕", () => {
  it("streamChat 抛错时写一条带原因的失败备注，savedMessages 计入用户消息", async () => {
    useAppStore.setState((s) => ({
      sessions: [{ ...s.sessions[0], personaId: "naval", participants: undefined }],
    }));
    chatImpl = async () => { throw new Error("配额已用尽"); };
    const result = await runDiscussion({
      sessionId: "s-b12",
      question: "继续",
      participants: [{ id: "naval", name: "Naval" }],
      mode: "single",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("配额已用尽");
    const msgs = useAppStore.getState().sessions[0].messages;
    expect(msgs.some((m) => m.role === "assistant" && m.content.includes("本轮回复失败"))).toBe(true);
    expect(result.savedMessages).toBeGreaterThanOrEqual(2); // 用户消息 + 失败备注
  });
});
