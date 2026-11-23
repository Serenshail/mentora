import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import type { CouncilSession, CustomPersona } from "../types";

/* ===== 批次 D 主体（C03/C04）：共享讨论引擎 + run_discussion/set_participants 验收场景 =====
 * 真实 store + 可控 streamChat mock（模拟测试；真实模型验收单列，见报告）。
 * 场景对齐用户验收标准表：同名消歧 / 继续讨论 / 调整阵容 / 一席失败 /
 * 不足两席 / 重试（席位/主持）/ 用户停止 / 并发发起 / 切删会话。 */

/* 可控 mock：每个用例通过 chatImpl 注入行为；calls 记录每次调用的关键参数 */
interface ChatCall {
  mode?: string;
  personaId?: string;
  name?: string;
  messages: { role: string; content: string }[];
  names?: string;
  takes?: string;
  question?: string;
}
let chatImpl: (call: ChatCall, signal: AbortSignal) => Promise<string> = async () => "";
const calls: ChatCall[] = [];
vi.mock("@/lib/ai/client", () => ({
  /* streamChat 真实签名：{ task, args: { mode/name/takes... }, messages, signal } */
  streamChat: (req: { args?: Record<string, unknown>; messages?: { role: string; content: string }[]; signal?: AbortSignal }) => {
    const inner = (req.args ?? {}) as Record<string, unknown>;
    const call: ChatCall = {
      mode: inner.mode as string | undefined,
      personaId: inner.personaId as string | undefined,
      name: inner.name as string | undefined,
      names: inner.names as string | undefined,
      takes: inner.takes as string | undefined,
      question: inner.question as string | undefined,
      messages: req.messages ?? [],
    };
    calls.push(call);
    return chatImpl(call, req.signal ?? new AbortController().signal);
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

import { runDiscussion, isSessionBusy } from "../agent/council-engine";
import { seatById } from "../ai/persona-meta";
import { executeTool, executeAction } from "../agent/tool-executors";

const persona = (id: string, name: string): CustomPersona =>
  ({ id, name, tag: "", bio: "", color: "violet", identityNote: "", system: `SYS-${name}`, createdAt: "2026-11-01" }) as CustomPersona;

const sess = (): CouncilSession => ({
  id: "s1",
  personaId: "roundtable",
  participants: ["naval", "jobs", "taleb"],
  title: "要不要辞职创业",
  messages: [{ id: "m0", role: "user", content: "我在纠结要不要辞职创业，存款只够两年。", at: "2026-11-01T00:00:00Z" }],
  createdAt: "2026-11-01",
});

const fresh = () => {
  useAppStore.setState({
    sessions: [sess()],
    customPersonas: [persona("custom:feynman", "费曼"), persona("custom:munger", "芒格")],
    goals: [],
    books: [],
    knowledge: [],
  } as Partial<ReturnType<typeof useAppStore.getState>>);
  calls.length = 0;
  chatImpl = async (call) => {
    if (call.mode === "take") return `${call.name}的发言`;
    if (call.mode === "host") return "主持人纪要";
    return "单轮回复";
  };
};

beforeEach(fresh);

const seatPersonasOf = () =>
  (useAppStore.getState().sessions[0].participants ?? []).map((id) => ({
    id,
    name: seatById(id)?.name ?? id,
    system: undefined,
  }));

describe("C03 继续讨论：真实执行并写回原会话", () => {
  it("focus 作为新约束进入席位问题（原议题+最近讨论+新增约束），结果写回原会话", async () => {
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "重点讨论实施风险，加入费曼" });
    expect(out.result.ok).toBe(true);
    const res = await executeAction(out.action!);
    expect(res.ok).toBe(true);
    /* 席位收到合成上下文：原议题 + 新增约束都在 */
    const takeCall = calls.find((c) => c.mode === "take")!;
    expect(takeCall).toBeTruthy();
    expect(takeCall.messages[0].content).toContain("辞职创业");
    expect(takeCall.messages[0].content).toContain("实施风险");
    /* 结果写回原会话：用户消息 + 3 席发言 + 主持纪要 */
    const msgs = useAppStore.getState().sessions[0].messages;
    expect(msgs.some((m) => m.role === "user" && m.content.includes("实施风险"))).toBe(true);
    expect(msgs.filter((m) => m.content.startsWith("**【")).length).toBe(3);
    expect(msgs.some((m) => m.content.startsWith("## 圆桌纪要"))).toBe(true);
    /* 结果入口指向 /council */
    expect(res.content).toContain("/council");
  });

  it("完成后 pendingRetry 清空", async () => {
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "讨论机会成本" });
    await executeAction(out.action!);
    expect(useAppStore.getState().sessions[0].pendingRetry ?? null).toBeNull();
  });
});

