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
  /* 本轮流式正文累计：中途取消时把已流出的内容保留为部分回答（否则全丢） */
  let streamed = "";
  /* 多轮回答的正文累积：带工具调用的轮次里，模型常先写出实质正文（深讲骨架的前几步）
   * 再发起工具调用（如出题）。这些正文是最终回答的一部分，不是"过渡语"——
   * 不累积的话，流式展示后会被清掉，用户看到的消息只剩最后一轮（实测丢整个讲解）。 */
  const answerParts: string[] = [];

  /* 显式维护对话：history 已包含本轮用户消息，首轮直接用它 */
  const convo: WireMsg[] = [...history];
  let firstRound = true;
  /* 打转守卫：上一轮的工具调用签名集合 */
  let lastRoundSigs = new Set<string>();
  /* 原生通道状态：网关拒收 tools 后切围栏，本轮 run 内不再声明 nativeTools */
  let nativeOff = false;
  /* 工具结果累积（围栏通道回注 ctx 用） */
  const toolLog: string[] = [];

  const answer = async (): Promise<AgentRunResult> => {
    const parts = [...answerParts];
    if (lastAnswer && parts[parts.length - 1] !== lastAnswer) parts.push(lastAnswer);
    return { answer: parts.filter(Boolean).join("\n\n"), meta: { plan, tools: toolsUsed, citations } };
  };

  /** streamChat 包装：task/温度/signal 固定，onDelta 顺带累计 streamed。
   *  中途 abort 返回 null（调用方走 cancelled 终态，不再让 AbortError 穿透成 failed），
   *  其余错误原样抛出。 */
  const chat = async (o: {
    args: Record<string, unknown>;
    messages: WireMsg[];
    onThink?: (t: string) => void;
    onToolCalls?: (calls: WireToolCall[]) => void;
    onNativeOff?: () => void;
  }): Promise<string | null> => {
    streamed = "";
    try {
      return await streamChat({
        task: "agent",
        args: o.args,
        messages: o.messages,
        temperature: deep ? 0.5 : 0.6,
        signal,
        onDelta: (d) => {
          streamed += d;
          cb.onDelta(d);
        },
        onThink: (t) => o.onThink?.(t),
        onToolCalls: (calls) => o.onToolCalls?.(calls),
        onNativeOff: () => o.onNativeOff?.(),
      });
    } catch (e) {
      if (signal.aborted || (e instanceof Error && e.name === "AbortError")) return null;
      throw e;
    }
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) {
      cb.onPhase("cancelled");
      return answer();
    }
    cb.onPhase(round === 0 ? "thinking" : "acting");

    if (firstRound && imageUrl) {
      /* 首轮且带图：把最后一条用户文本换成多模态数组。写回 convo（而非只挂本轮局部）：
       * 工具后续轮、空正文重试、强制收尾的模型同样看得到图，不再凭空「讲解上面的图片」 */
      convo[convo.length - 1] = {
        role: "user",
        content: [
          { type: "text", text: question || "请讲讲这张图。" },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      };
    }
    firstRound = false;

    const native: WireToolCall[] = [];
    const full = await chat({
      args: {
        ctx: [context, ...toolLog].filter(Boolean).join("\n\n"),
        deep,
        hasImage: !!imageUrl && round === 0,
        round,
        nativeTools: !nativeOff,
      },
      messages: convo,
      onThink: (t) => cb.onReasoning(t),
      onToolCalls: (calls) => native.push(...calls),
      onNativeOff: () => {
        nativeOff = true;
      },
    });
    if (full === null || signal.aborted) {
      cb.onPhase("cancelled");
      /* V26.2-H3：取消/断连路径的半截流同样过句子级清洗再落库 */
      lastAnswer = stripMetaSentences(trimMetaEdges(stripDirectives(full ?? streamed))) || lastAnswer;
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
      const cleaned = stripMetaSentences(trimMetaEdges(stripDirectives(full)));
      if (cleaned) {
        cb.onPhase("answering");
        lastAnswer = cleaned;
        return answer();
      }
      cb.onPhase("answering");
      const retry = await chat({
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
      });
      if (retry === null || signal.aborted) {
        cb.onPhase("cancelled");
        lastAnswer = stripMetaSentences(trimMetaEdges(stripDirectives(retry ?? streamed))) || lastAnswer;
        return answer();
      }
      const txt = stripMetaSentences(trimMetaEdges(stripDirectives(retry)));
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
      const forced = await chat({
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
        onThink: (t) => cb.onReasoning(t),
      });
      if (forced === null || signal.aborted) {
        cb.onPhase("cancelled");
        lastAnswer =
          stripMetaSentences(trimMetaEdges(stripDirectives(forced ?? streamed))) ||
          stripMetaSentences(trimMetaEdges(stock)) ||
          lastAnswer;
        return answer();
      }
      lastAnswer = stripMetaSentences(trimMetaEdges(stripDirectives(forced))) || stripMetaSentences(trimMetaEdges(stock));
      cb.onPhase("done");
      return answer();
    }
    lastRoundSigs = new Set(sigs);

    /* 本轮实质正文入列（工具轮次不等于过渡语：深讲骨架的正文常在这里产生）。
     * 短寒暄（"我查一下"）不入列；与上一段相同不重复入列；
     * 私有独白不入列——判据：提到确认卡/调用工具的元话语，或整段没有汉字。
     * 另外修剪段落首尾的无汉字行（见模块级 trimMetaEdges）。 */
    const cleanedThisRound = stripMetaSentences(trimMetaEdges(stripDirectives(full)));
    /* 写入类工具的轮次（V26.2 收口：此前 hasWriteCall 是死变量，注释与实现不符——
     * 批准后模型会给正式汇报，这里的过渡语（常是私语）一律不并入最终回答；
     * 读工具轮次保留（深讲正文常在那里产生）。 */
    const hasWriteCall = calls.some((c) => TOOLS[c.name]?.risk === "write");
    const isPrivateMeta =
      /确认卡|调用工具|先调用|批准后|等待用户|report the|call the tool|user (will see|approved)/i.test(cleanedThisRound) ||
      /* V26.2-H4：无汉字轮次不再一概当私语丢弃——改用统一判据（外语教学的整段英文讲解是真内容） */
      (!/[\u4e00-\u9fff]/.test(cleanedThisRound) && isForeignPrivateTalk(cleanedThisRound));
    if (
      cleanedThisRound &&
      cleanedThisRound.length > 60 &&
      !hasWriteCall &&
      !isPrivateMeta &&
      cleanedThisRound !== answerParts[answerParts.length - 1]
    ) {
      answerParts.push(cleanedThisRound);
    }

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

    if (round === MAX_TOOL_ROUNDS) {
      cb.onPhase("failed");
      lastAnswer = `（工具预算已用完——上面已基于获取到的信息给出回答。没讲完的部分你再发一句"继续"，我从停下的地方接着来。）`;
      return answer();
    }
  }

  cb.onPhase("done");
  return answer();
}

