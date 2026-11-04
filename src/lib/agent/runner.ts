"use client";

/* 智能体工具循环执行器（M3）
 *
 * 对应 codex 的 run_turn：模型输出 → 解析工具调用 → 执行 → 结果回注 → 再问模型，
 * 直到模型不再调用工具或达到 MAX_TOOL_ROUNDS。
 *
 * 与 codex 的差异（学习场景的必要约束）：
 *  - 没有 shell/文件系统；工具是"检索笔记 / 读学习状态 / 存笔记 / 出题"
 *  - 写入类工具不立即执行，而是产出一个 PendingWrite 交给 UI 显示确认卡
 *  - 每轮都回调 UI（onPlan / onTool / onReasoning），保证过程可见
 */
import { streamChat } from "@/lib/ai/client";
import { parseDirectives, stripDirectives } from "./parse";
import { useAppStore } from "@/lib/store";
import { buildContext, wikiRetrieve } from "@/lib/rag";
import { todayISO, uid } from "@/lib/utils";
import {
  MAX_TOOL_ROUNDS,
  TOOLS,
  advancePlan,
  type PlanStep,
  type ToolCall,
  type ToolName,
  type ToolResult,
} from "./protocol";

export interface PendingWrite {
  id: string;
  title: string;
  body: string;
  domain: string;
}

export interface RunCallbacks {
  onPhase: (phase: "thinking" | "acting" | "answering" | "done" | "failed" | "cancelled") => void;
  onPlan: (plan: PlanStep[]) => void;
  onTool: (tool: ToolCall) => void;
  onReasoning: (summary: string) => void;
  onDelta: (text: string) => void;
  onPendingWrite: (w: PendingWrite | null) => void;
}

export { parseDirectives, stripDirectives } from "./parse";

/** 执行只读工具；写入工具返回 pending */
async function runTool(
  name: ToolName,
  args: Record<string, unknown>
): Promise<{ result: ToolResult; pending?: PendingWrite }> {
  const store = useAppStore.getState();

  if (name === "search_brain") {
    const query = String(args.query ?? "").trim();
    if (!query) return { result: { ok: false, content: "缺少 query 参数", summary: "参数缺失" } };
    const notes = store.knowledge.filter((k) => !(k.tags ?? []).includes("MOC"));
    if (notes.length === 0)
      return { result: { ok: true, content: "用户第二大脑里还没有笔记。", summary: "笔记库为空" } };
    const hits = wikiRetrieve(
      query,
      notes.map((k) => ({
        id: k.id, title: k.title, body: k.body, domain: k.domain,
        links: k.links, version: k.version, updatedAt: k.updatedAt, tags: k.tags,
      })),
      3
    );
    if (hits.length === 0)
      return { result: { ok: true, content: "没有找到相关笔记。", summary: "0 条" } };
    const content = buildContext(hits, query, 1600);
    return {
      result: {
        ok: true,
        content: `找到 ${hits.length} 篇相关笔记：\n${content}`,
        summary: `${hits.length} 篇：${hits.map((h) => h.doc.title).join("、").slice(0, 40)}`,
      },
    };
  }

  if (name === "read_context") {
    const goal = store.goals.find((g) => g.status === "active");
    const day = goal?.plan
      ? Object.values(goal.plan.days).find((d) => d.status === "active")
      : null;
    const today = todayISO();
    const due = store.knowledge.filter((k) => k.nextReviewAt && k.nextReviewAt <= today).length;
    const book = store.books.find((b) => b.status === "reading");
    const payload = {
      activeGoal: goal ? { topic: goal.topic, direction: goal.direction } : null,
      currentDay: day?.title ?? null,
      dueReviews: due,
      knowledgeCount: store.knowledge.length,
      readingBook: book ? { title: book.title, chapters: book.chapters.length } : null,
    };
    return {
      result: {
        ok: true,
        content: JSON.stringify(payload),
        summary: goal ? `${goal.topic}${day ? ` · ${day.title}` : ""}` : "无进行中目标",
      },
    };
  }

  if (name === "make_quiz") {
    // 出题由模型自己在回答里完成；这个工具只标记「本轮要出题」
    const topic = String(args.topic ?? "").trim() || "刚才讲的内容";
    return {
      result: { ok: true, content: `已记录：针对「${topic}」出题。`, summary: `出题：${topic}` },
    };
  }

  if (name === "save_note") {
    const title = String(args.title ?? "").trim();
    const body = String(args.body ?? "").trim();
    if (!title || !body)
      return { result: { ok: false, content: "缺少 title 或 body", summary: "参数缺失" } };
    const domain = String(args.domain ?? "笔记").trim() || "笔记";
    const dup = store.knowledge.find((k) => k.title.trim() === title);
    if (dup)
      return {
        result: { ok: false, content: `已存在同名笔记《${title}》。`, summary: "同名已存在" },
      };
    return {
      result: { ok: true, content: "已生成笔记草稿，等待用户确认后保存。", summary: "待确认" },
      pending: { id: uid("pw"), title, body, domain },
    };
  }

  return { result: { ok: false, content: "未知工具", summary: "未知工具" } };
}