describe("同名会话消歧", () => {
  it("两个同名会话 → 候选列表，不执行", async () => {
    useAppStore.setState((s) => ({
      sessions: [...s.sessions, { ...sess(), id: "s2", participants: ["p-naval", "p-jobs"] }],
    }));
    const out = await executeTool("run_discussion", { title: "要不要辞职创业", focus: "x" });
    expect(out.result.content).toContain("个相近会话");
    expect(out.action).toBeUndefined();
    expect(calls.length).toBe(0);
  });
});

describe("C04 调整阵容", () => {
  it("差异预览含新增/移出；批准后下一轮阵容生效，历史发言保留", async () => {
    const out = await executeTool("set_participants", { title: "辞职创业", participants: ["naval", "custom:feynman", "custom:munger"] });
    expect(out.result.ok).toBe(true);
    expect(out.action!.payload.preview).toContain("新增：费曼");
    expect(out.action!.payload.preview).toContain("移出");
    expect(out.action!.payload.preview).toContain("下一轮");
    const msgsBefore = useAppStore.getState().sessions[0].messages.length;
    await executeAction(out.action!);
    const s = useAppStore.getState().sessions[0];
    expect(s.participants).toEqual(["naval", "custom:feynman", "custom:munger"]);
    expect(s.messages.length).toBe(msgsBefore); // 历史发言保留
  });

  it("执行中拒绝换人（不能中途偷换阵容）", async () => {
    /* 手动登记 busy 模拟引擎执行中 */
    /* 引擎互斥以 runDiscussion 起止为准——这里直接发起一轮慢速讨论占住 busy */
    chatImpl = () => new Promise((resolve) => setTimeout(() => resolve("慢"), 120));
    const runP = runDiscussion({
      sessionId: "s1",
      question: "q",
      participants: seatPersonasOf(),
      mode: "roundtable",
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(isSessionBusy("s1")).toBe(true);
    const out = await executeTool("set_participants", { title: "辞职创业", participants: ["p-naval", "p-jobs"] });
    expect(out.result.ok).toBe(false);
    expect(out.result.content).toContain("正在执行");
    await runP;
    expect(isSessionBusy("s1")).toBe(false);
  });
});

describe("一席失败：失败残片不进纪要 + 部分完成", () => {
  it("1 席失败：纪要只用完成席位；失败席位进入 pendingRetry", async () => {
    chatImpl = async (call) => {
      if (call.mode === "take" && call.name === "Steve Jobs") throw new Error("上游炸了");
      if (call.mode === "host") return "按完成席位生成的纪要";
      return `${call.name}的发言`;
    };
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "x" });
    const res = await executeAction(out.action!);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("部分完成");
    /* 主持人的 takes 只含完成席位——失败残片不进纪要 */
    const hostCall = calls.find((c) => c.mode === "host")!;
    expect(hostCall.takes).toContain("Naval Ravikant的发言");
    expect(hostCall.takes).not.toContain("Steve Jobs");
    /* 失败席位消息写进历史（承诺可重试），纪要也写回 */
    const msgs = useAppStore.getState().sessions[0].messages;
    expect(msgs.some((m) => m.content.includes("Steve Jobs") && m.content.includes("发言失败"))).toBe(true);
    expect(msgs.some((m) => m.content.startsWith("## 圆桌纪要"))).toBe(true);
    /* pendingRetry 持久化：失败席位可跨轮重试 */
    const pr = useAppStore.getState().sessions[0].pendingRetry!;
    expect(pr.failedSeatIds).toEqual(["jobs"]);
    expect(pr.goodTakes["naval"]).toBeTruthy();
  });

  it("两席失败（<2 席完整发言）→ 不生成纪要", async () => {
    chatImpl = async (call) => {
      if (call.mode === "take" && (call.name === "Steve Jobs" || call.name === "Nassim Taleb")) throw new Error("炸");
      return `${call.name}的发言`;
    };
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "x" });
    const res = await executeAction(out.action!);
    expect(res.content).toContain("不足 2 席");
    expect(calls.some((c) => c.mode === "host")).toBe(false); // 未调用主持人
    expect(useAppStore.getState().sessions[0].pendingRetry!.failedSeatIds.length).toBe(2);
  });
});

