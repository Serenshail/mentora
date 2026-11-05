"use client";

/* 智能体工具循环执行器（v2，通用 harness）
 *
 * 对应 codex 的 run_turn：模型输出 → 解析工具调用 → 执行 → 结果回注 → 再问模型，
 * 直到模型不再调用工具或达到 MAX_TOOL_ROUNDS。
 *
 * v2 与 v1 的差异：
 *  - 双通道工具调用：原生 tool_calls 优先（服务端聚合 t=tc），文本围栏协议兜底（网关不支持时）
 *  - 统一审批门：写入工具生成 PendingAction，经 requestApproval 回调等用户批准/拒绝后继续，
 *    拒绝结果回注模型（工具状态 declined），不再"遇到第一个写操作就结束本轮"
 *  - 打转守卫：同一「工具+参数」连续两轮重复 → 强制收尾（v1 的全程同名去重已删，允许重复调用）
 *  - 计划单步推进（修复 v1 每轮双推进 bug）
 *  - 产出 RunMeta（plan/tools/citations）随最终回答返回，由 UI 持久化到消息
 */
import { streamChat, type WireMsg, type WireToolCall } from "@/lib/ai/client";
import { parseDirectives, stripDirectives } from "./parse";
import { executeTool, executeAction, type Citation } from "./tool-executors";
import { TOOLS, type ToolName } from "./protocol";
import { uid } from "@/lib/utils";
import {
  MAX_TOOL_ROUNDS,
  callSignature,
  stepPlanForward,
  type ApprovalDecision,
  type PendingAction,
  type PlanStep,
  type ToolCall,
  type ToolResult,
} from "./protocol";

export type { PendingAction } from "./protocol";
export type { Citation } from "./tool-executors";

export interface RunMeta {
  plan: PlanStep[];
  tools: ToolCall[];
  citations: Citation[];
}

export interface RunCallbacks {
  onPhase: (phase: "thinking" | "acting" | "answering" | "done" | "failed" | "cancelled") => void;
  onPlan: (plan: PlanStep[]) => void;
  onTool: (tool: ToolCall) => void;
  onReasoning: (summary: string) => void;
  onDelta: (text: string) => void;
  /** 审批门：写入工具挂起等待用户决定；UI 展示确认卡并 resolve 结果 */
  requestApproval: (actions: PendingAction[]) => Promise<ApprovalDecision[]>;
}

/** 最终回答 + 过程产物（UI 持久化 meta 到消息上） */
export interface AgentRunResult {
  answer: string;
  meta: RunMeta;
}

/** 解析一轮模型输出里的工具调用：原生优先，围栏兜底 */
function collectCalls(
  text: string,
  native: WireToolCall[]
): { name: ToolName; args: Record<string, unknown>; nativeId?: string }[] {
  const out: { name: ToolName; args: Record<string, unknown>; nativeId?: string }[] = [];
  for (const c of native) {
    if (!(c.name in TOOLS)) continue;
    let args: Record<string, unknown> = {};
    try {
      args = (JSON.parse(c.argsRaw || "{}") as Record<string, unknown>) ?? {};
    } catch { /* 坏参数按空参执行，让工具报参数缺失 */ }
    out.push({ name: c.name as ToolName, args, nativeId: c.id });
  }
  if (out.length === 0) {
    const { tools } = parseDirectives(text);
    for (const t of tools ?? []) out.push({ name: t.name, args: t.args });
  }
  return out;
}

/**
 * 运行一轮智能体对话（含工具循环与审批门）。
 * 返回最终回答与过程产物；过程中通过 callbacks 汇报状态。
 */