/**
 * 运行一轮智能体对话（含工具循环）。
 * 返回最终回答文本；过程中通过 callbacks 汇报状态。
 */
export async function runAgent(opts: {
  question: string;
  /** 已包含 system 的业务上下文（学习状态、笔记证据等） */
  context: string;
  /** 附件图片（data URL），只在首轮发送 */
  imageUrl?: string | null;
  history: { role: "user" | "assistant"; content: string }[];
  deep: boolean;
  signal: AbortSignal;
  cb: RunCallbacks;
}): Promise<string> {
  const { question, imageUrl, history, deep, signal, cb } = opts;
  let context: string = opts.context;

  let plan: PlanStep[] = [];
  const toolsUsed: ToolCall[] = [];
  let lastAnswer = "";

  /* 显式维护对话：history 已包含本轮用户消息，首轮直接用它；
   * 之后每轮追加「模型这一轮说了什么 + 工具返回了什么」，避免重复与错位。 */
  const convo: { role: "user" | "assistant"; content: string }[] = [...history];
  let firstRound = true;
  const called = new Set<string>(); // 已调用过的工具，禁止同一轮内重复（防无限循环）
  /* 工具结果累积：每轮都作为 system 上下文注入（这是模型真正"看到"工具返回的唯一通道） */
  const toolLog: string[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) {
      cb.onPhase("cancelled");
      return lastAnswer;
    }
    cb.onPhase(round === 0 ? "thinking" : "acting");

    let turnMessages: Parameters<typeof streamChat>[0]["messages"];
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
    const full = await streamChat({
      task: "agent",
      args: {
        /* 每轮都带上下文：首轮是学习状态，之后追加工具结果（否则模型"看不见"检索到的笔记） */
        ctx: [context, ...toolLog].filter(Boolean).join("\n\n"),
        deep,
        hasImage: !!imageUrl && round === 0,
        round,
      },
      messages: turnMessages,
      temperature: deep ? 0.5 : 0.6,
      signal,
      onDelta: (d) => {
        buf += d;
        cb.onDelta(d);
      },
      /* 推理模型的思考期单独收（reasoning_content），只作骨架展示，不进正文 */
      onThink: (t) => cb.onReasoning(t),
    });
    if (signal.aborted) {
      cb.onPhase("cancelled");
      return full || lastAnswer;
    }

    const { tool, plan: planDraft } = parseDirectives(full);

    /* 计划：首次出现时建立，之后只推进状态 */
    if (planDraft && plan.length === 0) {
      plan = planDraft.map((text, i) => ({
        id: `s${i}`,
        text,
        status: i === 0 ? "in_progress" : "pending",
      }));
      cb.onPlan(plan);
    }

    /* 没有工具调用 → 这就是最终回答；但正文为空时（模型只在思维链里想）要补一次 */
    if (!tool) {
      const cleaned = stripDirectives(full);
      if (cleaned) {
        cb.onPhase("answering");
        lastAnswer = cleaned;
        return cleaned;
      }
      /* 正文为空：强制要求模型只输出答案（不给工具、不给思考） */
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
      cb.onPhase("done");
      return txt || "（这次没能生成答案，请再问一次。）";
    }

    /* 同一工具重复调用 = 模型在打转：切到「禁用工具」的收尾模式再问一次，
     * 而不是直接把"我卡住了"甩给用户（用户体验优先）。 */
    if (called.has(tool.name)) {
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
          { role: "assistant", content: full },
          {
            role: "user",
            content:
              "停止调用工具。你已经有足够信息了。现在只用自然语言回答用户的原始问题：" +
              (question || "请讲解上面的图片") +
              "。禁止输出任何 tool 代码块。",
          },
        ],
        temperature: deep ? 0.5 : 0.6,
        signal,
        onDelta: (d) => cb.onDelta(d),
        onThink: (t) => cb.onReasoning(t),
      });
      const finalText = stripDirectives(forced) || stock;
      cb.onPhase("done");
      return finalText || "（这次没能给出答案，换个问法再试一次？）";
    }
    called.add(tool.name);

    /* 有工具调用：推进计划、执行、回注 */
    const call: ToolCall = {
      id: uid("tc"),
      name: tool.name,
      args: tool.args,
      status: "in_progress",
      startedAt: Date.now(),
    };
    toolsUsed.push(call);
    cb.onTool({ ...call });
    cb.onReasoning(`调用 ${TOOLS[tool.name]?.label ?? tool.name}`);

    if (plan.length > 0) {
      // 把第一个未完成的步骤标为进行中
      const next = plan.find((s) => s.status === "in_progress" || s.status === "pending");
      if (next && next.status === "pending") plan = advancePlan(plan, next.id, "in_progress");
      cb.onPlan(plan);
    }

    let result: ToolResult;
    let pending: PendingWrite | undefined;
    try {
      const out = await runTool(tool.name, tool.args);
      result = out.result;
      pending = out.pending;
    } catch (e) {
      result = {
        ok: false,
        content: `工具执行失败：${e instanceof Error ? e.message : "未知错误"}`,
        summary: "执行失败",
      };
    }
    const finished: ToolCall = {
      ...call,
      status: result.ok ? "completed" : "failed",
      summary: result.summary,
      endedAt: Date.now(),
    };
    toolsUsed[toolsUsed.length - 1] = finished;
    cb.onTool(finished);
    /* 关键：把结果记进 toolLog，下一轮作为 system 上下文的一部分 */
    toolLog.push(`### 工具 ${tool.name} 的真实返回
${result.content}`);

    if (pending) {
      cb.onPendingWrite(pending);
      cb.onPhase("answering");
      // 写入类工具：不继续循环，把草稿交给用户确认
      return stripDirectives(full) || `我已整理好《${pending.title}》的草稿，确认后保存。`;
    }

    // 计划步骤推进
    if (plan.length > 0) {
      const cur = plan.find((s) => s.status === "in_progress");
      if (cur) {
        plan = advancePlan(plan, cur.id, "completed");
        const nxt = plan.find((s) => s.status === "pending");
        if (nxt) plan = advancePlan(plan, nxt.id, "in_progress");
        cb.onPlan(plan);
      }
    }

    // 回注工具结果，进入下一轮
    lastAnswer = stripDirectives(full);
    context = `工具 ${tool.name} 返回：\n${result.content}\n\n请基于这个结果继续回答用户的问题。如果不需要再调用工具，直接给出最终回答（不要再输出 tool 块）。`;

    if (round === MAX_TOOL_ROUNDS) {
      cb.onPhase("failed");
      return `${lastAnswer}\n\n（已达到单轮工具调用上限 ${MAX_TOOL_ROUNDS} 次，先停在这里。需要我继续可以再问一次。）`;
    }
  }

  cb.onPhase("done");
  return lastAnswer;
}