describe("重试：已完成席位不重复调用，主持可单独重试", () => {
  beforeEach(async () => {
    /* 预置一轮部分失败 */
    chatImpl = async (call) => {
      if (call.mode === "take" && call.name === "Steve Jobs") throw new Error("炸");
      if (call.mode === "host") return "第一份纪要";
      return `${call.name}的发言`;
    };
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "x" });
    await executeAction(out.action!);
    calls.length = 0;
    chatImpl = async (call) => (call.mode === "host" ? "补答后的纪要" : `${call.name}的补答`);
  });

  it("retry=true：只重跑失败席位 + 重出纪要；已完成席位不再调用", async () => {
    const out = await executeTool("run_discussion", { title: "辞职创业", retry: true });
    expect(out.result.ok).toBe(true);
    await executeAction(out.action!);
    const takeSeats = calls.filter((c) => c.mode === "take").map((c) => c.name);
    expect(takeSeats).toEqual(["Steve Jobs"]); // 只有失败席位被重跑
    expect(calls.some((c) => c.mode === "host")).toBe(true);
    const msgs = useAppStore.getState().sessions[0].messages;
    expect(msgs.filter((m) => m.content.startsWith("## 圆桌纪要")).length).toBe(2); // 补答后重出第二份
    expect(useAppStore.getState().sessions[0].pendingRetry ?? null).toBeNull(); // 全部完成清空
  });

  it("主持人失败：复用已完成发言单独重试，席位零调用", async () => {
    /* 重置场景：主持失败 */
    fresh();
    chatImpl = async (call) => {
      if (call.mode === "host") throw new Error("主持炸了");
      return `${call.name}的发言`;
    };
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "x" });
    const res = await executeAction(out.action!);
    expect(res.ok).toBe(false);
    expect(useAppStore.getState().sessions[0].pendingRetry!.hostFailed).toBe(true);
    const seatCount = calls.filter((c) => c.mode === "take").length;
    calls.length = 0;
    chatImpl = async () => "重试后的纪要";
    const out2 = await executeTool("run_discussion", { title: "辞职创业", retry: true });
    await executeAction(out2.action!);
    expect(calls.filter((c) => c.mode === "take").length).toBe(0); // 席位零调用
    expect(calls.some((c) => c.mode === "host")).toBe(true);
    expect(useAppStore.getState().sessions[0].messages.some((m) => m.content.startsWith("## 圆桌纪要"))).toBe(true);
    void seatCount;
    void res;
  });
});

