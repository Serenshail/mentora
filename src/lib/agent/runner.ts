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
import { beginRequest, checkBudget, endRequest, type UsageSource } from "./request-ledger";
import {
  lookupRead,
  markRound,
  newProgressState,
  recordRead,
  stallVerdict,
} from "./progress-guard";
import { parseDirectives, stripDirectives } from "./parse";
import { executeTool, executeAction, normalizeHttpUrl, type Citation } from "./tool-executors";
import { TOOLS, type ToolName } from "./protocol";
import { uid } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { isProductActionRequest } from "@/lib/ai/prompts-lite";
import {
  MAX_TOOL_ROUNDS,
  callSignature,
  isWriteCall,
  stepPlanForward,
  type ApprovalDecision,
  type PendingAction,
  type PlanStep,
  type ToolCall,
  type ToolResult,
} from "./protocol";

export type { PendingAction } from "./protocol";
export type { Citation } from "./tool-executors";

/* read_url 的合法来源只能有两处（与 prompts.ts 的 read_url 纪律同口径）：用户原话里给出的
 * 链接、本轮 web_search 返回的结果链接。程序化白名单把这条纪律从「提示词软约束」变成硬闸门——
 * 被注入的网页可指示模型把用户笔记拼进 url query 打给攻击者服务器，只读工具自动执行时没人拦。
 * 只扫用户发的文本，绝不扫 ctx/工具结果（那正是要被外带的数据本身）。 */
function userTextUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`）)】\]。，、；：]+/gi)) {
    const norm = normalizeHttpUrl(m[0].replace(/[.,;:!?]+$/, ""));
    if (norm) out.push(norm);
  }
  return out;
}

export interface RunMeta {
  plan: PlanStep[];
  tools: ToolCall[];
  citations: Citation[];
}

export interface RunCallbacks {
  /** 运行归属（账本用）：发起时定格，绝不取「回调时的当前会话」 */
  identity?: { userId: string | null; sessionId: string; runId: string };
  onPhase: (phase: "thinking" | "acting" | "answering" | "done" | "failed" | "cancelled") => void;
  onPlan: (plan: PlanStep[]) => void;
  onTool: (tool: ToolCall) => void;
  onReasoning: (summary: string) => void;
  onDelta: (text: string) => void;
  onResetDelta?: () => void;
  /** 审批门：写入工具挂起等待用户决定；UI 展示确认卡并 resolve 结果 */
  requestApproval: (actions: PendingAction[]) => Promise<ApprovalDecision[]>;
}

/** 最终回答 + 过程产物（UI 持久化 meta 到消息上） */
export interface AgentRunResult {
  answer: string;
  meta: RunMeta;
}

/** 解析一轮模型输出里的工具调用：原生优先，围栏兜底。
 *  badToolBlocks 透传降级通道里「有 ```tool 块但解析不出来」的数量——
 *  调用方据此回注纠正，绝不把「工具没执行」当成最终回答静默收尾。 */
function collectCalls(
  text: string,
  native: WireToolCall[]
): {
  calls: { name: ToolName; args: Record<string, unknown>; nativeId?: string }[];
  badToolBlocks: number;
} {
  const out: { name: ToolName; args: Record<string, unknown>; nativeId?: string }[] = [];
  for (const c of native) {
    if (!Object.hasOwn(TOOLS, c.name)) continue;
    let args: Record<string, unknown> = {};
    try {
      args = (JSON.parse(c.argsRaw || "{}") as Record<string, unknown>) ?? {};
    } catch { /* 坏参数按空参执行，让工具报参数缺失 */ }
    out.push({ name: c.name as ToolName, args, nativeId: c.id });
  }
  if (out.length === 0) {
    const { tools, badToolBlocks } = parseDirectives(text);
    for (const t of tools ?? []) out.push({ name: t.name, args: t.args });
    return { calls: out, badToolBlocks: badToolBlocks ?? 0 };
  }
  return { calls: out, badToolBlocks: 0 };
}

/**
 * 运行一轮智能体对话（含工具循环与审批门）。
 * 返回最终回答与过程产物；过程中通过 callbacks 汇报状态。
 */