/** 修剪段落首尾的无汉字行：模型常以英文私语起头/收尾（"Fine. Give final answer briefly."），
 *  它们混在有中文的段落里，整段过滤会误伤内容。
 *  V26.2-H4：整段无汉字（纯英文回答/讲解）不再清空返回 ""——句子级过滤会处理其中的私语。 */
function trimMetaEdges(text: string): string {
  if (!CJK_CHAR.test(text)) return text.trim();
  const lines = text.split("\n");
  const hasCjk = (l: string) => /[\u4e00-\u9fff]/.test(l);
  let a = 0;
  let b = lines.length;
  while (a < b && !hasCjk(lines[a])) a++;
  while (b > a && !hasCjk(lines[b - 1])) b--;
  return lines.slice(a, b).join("\n").trim();
}

/* ---------- 私语句子过滤（B12） ----------
 * trimMetaEdges 只修剪段落首尾的无汉字行；混在有中文的段落**中间**的英文私语句
 * （"Fine. Give final answer briefly."、"…" to see stage list."）会漏过。
 * 这里按句子切分后逐句判定并整句剔除；代码块（```…```）整体跳过不参与过滤。 */

/** 英文私语特征词（模型自言自语/工具复述） */
const META_EN_WORDS = /report|confirm|briefly|final answer|call the|tool|stage list|give the user/i;
/** 独白式引导句干（V26.2-H4）：无汉字短私语的典型开头——"Here is…/Let me…/I'll…"。
 *  只用于「短」无汉字句组；长英文段落（外语教学/整段英文讲解）不因句干误伤。 */