describe("用户停止：不再启动后续请求，迟到结果不写入，已完成内容保留", () => {
  it("席位阶段停止：cancelled，后续席位/主持不调用，已完成的发言保留", async () => {
    const ac = new AbortController();
    chatImpl = async (call, signal) => {
      if (call.name === "Nassim Taleb") {
        /* 第二个席位等 abort 后才返回——迟到结果不得写入 */
        await new Promise((r) => setTimeout(r, 120));
        if (signal.aborted) throw new Error("aborted");
        return "迟到发言";
      }
      return `${call.name}的发言`;
    };
    const runP = runDiscussion({
      sessionId: "s1",
      question: "停止测试",
      participants: seatPersonasOf(),
      mode: "roundtable",
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    const result = await runP;
    expect(result.status).toBe("cancelled");
    /* 已完成的席位发言保留 */
    const msgs = useAppStore.getState().sessions[0].messages;
    expect(msgs.some((m) => m.content.includes("的发言"))).toBe(true);
    /* 迟到结果未写入、主持未调用 */
    expect(msgs.some((m) => m.content.includes("迟到发言"))).toBe(false);
    expect(calls.some((c) => c.mode === "host")).toBe(false);
  });
});

describe("并发发起：同会话不重复讨论、不交叉写入", () => {
  it("第二轮 runDiscussion 在第一轮执行中被拒绝", async () => {
    chatImpl = () => new Promise((resolve) => setTimeout(() => resolve("慢发言"), 150));
    const first = runDiscussion({
      sessionId: "s1",
      question: "第一轮",
      participants: seatPersonasOf(),
      mode: "roundtable",
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    const second = await runDiscussion({
      sessionId: "s1",
      question: "第二轮",
      participants: seatPersonasOf(),
      mode: "roundtable",
      signal: new AbortController().signal,
    });
    expect(second.status).toBe("failed"); // 互斥拒绝
    expect(second.savedMessages).toBe(0);
    await first;
    const userMsgs = useAppStore.getState().sessions[0].messages.filter((m) => m.role === "user" && m.content === "第一轮");
    expect(userMsgs.length).toBe(1); // 第二轮没有交叉写入（seed 会话的历史消息不计入）
  });
  it("工具校验层同样拒绝执行中的会话", async () => {
    chatImpl = () => new Promise((resolve) => setTimeout(() => resolve("慢"), 150));
    const runP = runDiscussion({
      sessionId: "s1",
      question: "q",
      participants: seatPersonasOf(),
      mode: "roundtable",
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "x" });
    expect(out.result.ok).toBe(false);
    expect(out.result.content).toContain("正在执行");
    await runP;
  });
});

describe("删除会话：不串写、不复活", () => {
  it("会话被删除后迟到写入 no-op，会话不复活", async () => {
    const ac = new AbortController();
    chatImpl = async (call, signal) => {
      await new Promise((r) => setTimeout(r, 80));
      void signal;
      return `${call.name}的发言`;
    };
    const runP = runDiscussion({
      sessionId: "s1",
      question: "删除测试",
      participants: seatPersonasOf(),
      mode: "roundtable",
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 20));
    useAppStore.getState().removeSession("s1"); // 执行中删除
    await runP;
    expect(useAppStore.getState().sessions.find((s) => s.id === "s1")).toBeUndefined();
  });
});

describe("单人会话（C03 单人模式）", () => {
  it("single 模式：历史与新增约束进入消息，回复写回原会话", async () => {
    useAppStore.setState((s) => ({
      sessions: [{ ...(s.sessions[0]), personaId: "naval", participants: undefined, messages: [{ id: "m0", role: "user", content: "上次聊到一半的问题", at: "2026-11-01" }] }],
    }));
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "继续展开风险部分" });
    expect(out.result.ok).toBe(true);
    await executeAction(out.action!);
    const call = calls[0];
    expect(call.mode).toBe("single");
    expect(call.messages[0].content).toContain("上次聊到一半的问题"); // 历史带入
    expect(call.messages[call.messages.length - 1].content).toContain("风险部分");
    expect(useAppStore.getState().sessions[0].messages.some((m) => m.role === "assistant" && m.content.includes("单轮回复"))).toBe(true);
  });
});

/* ===== 批次 D 补充：重复批准防护（并发互斥 ≠ 幂等） ===== */
describe("重复批准：同一审批动作执行中/完成后重复提交都被忽略", () => {
  it("执行中重复提交 executeAction 同一动作 → 拒绝，模型调用不翻倍", async () => {
    chatImpl = () => new Promise((resolve) => setTimeout(() => resolve("慢发言"), 150));
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "慢讨论" });
    const action = out.action!;
    const first = executeAction(action);
    await new Promise((r) => setTimeout(r, 30)); // 第一轮执行中
    const second = await executeAction(action);  // 同一动作重复提交
    expect(second.ok).toBe(false);
    expect(second.content).toContain("已执行过");
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    /* 模型调用只发生一轮：3 席 + 1 主持 */
    const takeCalls = calls.filter((c) => c.mode === "take").length;
    expect(takeCalls).toBe(3);
    expect(calls.filter((c) => c.mode === "host").length).toBe(1);
    /* 问题只追加一次、纪要只保存一份 */
    const msgs = useAppStore.getState().sessions[0].messages;
    expect(msgs.filter((m) => m.role === "user" && m.content.includes("慢讨论")).length).toBe(1);
    expect(msgs.filter((m) => m.content.startsWith("## 圆桌纪要")).length).toBe(1);
  });

  it("执行完成后重复提交同一动作 → 拒绝；重试作为新动作不受影响", async () => {
    const out = await executeTool("run_discussion", { title: "辞职创业", focus: "正常讨论" });
    const action = out.action!;
    const first = await executeAction(action);
    expect(first.ok).toBe(true);
    const msgsBefore = useAppStore.getState().sessions[0].messages.length;
    const again = await executeAction(action); // 完成后原卡重复提交
    expect(again.ok).toBe(false);
    expect(again.content).toContain("已执行过");
    expect(useAppStore.getState().sessions[0].messages.length).toBe(msgsBefore); // 无新增写入
    /* 重试失败部分 = 新的审批动作（新 id）→ 正常执行 */
    chatImpl = async (call) => {
      if (call.mode === "take" && call.name === "Steve Jobs") throw new Error("炸");
      return `${call.name}的发言`;
    };
    const out2 = await executeTool("run_discussion", { title: "辞职创业", focus: "部分失败一轮" });
    await executeAction(out2.action!); // 产生 pendingRetry
    calls.length = 0;
    chatImpl = async () => "补答";
    const retryOut = await executeTool("run_discussion", { title: "辞职创业", retry: true });
    const retryResult = await executeAction(retryOut.action!); // 新动作 id
    expect(retryResult.ok).toBe(true);
    expect(calls.filter((c) => c.mode === "take").map((c) => c.name)).toEqual(["Steve Jobs"]);
  });
});