export async function runAgent(opts: {
  question: string;
  /** 已含业务上下文（学习状态、笔记证据等）；工具结果按通道回注 */
  context: string;
  /** 附件图片（data URL），只在首轮发送 */
  imageUrl?: string | null;
  history: { role: "user" | "assistant"; content: string }[];
  deep: boolean;
  signal: AbortSignal;
  cb: RunCallbacks;
}): Promise<AgentRunResult> {
  const { question, imageUrl, history, deep, signal, cb } = opts;
  const context: string = opts.context;

  let plan: PlanStep[] = [];
  const toolsUsed: ToolCall[] = [];
  const citations: Citation[] = [];
  let lastAnswer = "";

  /* 显式维护对话：history 已包含本轮用户消息，首轮直接用它 */
  const convo: WireMsg[] = [...history];
  let firstRound = true;
  /* 打转守卫：上一轮的工具调用签名集合 */
  let lastRoundSigs = new Set<string>();
  /* 原生通道状态：网关拒收 tools 后切围栏，本轮 run 内不再声明 nativeTools */
  let nativeOff = false;
  /* 工具结果累积（围栏通道回注 ctx 用） */
  const toolLog: string[] = [];

  const answer = async (): Promise<AgentRunResult> => ({
    answer: lastAnswer,
    meta: { plan, tools: toolsUsed, citations },
  });

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) {
      cb.onPhase("cancelled");
      return answer();
    }
    cb.onPhase(round === 0 ? "thinking" : "acting");

    let turnMessages: WireMsg[];
    if (firstRound && imageUrl) {
      /* 首轮且带图：把最后一条用户文本换成多模态数组 */
      turnMessages = [
        ...convo.slice(0, -1),
        {
          role: "user",
          content: [
            { type: "text", text: question || "请讲讲这张图。" },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ];
    } else {
      turnMessages = convo;
    }
    firstRound = false;

    let buf = "";
    const native: WireToolCall[] = [];
    const full = await streamChat({
      task: "agent",
      args: {
        ctx: [context, ...toolLog].filter(Boolean).join("\n\n"),
        deep,
        hasImage: !!imageUrl && round === 0,
        round,
        nativeTools: !nativeOff,
      },
      messages: turnMessages,
      temperature: deep ? 0.5 : 0.6,
      signal,
      onDelta: (d) => {
        buf += d;
        cb.onDelta(d);
      },
      onThink: (t) => cb.onReasoning(t),
      onToolCalls: (calls) => native.push(...calls),
      onNativeOff: () => {
        nativeOff = true;
      },
    });
    if (signal.aborted) {
      cb.onPhase("cancelled");
      lastAnswer = stripDirectives(full) || lastAnswer;
      return answer();
    }

    const { plan: planDraft } = parseDirectives(full);
    if (planDraft && plan.length === 0) {
      plan = planDraft.map((text, i) => ({
        id: `s${i}`,
        text,
        status: i === 0 ? "in_progress" : "pending",
      }));
      cb.onPlan(plan);
    }

    const calls = collectCalls(full, native);

    /* 没有工具调用 → 这就是最终回答；正文为空时补一次（模型只在思维链里想） */
    if (calls.length === 0) {
      const cleaned = stripDirectives(full);
      if (cleaned) {
        cb.onPhase("answering");
        lastAnswer = cleaned;
        return answer();
      }
      cb.onPhase("answering");
      const retry = await streamChat({
        task: "agent",
        args: {
          ctx: [context, ...toolLog].filter(Boolean).join("\n\n"),
          deep,
          hasImage: false,
          round: 99,
          noTools: true,
        },
        messages: [
          ...convo,
          {
            role: "user",
            content: "只输出最终答案（自然语言，不要任何代码块、不要解释你在做什么）。用户问的是：" + (question || "请讲解上面的图片"),
          },
        ],
        temperature: deep ? 0.5 : 0.6,
        signal,
        onDelta: (d) => cb.onDelta(d),
      });
      const txt = stripDirectives(retry);
      lastAnswer = txt || "（这次没能生成答案，请再问一次。）";
      cb.onPhase("done");
      return answer();
    }

    /* 打转守卫：与上一轮完全相同的调用 → 强制收尾 */
    const sigs = calls.map((c) => callSignature(c.name, c.args));
    const isStuck = sigs.some((s) => lastRoundSigs.has(s));
    if (isStuck) {
      cb.onPhase("answering");
      const stock = stripDirectives(full);
      const forced = await streamChat({
        task: "agent",
        args: {
          ctx: [context, ...toolLog].filter(Boolean).join("\n\n"),
          deep,
          hasImage: false,
          round: 99,
          noTools: true,
        },
        messages: [
          ...convo,
          { role: "assistant", content: full || "（工具调用重复）" },
          {
            role: "user",
            content:
              "停止调用工具：你在重复完全相同的调用，不会得到新信息。你已经有足够信息了，现在只用自然语言回答用户的原始问题：" +
              (question || "请讲解上面的图片") +
              "。",
          },
        ],
        temperature: deep ? 0.5 : 0.6,
        signal,
        onDelta: (d) => cb.onDelta(d),
        onThink: (t) => cb.onReasoning(t),
      });
      lastAnswer = stripDirectives(forced) || stock;
      cb.onPhase("done");
      return answer();
    }
    lastRoundSigs = new Set(sigs);

    /* 执行本批工具（并行）：读工具直接跑，写工具产 PendingAction */
    const started = calls.map((c) => {
      const call: ToolCall = {
        id: c.nativeId || uid("tc"),
        name: c.name,
        args: c.args,
        status: "in_progress",
        startedAt: Date.now(),
      };
      toolsUsed.push(call);
      cb.onTool({ ...call });
      return call;
    });

    const outcomes = await Promise.all(
      calls.map(async (c, i) => {
        const call = started[i];
        let result: ToolResult;
        let action: PendingAction | undefined;
        let cites: Citation[] | undefined;
        try {
          const out = await executeTool(c.name, c.args);
          result = out.result;
          action = out.action;
          cites = out.citations;
        } catch (e) {
          result = {
            ok: false,
            content: `工具执行失败：${e instanceof Error ? e.message : "未知错误"}`,
            summary: "执行失败",
          };
        }
        if (cites) citations.push(...cites);
        const finished: ToolCall = {
          ...call,
          status: result.ok ? "completed" : "failed",
          summary: result.summary,
          endedAt: Date.now(),
        };
        const idx = toolsUsed.findIndex((x) => x.id === call.id);
        if (idx >= 0) toolsUsed[idx] = finished;
        cb.onTool(finished);
        return { call, result, action };
      })
    );

    /* 审批门：写入动作挂起等待用户决定；拒绝记 declined 并回注模型 */
    const actions = outcomes.map((o) => o.action).filter((a): a is PendingAction => Boolean(a));
    let decisions: ApprovalDecision[] = [];
    if (actions.length > 0) {
      cb.onPhase("answering");
      decisions = await cb.requestApproval(actions);
    }
    const decisionOf = (a: PendingAction) => decisions.find((d) => d.actionId === a.id);

    /* 已完成的全部工具结果（含批准执行/拒绝）统一回注 */
    const feedbacks = await Promise.all(
      outcomes.map(async (o) => {
        const action = o.action;
        if (!action) {
          return { call: o.call, result: o.result, toolCallId: o.call.id, native: true };
        }
        const d = decisionOf(action);
        const idx = toolsUsed.findIndex((x) => x.id === o.call.id);
        if (!d || d.approved) {
          const result = await executeAction(action);
          const finished: ToolCall = {
            ...o.call,
            status: result.ok ? "completed" : "failed",
            summary: result.summary,
            endedAt: Date.now(),
          };
          if (idx >= 0) toolsUsed[idx] = finished;
          cb.onTool(finished);
          return { call: finished, result, toolCallId: o.call.id, native: true };
        }
        /* 用户拒绝 */
        const declined: ToolCall = { ...o.call, status: "declined", summary: "用户拒绝了", endedAt: Date.now() };
        if (idx >= 0) toolsUsed[idx] = declined;
        cb.onTool(declined);
        return {
          call: declined,
          result: { ok: false, content: "用户拒绝了这次操作。不要重复发起同样的操作；如有必要换一种方式，或直接继续对话。", summary: "已拒绝" } satisfies ToolResult,
          toolCallId: o.call.id,
          native: true,
        };
      })
    );

    /* 回注：
     * - 原生通道（或曾经原生）：assistant(tool_calls) + role:"tool" 消息（route 仅 agent 放行）
     * - 围栏通道：toolLog 累积 + 合成 user 消息 */
    const nativeCallsThisRound = native.filter((c) => c.name in TOOLS);
    if (nativeCallsThisRound.length > 0) {
      convo.push({
        role: "assistant",
        content: full || "",
        tool_calls: nativeCallsThisRound.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.argsRaw || "{}" },
        })),
      });
      for (const f of feedbacks) {
        convo.push({ role: "tool", tool_call_id: f.toolCallId, content: f.result.content });
      }
    } else {
      for (const f of feedbacks) {
        toolLog.push(`### 工具 ${f.call.name} 的真实返回\n${f.result.content}`);
      }
      /* 围栏通道没有 tool 角色消息，需要一条引导告诉模型结果已就位、
       * 可以继续调用工具（换参数）或直接收尾——不强制答案，保留多轮能力 */
      convo.push({ role: "assistant", content: full });
      convo.push({
        role: "user",
        content:
          "（系统提示）工具结果已注入你的上下文。信息不够就再调用工具（换工具或换参数，不要原样重复）；足够了就直接给出最终回答。",
      });
    }

    // 计划单步推进（v1 在此处推了两遍，属 bug）
    if (plan.length > 0) {
      plan = stepPlanForward(plan);
      cb.onPlan(plan);
    }

    lastAnswer = stripDirectives(full);

    if (round === MAX_TOOL_ROUNDS) {
      cb.onPhase("failed");
      return {
        answer: `${lastAnswer || ""}\n\n（已达到单轮工具调用上限 ${MAX_TOOL_ROUNDS} 次，先停在这里。需要继续可以再问一次。）`.trim(),
        meta: { plan, tools: toolsUsed, citations },
      };
    }
  }

  cb.onPhase("done");
  return answer();
}

/* 保留给老引用：parse/strip 仍可从 runner 导入（向后兼容） */
export { parseDirectives, stripDirectives } from "./parse";