export async function runAgent(opts: {
  question: string;
  /** 已含业务上下文（学习状态、笔记证据等）；工具结果按通道回注 */
  context: string | (() => string);
  /** 附件图片（data URL），只在首轮发送 */
  imageUrl?: string | null;
  history: { role: "user" | "assistant"; content: string }[];
  deep: boolean;
  signal: AbortSignal;
  cb: RunCallbacks;
}): Promise<AgentRunResult> {
  const { question, imageUrl, history, deep, signal, cb } = opts;
  const liveContext = () => typeof opts.context === "function" ? opts.context() : opts.context;
  const actionRequest=isProductActionRequest(question);

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
  /* 打转守卫：上一轮的工具调用签名集合（只覆盖相邻轮） */
  let lastRoundSigs = new Set<string>();
  /* 进展守卫（RUN-01/§6.3）：覆盖非相邻重复、换参数空转、只读结果复用 */
  const progress = newProgressState();
  const readSources = () => { const s=useAppStore.getState();return [s.goals,s.knowledge,s.books,s.sessions]; };
  let lastReadSources=readSources();
  const refreshReadCache=()=>{
    const sources=readSources();
    if(sources.some((source,index)=>source!==lastReadSources[index])){
      progress.reads.clear();lastRoundSigs.clear();
    }
    lastReadSources=sources;
  };
  /* read_url 来源白名单：用户原话里的链接（本轮问题 + 历史里的用户消息），
   * web_search 结果在每轮工具执行后追加（见下方 cites 处理）。 */
  const allowedReadUrls = new Set<string>([...userTextUrls(question), ...history.filter((m) => m.role === "user").flatMap((m) => userTextUrls(m.content))]);
  /* 原生通道状态：网关拒收 tools 后切围栏，本轮 run 内不再声明 nativeTools */
  let nativeOff = false;
  /* 降级通道坏 tool 块的回注次数（防死循环；见下方 badToolBlocks 分支） */
  let badToolRetries = 0;
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
  /* 真实 provider 请求记账（COST-01 前置）：每轮一次真实请求，含失败与重试。
   * 硬计数不依赖 usage：usage 拿不到就标 unknown，绝不写 0。 */
  let ledgerRound = 0;
  const identity = cb.identity ?? { userId: null, sessionId: "unknown", runId: "unknown" };
  const chat = async (o: {
    args: Record<string, unknown>;
    messages: WireMsg[];
    onThink?: (t: string) => void;
    onToolCalls?: (calls: WireToolCall[]) => void;
    onNativeOff?: () => void;
  }, recovering = false): Promise<string | null> => {
    streamed = "";
    /* 预算闸门：达到上限就**不再发请求**，把原因作为错误抛给上层如实告知用户
     * （不能静默继续花，也不能假装成功）。 */
    const gate = checkBudget({ ...identity, task: "agent", layer: "provider" });
    if (!gate.ok) throw new Error(gate.reason);
    const rec = beginRequest({ ...identity, task: "agent", round: ledgerRound++, layer: "provider" });
    /* 显式类型：TS 会把「只在回调里赋值」的变量收窄成 never */
    let usage = null as null | { inputTokens: number; outputTokens: number; cachedTokens: number };
    try {
      const out = await streamChat({
        task: "agent",
        args: {...o.args,requestQuestion:question},
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
        onUsage: (u) => {
          usage = u;
        },
      });
      const src: UsageSource = usage ? "provider" : "unknown";
      endRequest(rec.id, {
        ok: true,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cachedTokens: usage?.cachedTokens,
        usageSource: src,
      });
      return out;
    } catch (e) {
      const aborted = signal.aborted || (e instanceof Error && e.name === "AbortError");
      endRequest(rec.id, { ok: false, error: aborted ? "cancelled" : e instanceof Error ? e.message : "unknown" });
      if (aborted) return null;
      if (!recovering && e instanceof Error && e.message.includes("模型回答达到长度上限")) {
        cb.onResetDelta?.();
        return chat({ ...o, args: { ...o.args, compactAnswer: true } }, true);
      }
      throw e;
    }
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    refreshReadCache();
    if (signal.aborted) {
      cb.onPhase("cancelled");
      return answer();
    }
    cb.onPhase(round === 0 ? "thinking" : "acting");
    /* 本轮是否拿到新信息（含「写动作已提交」这类进展） */
    let roundAdvanced = false;
    const roundNotes: string[] = [];

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
        ctx: [liveContext(), ...toolLog].filter(Boolean).join("\n\n"),
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

    const { calls, badToolBlocks } = collectCalls(full, native);

    /* 降级通道的坏 tool 块（JSON 损坏 / 工具名不存在）：模型想调工具但没调成。
     * 此时正文通常只是过渡语（「我来查一下」），**绝不能当最终回答收尾**——那会让
     * 模型以为已调用、用户以为已处理，实际什么都没发生且全链路无信号。
     * 回注一次纠正让它重发；连续两轮仍坏则如实告知用户工具未执行。 */
    if (calls.length === 0 && badToolBlocks > 0) {
      if (badToolRetries < 2 && round < MAX_TOOL_ROUNDS) {
        badToolRetries += 1;
        convo.push({ role: "assistant", content: full });
        convo.push({
          role: "user",
          content:
            "（系统提示）你刚才输出的 ```tool 块无法解析（JSON 语法错误、缺少 name，或工具名不存在），因此**没有任何工具被执行**。" +
            "请重新输出一个**完整且合法**的 ```tool 块（单行 JSON、字符串正确转义、name 必须是可用工具），或直接用自然语言回答。",
        });
        continue;
      }
      cb.onPhase("answering");
      lastAnswer =
        "⚠ 这次的工具调用没有执行：模型输出的工具块格式损坏（连续重试仍未通过），所以我没有声称任何操作已完成。请再说一次，我重新处理。";
      return answer();
    }

    /* 没有工具调用 → 这就是最终回答；正文为空时补一次（模型只在思维链里想） */
    if (calls.length === 0) {
      const cleaned = stripMetaSentences(trimMetaEdges(stripDirectives(full)));
      if (cleaned) {
        cb.onPhase("answering");
        lastAnswer = cleaned;
        return answer();
      }
      cb.onPhase("answering");
      cb.onResetDelta?.();
      const retry = await chat({
        args: {
          ctx: [liveContext(), ...toolLog].filter(Boolean).join("\n\n"),
          deep,
          hasImage: false,
          round: 99,
          noTools: true,
          compactAnswer: true,
        },
        messages: convo,
      });
      if (retry === null || signal.aborted) {
        cb.onPhase("cancelled");
        lastAnswer = stripMetaSentences(trimMetaEdges(stripDirectives(retry ?? streamed))) || lastAnswer;
        return answer();
      }
      const txt = stripMetaSentences(trimMetaEdges(stripDirectives(retry)));
      if (!txt) throw new Error("模型连续两次未返回正文");
      lastAnswer = txt;
      cb.onPhase("done");
      return answer();
    }

    /* 本轮解析出真实工具调用 → 坏块计数作废（连续判定只针对同一处格式问题） */
    badToolRetries = 0;

    /* 打转守卫：本轮**全部**调用都与上一轮重复 → 强制收尾。
     * 旧写法是 sigs.some(...)：批内只要有一个重复，其余全新调用就不执行、也不进 toolsUsed，
     * 最终回答基于缺信息生成（读取重复本已由 progress-guard 的复用兜住）。 */
    refreshReadCache();
    const sigs = calls.map((c) => callSignature(c.name, c.args));
    const repeats = sigs.map((s) => lastRoundSigs.has(s));
    const isStuck = sigs.length > 0 && repeats.every(Boolean);
    if (isStuck) {
      cb.onPhase("answering");
      const stock = stripDirectives(full);
      const forced = await chat({
        args: {
          ctx: [liveContext(), ...toolLog].filter(Boolean).join("\n\n"),
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
    const hasWriteCall = calls.some((c) => isWriteCall(c.name, c.args));
    /* 私语判定不再另起一套轮次级粗正则：cleanedThisRound 已过 stripMetaSentences——
     * 它带「调用工具函数/先调用工具函数」这类教学负向断言，并按整段语言决定是否剔无汉字句。
     * 旧写法（确认卡|调用工具|先调用|… 命中即把**整轮正文**排除）会让「讲解 Agent 工作原理时
     * 顺手调工具」这类合法讲解段在流式里看得到、落库的最终消息却整段缺失（PRD §5.2）。
     * 现在只保留两种确属私语的轮次：清洗后为空，或整轮无汉字且属私语形态。
     *
     * 长度门槛曾经是 >60：短于 60 字的合法讲解段（如「第一段是合法讲解：列表推导式
     * 把循环和表达式写在一行。」只有 26 字）会被整段丢掉——而这段用户在流式里已经
     * 看到了，最终消息却没有它，违反 PRD §5.2「最终消息必须与被接受的流式内容相符」。
     * 现在只靠既有过滤器把关：stripMetaSentences（元话语/私语）、trimMetaEdges（无汉字边线）、
     * hasWriteCall（写入轮的过渡语一律不入列）、与上一段重复去重。 */
    const isPrivateMeta =
      !cleanedThisRound || (!CJK_CHAR.test(cleanedThisRound) && isForeignPrivateTalk(cleanedThisRound));
    if (
      cleanedThisRound &&
      !actionRequest &&
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
        /* 中止标记：由 catch 精确设置，不靠事后匹配错误文案 */
        let abortedHere = false;
        try {
          /* 只读结果复用（PRD §6.3）：同签名同版本已经读过就直接用上一次的结果，
           * 不再打一遍工具、也不再让模型误以为「又拿到了新信息」。 */
          const cached = lookupRead(progress, c.name, c.args);
          if (cached.reuse) {
            const out = { result: { ok: true, content: cached.reuse.content, summary: "复用上次读取结果" }, citations: undefined as Citation[] | undefined };
            result = out.result;
            cites = out.citations;
            cb.onTool({
              ...started[i],
              status: "completed",
              summary: "复用上次读取结果",
              endedAt: Date.now(),
            });
          } else {
            const out = await executeTool(c.name, c.args, { allowedUrls: allowedReadUrls, signal, question });
            result = out.result;
            action = out.action;
            cites = out.citations;
            /* 记录本次读取是否带来新信息（写入工具/研究型工具的语义由 guard 内部处理） */
            const pr = recordRead(progress, round, c.name, c.args, result.content);
            roundAdvanced = roundAdvanced || pr.advanced;
            roundNotes.push(pr.note);
          }
        } catch (e) {
          /* 用户点「停止」导致的中止不是失败：别把 AbortError 的英文原文当「执行失败」
           * 拼进结果（用户主动取消却看到一条英文报错的失败芯片）。 */
          abortedHere = signal.aborted || (e instanceof Error && e.name === "AbortError");
          result = abortedHere
            ? { ok: false, content: "用户已停止本轮，这个工具没有跑完（未改动任何数据）。", summary: "已取消" }
            : {
                ok: false,
                content: `工具执行失败：${e instanceof Error ? e.message : "未知错误"}`,
                summary: "执行失败",
              };
        }
        if (cites) {
          citations.push(...cites);
          /* web_search / read_url 取回的链接并入 read_url 白名单：模型下一步读搜索结果里的页面是合法链路 */
          for (const ci of cites) {
            const norm = normalizeHttpUrl(ci.url);
            if (norm) allowedReadUrls.add(norm);
          }
        }
        /* 工具自己把中止收成 ok:false（如 read_url 的「已停止：读取被取消」）也按取消态标注，
         * 不让用户主动停止显示成一条失败步骤。abortedHere 已在 catch 里精确设置。 */
        if (!result.ok && !abortedHere && signal.aborted) {
          abortedHere = true;
          result = { ok: false, content: "用户已停止本轮，这个工具没有跑完（未改动任何数据）。", summary: "已取消" };
        }
        /* 写入工具的「草稿已生成」不是完成：审批等待 + 批准后执行期间芯片保持
         * in_progress（spinner），执行结束才落 completed/failed——
         * 此前这里就标 completed（绿勾「待确认」），审批卡还挂着时芯片已显示成功，
         * 长执行（如 add_book 整本计划生成）期间无任何进行中指示。 */
        const finished: ToolCall = {
          ...call,
          status: abortedHere
            ? "declined"
            : action
              ? result.ok
                ? "in_progress"
                : "failed"
              : result.ok
                ? "completed"
                : "failed",
          summary: abortedHere ? "已取消" : action && result.ok ? "等待确认" : result.summary,
          endedAt: abortedHere || !action ? Date.now() : undefined,
        };
        const idx = toolsUsed.findIndex((x) => x.id === call.id);
        if (idx >= 0) toolsUsed[idx] = finished;
        cb.onTool(finished);
        return { call: finished, result, action };
      })
    );

    /* 审批门：写入动作挂起等待用户决定；拒绝记 declined 并回注模型 */
    const actions = outcomes.map((o) => o.action).filter((a): a is PendingAction => Boolean(a));
    let decisions: ApprovalDecision[] = [];
    if (actions.length > 0) {
      cb.onPhase("answering");
      decisions = await cb.requestApproval(actions);
    }
    /* R1（独立复核 2026-11-12）：执行边界必须**默认拒绝**。
     * 旧写法 `if (!d || d.approved)` 把「没有决定」当成批准——审批门被任何原因
     * 清空（切会话、竞态、回调丢失）都会让未批准的写入真的落库。
     * 现在只有**明确 approved === true 且 actionId 精确匹配**才执行；
     * 缺失 / 未知 action / 重复 / 停止后到达的决定一律不写。
     * （PRD 允许「按原授权直接执行」的小改动不经过这里：它们在 validateWriteTool
     *   里就直接执行并返回结果，不产生 PendingAction。） */
    const decisionOf = (a: PendingAction) =>
      decisions.find((d) => d.actionId === a.id && d.approved === true);

    /* 已完成的全部工具结果（含批准执行/拒绝）统一回注 */
    const feedbacks = await Promise.all(
      outcomes.map(async (o) => {
        const action = o.action;
        if (!action) {
          return { call: o.call, result: o.result, toolCallId: o.call.id, native: true };
        }
        const approved = decisionOf(action) !== undefined;
        const idx = toolsUsed.findIndex((x) => x.id === o.call.id);
        /* 停止后到达的「批准」不得写入：signal 已中止就按取消处理 */
        if (approved && signal.aborted) {
          const abortedCall: ToolCall = { ...o.call, status: "declined", summary: "已停止，未执行", endedAt: Date.now() };
          if (idx >= 0) toolsUsed[idx] = abortedCall;
          cb.onTool(abortedCall);
          return {
            call: abortedCall,
            result: { ok: false, content: "用户已停止本轮，这次写入没有执行，也没有改动任何数据。", summary: "已停止未执行" } satisfies ToolResult,
            toolCallId: o.call.id,
            native: true,
          };
        }
        if (approved) {
          /* 与读工具路径（上方 try/catch）对称：批准后的执行失败（网络错误/解析失败）
           * 回注模型让其在回答里如实转述，而不是炸掉整轮已流出的回答；
           * AbortError（用户点停止）原样上抛，走 cancelled 终态。 */
          let result: ToolResult;
          try {
            result = await executeAction(action, signal);
          } catch (e) {
            if (signal.aborted || (e instanceof Error && e.name === "AbortError")) throw e;
            result = {
              ok: false,
              content: `执行失败：${e instanceof Error ? e.message : "未知错误"}——操作没有完成。请如实告诉用户这次执行失败了，不要声称已写入任何数据。`,
              summary: "执行失败",
            };
          }
          /* 用户取消不是失败：执行器把中止收成 ok:false（如 phase-regen 的「已取消重排」），
           * 芯片若仍标 failed 会让「用户主动停止」显示成一条失败步骤。 */
          const cancelledExec = !result.ok && signal.aborted;
          const finished: ToolCall = {
            ...o.call,
            status: cancelledExec ? "declined" : result.ok ? "completed" : "failed",
            summary: cancelledExec ? "已取消" : result.summary,
            endedAt: Date.now(),
          };
          if (idx >= 0) toolsUsed[idx] = finished;
          cb.onTool(finished);
          return { call: finished, result, toolCallId: o.call.id, native: true };
        }
        /* 未获明确批准（拒绝 / 无决定 / 未知 action）一律 declined，不写业务数据。
         * 回注文案区分「用户拒绝」与「没有拿到有效批准」，便于模型如实转述。 */
        const reason = decisions.some((x) => x.actionId === action.id) ? "用户拒绝了" : "未获批准（没有收到有效决定）";
        const declined: ToolCall = { ...o.call, status: "declined", summary: reason, endedAt: Date.now() };
        if (idx >= 0) toolsUsed[idx] = declined;
        cb.onTool(declined);
        return {
          call: declined,
          result: {
            ok: false,
            content:
              reason === "用户拒绝了"
                ? "用户拒绝了这次操作。不要重复发起同样的操作；如有必要换一种方式，或直接继续对话。"
                : "这次操作没有获得有效批准，因此没有执行、也没有改动任何数据。请如实告诉用户该操作未完成。",
            summary: reason === "用户拒绝了" ? "已拒绝" : "未获批准",
          } satisfies ToolResult,
          toolCallId: o.call.id,
          native: true,
        };
      })
    );

    /* 回注：
     * - 原生通道（或曾经原生）：assistant(tool_calls) + role:"tool" 消息（route 仅 agent 放行）
     * - 围栏通道：toolLog 累积 + 合成 user 消息 */
    const nativeCallsThisRound = native.filter((c) => Object.hasOwn(TOOLS, c.name));
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

    /* 进展守卫（RUN-01/§6.3）：本轮发生过成功的写入落地也算进展。
     * 两条来源都要算：
     *  - 审批门：用户明确批准（decisionOf 只认 approved===true 且 actionId 精确匹配）；
     *  - **直接执行**：A01 单阶段改名等「明确、可逆的小改动」在 validateWriteTool 里就落库，
     *    不产生 PendingAction（tool-executors.ts 的 isExplicitPhaseRename 分支）——
     *    此前只算审批路径，连续两轮小改名被记成空转，误触 stallVerdict 强制收尾。
     * 被拒绝的写入**不算**进展（它没有改变任何业务对象，模型应据拒绝反馈继续对话）。 */
    const wroteThisRound = outcomes.some(
      (o) =>
        (o.action && decisionOf(o.action) !== undefined) ||
        (!o.action && o.result.ok && isWriteCall(o.call.name, o.call.args))
    );
    markRound(
      progress,
      round,
      roundAdvanced || wroteThisRound,
      wroteThisRound ? "已提交/处理写入动作" : roundNotes.join("；") || "本轮无读取动作"
    );
    const stallMsg = stallVerdict(progress);
    if (stallMsg) {
      /* 连续两轮没有新证据：停止同一策略，让模型做一次聚焦澄清或如实说明阻塞。
       * 不是简单"调大上限"，也不是直接甩固定文案——基于已有工具结果作答。 */
      cb.onPhase("answering");
      const stock = stripDirectives(full);
      const forced = await chat({
        args: {
          ctx: [liveContext(), ...toolLog].filter(Boolean).join("\n\n"),
          deep,
          hasImage: false,
          round: 99,
          noTools: true,
        },
        messages: [
          ...convo,
          { role: "assistant", content: full || "（连续读取无新信息）" },
          { role: "user", content: `${stallMsg}\n\n用户的原始问题：${question || "请讲解上面的图片"}` },
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

    if (round === MAX_TOOL_ROUNDS) {
      /* 预算耗尽不再直接回固定文案：本轮工具结果已注入 convo/toolLog（上方回注段），
       * 与打转路径对称地补一轮 noTools 强制收尾——模型基于真实结果作答；
       * 此前固定文案承诺的「继续」拿不回这些结果（convo 只存在于本次 run 内存）。 */
      cb.onPhase("answering");
      const stock = stripDirectives(full);
      const forced = await chat({
        args: {
          ctx: [liveContext(), ...toolLog].filter(Boolean).join("\n\n"),
          deep,
          hasImage: false,
          round: 99,
          noTools: true,
        },
        messages: [
          ...convo,
          { role: "assistant", content: full || "（工具调用轮数已达上限）" },
          {
            role: "user",
            content:
              "工具调用轮数已达上限，不能再调用工具。基于上面已经拿到的全部工具结果，直接给出对用户原始问题的最终回答：" +
              (question || "请讲解上面的图片") +
              "。信息确实不够的部分如实说明，不要编造。",
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
      lastAnswer =
        stripMetaSentences(trimMetaEdges(stripDirectives(forced))) ||
        stripMetaSentences(trimMetaEdges(stock)) ||
        "（工具调用轮数已达上限，且这轮没能生成回答——请再发一句消息，我会基于已获取的信息继续。）";
      cb.onPhase("done");
      return answer();
    }
  }

  /* 不可达：循环体每一轮的终态路径都已 return（取消/无工具调用/打转/停滞/轮数耗尽），
   * round === MAX_TOOL_ROUNDS 分支必然收尾。保留一句显式兜底而不是留一条「看起来
   * 能自然跑完」的路径，避免维护者误以为存在正常的循环退出。 */
  throw new Error("智能体工具循环意外退出：没有命中任何终态分支");
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

/** 无汉字文本是否为私语形态（V26.2-H4 统一判据，isMetaSentence 与英文回答路径共用）：
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