const META_EN_STEMS =
  /^(here (is|are)|let me|let's|i'll|i will|i've|i (was|think|need|should)|sure[,!.]?|got it|fine[,!.]?|okay[,!.]?|ok[,!.]?|alright|certainly|of course|done\.?)/i;
/** 中文元话语特征词；"调用工具函数/先调用工具函数" 是教学表述，不判私语 */
const META_ZH_WORDS = /先调用(?!工具函数)|调用工具(?!函数)|用户会看到确认卡|等待用户|批准后/;
const CJK_CHAR = /[\u4e00-\u9fff]/;

/** 英文字母占比（分母为中文字符+英文字母）：>0.6 才视作"英文为主"的句子 */
function latinRatio(s: string): number {
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (s.match(CJK_CHAR) ?? []).length;
  return latin + cjk === 0 ? 0 : latin / (latin + cjk);
}

/** 剥掉书名号/引号引用后还剩中文实词吗（书名号与引号内的引用不算实词） */
function hasRealChinese(s: string): boolean {
  const stripped = s.replace(/《[^》]*》|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/g, "");
  return CJK_CHAR.test(stripped);
}

/** 无汉字文本是否为私语形态（V26.2-H4 统一判据，isMetaSentence/isPrivateMeta/英文回答路径共用）：
 *  独白引导词开头的短句（<220 字）或工具复述（to see/to view）。
 *  故意不含 META_EN_WORDS——report/tool/confirm 是英语教学里的普通词，按词表剔会误伤实质内容。 */
function isForeignPrivateTalk(s: string): boolean {
  if (!s.trim()) return true; // 纯空白组：nothing lost
  if (/to see |to view /i.test(s)) return true;
  return s.length < 220 && META_EN_STEMS.test(s.trim());
}

/** 单句/句组是否为私语/元话语。
 *  V26.2-H4 关键语义：该不该剔无汉字句取决于「整个回答的语言」——
 *  中文回答里的无汉字句组 = 泄漏（B12 语言一致性，整组剔）；
 *  整段英文回答 = 教学内容，走句子级 isForeignPrivateTalk 只剔私语形态。 */
function isMetaSentence(s: string, chineseAnswer: boolean): boolean {
  if (META_ZH_WORDS.test(s)) return true; // 中文元话语（先调用/确认卡/等待批准…）
  if (!CJK_CHAR.test(s)) return chineseAnswer;
  if (/to see |to view /i.test(s) && !hasRealChinese(s)) return true; // 工具复述（"…to see stage list."）
  // 英文私语：英文开头 + 特征词，且整句以英文为主（含实质中文的教学句不误伤）
  return /^[A-Za-z]/.test(s.trim()) && latinRatio(s) > 0.6 && META_EN_WORDS.test(s);
}

/** 把一段正文切成句子单元：text 为句子（含结尾标点），sep 为其后的空白/换行 */
function tokenizeSentences(seg: string): { text: string; sep: string }[] {
  const units: { text: string; sep: string }[] = [];
  const wsEnd = (i: number) => {
    let j = i;
    while (j < seg.length && /\s/.test(seg[j])) j++;
    return j;
  };
  let start = 0;
  for (let i = 0; i < seg.length; ) {
    const ch = seg[i];
    const zhEnd = ch === "。" || ch === "！" || ch === "？" || ch === "；" || ch === "?" || ch === "!";
    const enEnd = ch === "." && (i + 1 >= seg.length || /\s/.test(seg[i + 1]));
    if (zhEnd || enEnd) {
      const j = wsEnd(i + 1);
      units.push({ text: seg.slice(start, i + 1), sep: seg.slice(i + 1, j) });
      i = j;
      start = j;
      continue;
    }
    i++;
  }
  if (start < seg.length) units.push({ text: seg.slice(start), sep: "" });
  return units;
}

/** 过滤一段非代码正文。
 *  中文回答（chineseAnswer=true）：相邻无汉字单元并成组（"Fine."+"Give final answer briefly."），
 *  命中的组整组剔除（连同其后的空白）——B12 语言一致性。
 *  整段英文回答（chineseAnswer=false）：句子级过滤，只剔私语形态（isForeignPrivateTalk），
 *  英语教学的实质内容（例句/讲解/对话）保留。 */
function filterPlainSegment(seg: string, chineseAnswer: boolean): string {
  const units = tokenizeSentences(seg);
  if (!chineseAnswer) {
    return units.map(({ text, sep }) => (isForeignPrivateTalk(text) ? "" : text + sep)).join("");
  }
  const groups: { text: string; sep: string }[] = [];
  for (const u of units) {
    const prev = groups[groups.length - 1];
    if (prev && !CJK_CHAR.test(prev.text) && !CJK_CHAR.test(u.text) && !/\n/.test(prev.sep)) {
      prev.text += prev.sep + u.text;
      prev.sep = u.sep;
    } else {
      groups.push({ text: u.text, sep: u.sep });
    }
  }
  let out = "";
  for (const g of groups) {
    if (!isMetaSentence(g.text, chineseAnswer)) out += g.text + g.sep;
  }
  return out;
}

/** 句子级私语过滤：代码块整体原样保留，只过滤围栏外的正文。
 *  「整个回答的语言」由全部非代码段判定（有任一汉字 = 中文回答）。 */
export function stripMetaSentences(text: string): string {
  if (!text) return text;
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  const chineseAnswer = parts.some((p, i) => i % 2 === 0 && CJK_CHAR.test(p));
  return parts
    .map((part, i) => (i % 2 === 1 ? part : filterPlainSegment(part, chineseAnswer)))
    .join("");
}

/* 保留给老引用：parse/strip 仍可从 runner 导入（向后兼容） */
export { parseDirectives, stripDirectives } from "./parse";
