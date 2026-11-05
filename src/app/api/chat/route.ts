import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import type { AIConfig } from "@/lib/ai/providers";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { withBudget } from "@/lib/server/db";
import { verifySession, type SessionUser } from "@/lib/server/auth";
import { checkAndCountServerKey } from "@/lib/server/quota";
import { resolveByok, serverConfig } from "@/lib/server/ai-config";
import { isDeployed } from "@/lib/server/deploy-env";
import * as P from "@/lib/ai/prompts";
import { agentToolsPrompt, agentToolsSchema } from "@/lib/server/agent-tools";
import { agentPersonalContext } from "@/lib/server/personal";
import { ToolCallAggregator } from "@/lib/agent/parse";
import { logEvent } from "@/lib/server/config";
import {
  demoCouncil, demoGraduation, demoInsight, demoIntake, demoLesson, demoPlan, demoQuizGrade,
  demoReadingChat, demoReadingPlan, demoReview, demoReviewGrade,
  demoRoundtableHost, demoRoundtableTake,
} from "@/lib/ai/demo";

export const runtime = "nodejs";
export const maxDuration = 60;

type Part =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface Body {
  system?: string; // 仅服务端内部使用；客户端不再发送
  args?: Record<string, unknown>; // 纯数据参数,服务端据此组装系统提示词
  /* content 允许字符串（历史行为）或 OpenAI 兼容的多模态数组（图片，M2.1）。
   * v2 agent：assistant 可带 tool_calls、新增 role:"tool"（原生工具结果回注），
   * 仅 task=agent 放行（见下方 sanitize）。 */
  messages: Array<
    | { role: "user" | "assistant"; content: string | Part[]; tool_calls?: unknown[] }
    | { role: "tool"; tool_call_id?: string; content: string }
  >;
  temperature?: number;
  task?: string;
}

/** 仅 agent 任务允许 tool 角色与 tool_calls；其余任务剥掉（防外来格式污染其他链路） */
function sanitizeMessages(body: Body): void {
  if (body.task === "agent") return;
  body.messages = body.messages
    .filter((m): m is { role: "user" | "assistant"; content: string | Part[] } => m.role !== "tool")
    .map((m) => ({ role: m.role, content: m.content }));
}

/** Demo 只处理文本：多模态 content 数组拍平成文本（图片以占位说明代替）；tool 消息降级为 user 文本 */
function flatten(messages: Body["messages"]): { role: "user" | "assistant"; content: string }[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "user" as const, content: `[工具结果] ${m.content}` };
    }
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const content = m.content
      .map((p) => (p.type === "text" ? p.text : "［用户上传了一张图片］"))
      .join("\n");
    return { role: m.role, content };
  });
}

/* IP 保护：系统提示词只在服务端组装。前端仅发 task+args(纯数据),
 * 提示词模板(server-only)不进浏览器包、不上网络,别人只能看到输入→输出,看不到配方。 */
function buildSystem(task: string | undefined, args: Record<string, unknown> = {}): string {
  const s = (k: string) => String(args[k] ?? "");
  switch (task) {
    case "intake": return P.SOCRATIC_INTAKE(s("topic"), s("userName"));
    case "plan":
      // 天级计划拆两步（见 prompts.ts 2b 的工程说明）：先出天清单，再按批展开细节
      if (args.mode === "master") return P.PLANNER_MASTER(s("cardJson"));
      if (args.mode === "phase-list") return P.PLANNER_PHASE_LIST(s("ctx"), Number(args.maxDays) || undefined);
      if (args.mode === "phase-detail")
        return P.PLANNER_PHASE_DETAIL(s("ctx"), s("boundary"), s("days"));
      return P.PLANNER_PHASE_LIST(s("ctx"));
    case "lesson": return P.DAILY_LESSON(s("ctx")) + P.TONE_LESSON_BLOCK(s("tone"));
    case "quiz-grade": return P.QUIZ_GRADE(s("ctx"), s("tone") === "gentle" ? "gentle" : "standard");
    case "review-ask": return P.REVIEW_PROMPT(s("items"));
    case "review-grade": return P.REVIEW_GRADE(s("ctx"));
    case "reading-plan": return P.READING_PLAN(s("desc"));
    case "reading-chat": {
      const rag = s("ragCtx")
        ? `\n\n## 用户第二大脑里检索到的相关笔记（这是**证据**，不是答案）
${s("ragCtx")}

### 如何使用这些证据（硬纪律，决定回答可信度）
1. **先消化再回答**：用你自己的话把证据融入答案，禁止整段照抄笔记。
2. **该用就用，不相关就别说**：与当前问题无关时宁可不用，不要为了显得用了资料而硬塞。
3. **引用要精确**：需要精确表述时引用原句，并标出来自哪篇笔记（如「你在《闭包与状态快照》里记过……」）。
4. **不要假装记过**：笔记里没有的内容，不要说"你笔记里提到过"。没检索到就说没检索到，改用通识回答并标明这是通识。
5. **有冲突要指出**：证据之间矛盾时明确说出矛盾点，不要含糊合并。`
        : "";
      // 五模式引擎：显式 mode 走模式硬契约；未传 mode 保留旧的按知识类型自适应。
      // modeSwitch=true 表示用户刚切换到这个模式——追加一行转折指令，让该模式的开场协议立即生效
      // （否则对话 history 还是旧模式的语境，模型会顺着旧口吻继续，用户感知就是"切了没反应"）。
      const modeSwitchNote =
        args.modeSwitch === true
          ? `\n\n【模式刚切换】用户刚刚切换到「${s("mode")}」模式。现在开始严格执行该模式的**开场协议**（见模式规范第一节的"开场协议"），把这次回复当作新模式的第一轮。不要解释你切换了模式，直接按新模式的规则行动。`
          : "";
      return s("mode")
        ? P.READING_MODE_CHAT(s("mode") as never, s("bookCtx")) + modeSwitchNote + rag
        : P.READING_CHAT(s("bookCtx")) + rag;
    }
    case "verify-score": return P.VERIFY_SCORE(args as Parameters<typeof P.VERIFY_SCORE>[0]);
    case "insight": return P.INSIGHT_EXTRACT(s("text"));
    case "autolink": return P.AUTOLINK({ note: s("note"), candidates: s("candidates") });
    case "coach-qa": return P.ASK_COACH(s("ctx"), s("ragCtx"));
    /* 通用智能体（M3.6）：无学科模板，四条链自行判断 */
    case "agent":
      return P.AGENT_CHAT(s("ctx"), s("ragCtx"), {
        deep: args.deep === true,
        hasImage: args.hasImage === true,
        tools: args.noTools === true ? "" : agentToolsPrompt(),
        personal: s("personal"),
      });
    case "note-assist": return P.NOTE_ASSIST(s("mode"), s("text"));
    case "wiki-compile": return P.WIKI_COMPILE(s("target"), s("candidates"));
    /* RAG 增强（2026-10-26）：查询改写与精排都只输出 JSON，检索质量由代码裁决 */
    case "query-rewrite": return P.QUERY_REWRITE(s("question"), s("context"));
    case "rag-rerank": return P.RAG_RERANK(s("query"), s("candidates"));
    case "resource-fix": return P.RESOURCE_FIX(s("bad"), s("ctx"));
    case "direction-guide": return P.DIRECTION_GUIDE(s("ctx"));
    case "life-post": return P.LIFE_POST(s("events"), Number(args.streak ?? 0));
    case "graduation": return P.GRADUATION(s("ctx"));
    case "app-assistant": return P.APP_ASSISTANT(s("ctx"));
    case "persona-distill": return P.PERSONA_DISTILL(s("name"), s("hint"));
    case "council": {
      const mode = s("mode");
      if (mode === "take") {
        const base =
          s("customSystem") || (s("personaId") ? (P.personaById(s("personaId"))?.system ?? "") : "");
        return base + "\n\n" + P.ROUNDTABLE_TAKE(s("name"));
      }
      if (mode === "host") {
        return P.ROUNDTABLE_HOST(s("names")) + "\n\n## 各位与会者的发言全文\n" + s("takes");
      }
      if (mode === "single" || mode === "single-base") {
        // 自建人物：服务端补 COUNCIL_BASE 前缀；内置人物：按 id 取 system（不再由客户端携带）
        if (s("customSystem")) return P.COUNCIL_BASE + s("customSystem");
        return s("personaId") ? (P.personaById(s("personaId"))?.system ?? "") : s("system");
      }
      return s("system");
    }
    default: return s("system");
  }
}

/* 模型配置解析（envKeys/resolveByok/serverConfig）已抽至 @/lib/server/ai-config 以便单测 */

function demoTask(
  task: string | undefined,
  system: string,
  messages: Body["messages"],
  args: Record<string, unknown> = {}
): AsyncGenerator<string> {
  const s = system || "";
  const flat = flatten(messages);
  switch (task) {
    case "intake": return demoIntake(flat);
    case "plan": return demoPlan(s);
    case "lesson": return demoLesson();
    case "quiz-grade": return demoQuizGrade(s);
    case "review-ask": return demoReview(s);
    case "review-grade": return demoReviewGrade(s);
    /* 读书洞见与结业总结都有 schema 硬校验：落进 default 的 demoCouncil 会直接 parse 失败，
     * 演示模式反而走不完闭环。二者各自输出契约形状（洞见宁缺毋滥，允许空数组）。 */
    case "insight": return demoInsight(s);
    case "graduation": return demoGraduation(s);
    case "reading-plan": return demoReadingPlan(s);
    case "reading-chat": return demoReadingChat(flat);
    case "autolink":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).demoAutolink();
      })();
    case "persona-distill":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).demoPersona();
      })();
    /* RAG 增强的 Demo 必须同形状：改写返回 queries、精排返回 picked，否则上层解析失败 */
    case "query-rewrite":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).demoQueryRewrite(String(args.question ?? ""));
      })();
    case "rag-rerank":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).demoRagRerank(String(args.candidates ?? ""));
      })();
    case "coach-qa":
      return demoCouncil(flat);
    case "agent":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).demoAgent(flat);
      })();
    case "council": {
      /* 圆桌 Demo 与真实模型同语义（R1）：take 按席位差异化发言、host 真综合，
       * 不再静默落进 demoCouncil 的单人回答 */
      const mode = String(args.mode ?? "");
      if (mode === "take")
        return demoRoundtableTake(String(args.name ?? "与会者"), flat, String(args.personaId ?? ""));
      if (mode === "host")
        return demoRoundtableHost(
          String(args.names ?? ""),
          String(args.takes ?? ""),
          String(args.question ?? "")
        );
      return demoCouncil(flat);
    }
    case "app-assistant":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).chunked(
          "**演示模式的助手只会照本宣科。**接上真模型后，我可以告诉你每个功能在哪、怎么用——比如 Obsidian 导入、三重验收、后台密码门。"
        );
      })();
    default: return demoCouncil(flat);
  }
}

function ndjson(res: ReadableStreamDefaultController, chunk: string) {
  res.enqueue(new TextEncoder().encode(chunk + "\n"));
}

/* 可重试的瞬时故障：限流/服务端错误/超时；4xx(除408/409/429)为确定性错误不重试 */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const UPSTREAM_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 3;

class FatalUpstream extends Error { fatal = true; }

interface UpstreamStats {
  promptTokens?: number;
  completionTokens?: number;
  /** 网关不支持原生 tools（400）→ 已降级为围栏协议；通知客户端后续轮不再带 tools */
  nativeToolsRejected?: boolean;
}

/** 带超时 + 指数退避重试的上游请求（仅在尚未产出任何增量前重试，保证幂等）。
 *  parentSignal：客户端断开时由流的 cancel() 触发，向上游传递中止，停止白烧 token。
 *  tools：原生 tool_calls 契约（仅 agent 任务）；网关 400 拒收时立即降级为无 tools 重试（不消耗重试预算）。 */
async function fetchUpstream(
  cfg: AIConfig,
  body: Body,
  stats: UpstreamStats,
  parentSignal?: AbortSignal,
  tools?: ReturnType<typeof agentToolsSchema>
): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  // OpenAI 官方、DeepSeek、华为云 MaaS（OpenAI 兼容）支持流式回带 usage；其余 provider 保守不发（防 400）
  const wantsUsage = cfg.provider === "deepseek" || cfg.provider === "openai" || cfg.provider === "maas";
  let useTools = Array.isArray(tools) && tools.length > 0;
  let lastErr = "";
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    const onParentAbort = () => ctrl.abort();
    parentSignal?.addEventListener("abort", onParentAbort);
    try {
      if (parentSignal?.aborted) throw new DOMException("Aborted", "AbortError");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            ...(body.system ? [{ role: "system", content: body.system }] : []),
            ...body.messages,
          ],
          stream: true,
          temperature: body.temperature ?? 0.7,
          ...(wantsUsage ? { stream_options: { include_usage: true } } : {}),
          ...(useTools ? { tools, tool_choice: "auto" } : {}),
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok && res.body) {
        logEvent({ route: "chat-upstream", status: res.status, attempt });
        return res;
      }
      const text = await res.text().catch(() => "");
      lastErr = `上游模型返回 ${res.status}：${text.slice(0, 300)}`;
      /* 网关不认识 tools 参数 → 立即降级（围栏协议已在 system 里，模型仍能调工具）。
       * 不消耗重试预算：这是一次确定性能力探测，不是故障。 */
      if (res.status === 400 && useTools) {
        useTools = false;
        stats.nativeToolsRejected = true;
        continue;
      }
      if (!RETRYABLE.has(res.status)) throw new FatalUpstream(lastErr);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof FatalUpstream) throw e;
      if (e instanceof DOMException && e.name === "AbortError" && parentSignal?.aborted) throw e; // 客户端断开：不重试
      lastErr =
        e instanceof Error && e.name === "AbortError"
          ? `上游模型响应超时（>${UPSTREAM_TIMEOUT_MS / 1000}s）`
          : e instanceof Error ? e.message : "网络错误";
    } finally {
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
    attempt++;
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1))); // 500ms → 1s
    }
  }
  logEvent({ route: "chat-upstream", status: "fail", lastErr, attempts: MAX_ATTEMPTS });
  throw new Error(`${lastErr || "上游模型不可用"}（已重试 ${MAX_ATTEMPTS} 次）`);
}

async function* upstreamDeltas(
  cfg: AIConfig,
  body: Body,
  stats: UpstreamStats,
  parentSignal?: AbortSignal,
  tools?: ReturnType<typeof agentToolsSchema>
) {
  const res = await fetchUpstream(cfg, body, stats, parentSignal, tools);
  const streamBody = res.body;
  if (!streamBody) return; // fetchUpstream 已保证 ok+body,此处仅为类型收窄

  const agg = new ToolCallAggregator();
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") {
        if (!agg.isEmpty) yield { nativeToolCalls: agg.finish() };
        return;
      }
      try {
        const j = JSON.parse(payload);
        // usage 通常在最后一个不带 choices 的块里
        if (j.usage) {
          stats.promptTokens = j.usage.prompt_tokens ?? stats.promptTokens;
          stats.completionTokens = j.usage.completion_tokens ?? stats.completionTokens;
        }
        const delta = j.choices?.[0]?.delta;
        // 推理模型的思考期（reasoning_content）：转发为心跳事件，让客户端知道连接活着、模型在干活。
        // 不转发的话，思考期可达 60s+ 只靠合成 ping 保活，弱网/公网隧道仍可能掐断（手机实测 network error）。
        const think: string = delta?.reasoning_content || "";
        if (think) yield { think: think.slice(0, 200) };
        const piece: string = delta?.content || "";
        if (piece) yield { piece };
        /* 原生 tool_calls 分片：逐个喂进聚合器，流结束时一次性输出完整调用 */
        if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
          agg.feed(delta.tool_calls);
        }
      } catch { /* 半包，忽略 */ }
    }
  }
  if (!agg.isEmpty) yield { nativeToolCalls: agg.finish() };
}

export async function POST(req: NextRequest) {
  // 防滥用/防打崩：每 IP 突发 30 次、每分钟回填 30 次（跨 isolate 一致的持久桶）。
  // 与会话校验并行，且都设硬预算：远端 KV 变慢时降级放行，绝不让首字节等上十几秒
  // （公网网关 15s 无数据即 503——旧实现串行查三次 KV，实测首字节 20~54s 必挂）。
  const hasCookie = Boolean(req.headers.get("cookie")?.includes("mentora_session"));
  const [rlOk, session] = await Promise.all([
    withBudget(
      rateLimitPersistent(`chat:${clientIp(req)}`, { capacity: 30, refillPerSec: 30 / 60 }),
      true,
      1500
    ),
    hasCookie ? verifySession() : Promise.resolve(null as SessionUser | null),
  ]);
  if (!rlOk) {
    return Response.json({ error: "请求太频繁，请稍后再试" }, { status: 429 });
  }
  // 请求体上限，防超大 payload 打爆内存
  const raw = await req.text().catch(() => "");
  if (raw.length > 1_000_000) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
  let body: Body;
  try {
    body = (JSON.parse(raw || "{}") as Body) ?? { messages: [] };
  } catch {
    body = { messages: [] };
  }
  // 归一化：messages 必须是数组（上游拼装用展开运算符，undefined 会直接抛
  // "t.messages is not iterable"，还会被当成可重试错误白烧三次上游调用）
  if (!Array.isArray(body.messages)) body.messages = [];
  sanitizeMessages(body);

  const byok = (req.headers.get("x-mentora-key") ?? "").trim();
  // 仅部署环境（production/preview）强制登录；本地开发（DEPLOY_ENV/VERCEL_ENV 未设）放行，保 e2e 冒烟链路
  const enforceLogin = isDeployed();

  let cfg: AIConfig;
  if (byok) {
    if (enforceLogin && !session) {
      return Response.json({ error: "请先登录后再使用自己的 API Key" }, { status: 401 });
    }
    const r = await resolveByok(req, byok);
    if ("error" in r) return Response.json({ error: r.error }, { status: r.status });
    cfg = r;
  } else {
    cfg = serverConfig();
    // 服务端 Key 是部署者的钱：真实模型调用必须有登录态（演示脚本不限，注册后自动升级）
    if (enforceLogin && !session && cfg.provider !== "demo") {
      return Response.json(
        { error: "注册或登录后即可使用 AI 功能（免费）。演示模式无需账号。" },
        { status: 401 }
      );
    }
    // 服务端 Key 配额（商业化前置）：烧部署者的钱按用户(未登录按 IP)限每日次数;BYOK 不受此限。
    // 超限文案给解法(等明天/自带 Key),不报"系统错误"。
    if (cfg.provider !== "demo" && cfg.apiKey) {
      const q = await withBudget(
        checkAndCountServerKey(session?.email || clientIp(req)),
        { ok: true, used: 0, limit: Math.max(1, Number(process.env.AI_DAILY_CALL_LIMIT || 60)) },
        1500
      );
      if (!q.ok) {
        return Response.json(
          {
            error: `今日 AI 调用已达上限（${q.limit} 次/天）。明天恢复，或在 设置→模型 填入你自己的 Key（BYOK）不限次。`,
          },
          { status: 429 }
        );
      }
    }
  }

  /* 任务分级路由：验收/复习/三重验收判分是全产品频次最高的 AI 调用，
   * 走快模型省成本、降延迟。仅服务端 Key 生效——BYOK 用户自己选的模型不动；
   * 未配 AI_CHEAP_MODEL 时保持原模型，行为不变。 */
  const CHEAP_TASKS = new Set(["quiz-grade", "review-grade", "verify-score"]);
  if (!byok && cfg.provider !== "demo" && body.task && CHEAP_TASKS.has(body.task)) {
    const cheap = (process.env.AI_CHEAP_MODEL || "").trim();
    if (cheap) cfg = { ...cfg, model: cheap };
  }

  /* 个人上下文（v24.0 二期）：长期记忆摘要，仅 agent 任务、登录态；
   * 带 1.5s 硬预算——KV 变慢宁可不注入，也不能让首字节等超时。 */
  if (body.task === "agent" && session) {
    const personal = await withBudget(agentPersonalContext(session.userId), "", 1500);
    body.args = { ...(body.args ?? {}), personal };
  }

  // 双契约：客户端发 args(新,核心任务)→服务端组装提示词；发 system(旧,council)→沿用。
  const system =
    body.args && Object.keys(body.args).length > 0
      ? buildSystem(body.task, body.args)
      : (body.system ?? "");
  body.system = system;

  const stats: UpstreamStats = {};
  const outer = new AbortController();

  const stream = new ReadableStream({
    async start(controller) {
      const push = (obj: object) => ndjson(controller, JSON.stringify(obj));
      /* 心跳：公网网关对"长时间无字节"的连接会直接 503（实测 UUMit 约 15s）。
       * 上游首字节慢、或长任务中途卡顿时用 ping 占位保活；客户端只认 t=d/e，其余忽略。 */
      let closed = false;
      const hb = setInterval(() => {
        if (closed) return;
        try { push({ t: "p" }); } catch { closed = true; }
      }, 5000);
      try { push({ t: "p" }); } catch { closed = true; } // 首字节立刻落地，网关不再等首包
      try {
        if (cfg.provider === "demo") {
          for await (const piece of demoTask(body.task, body.system || "", body.messages, body.args ?? {})) {
            push({ t: "d", v: piece });
          }
        } else if (!cfg.apiKey || !cfg.model) {
          push({ t: "e", v: "未配置模型：请在 设置 页填写 API Key，或使用演示模式" });
        } else {
          /* 原生工具契约：仅 agent 任务且客户端声明 nativeTools 时携带；
           * 网关拒收（400）会自动降级为围栏协议并回告客户端。 */
          const tools =
            body.task === "agent" && body.args?.nativeTools === true && body.args?.noTools !== true
              ? agentToolsSchema()
              : undefined;
          for await (const piece of upstreamDeltas(cfg, body, stats, outer.signal, tools)) {
            if ("error" in piece) push({ t: "e", v: piece.error });
            else if ("think" in piece) push({ t: "h", v: piece.think });
            else if ("nativeToolCalls" in piece) push({ t: "tc", v: piece.nativeToolCalls });
            else push({ t: "d", v: piece.piece });
          }
          if (stats.nativeToolsRejected) push({ t: "n", v: "tools_off" });
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError" && outer.signal.aborted)) {
          logEvent({ route: "chat", task: body.task, error: e instanceof Error ? e.message : "unknown" });
          try { push({ t: "e", v: e instanceof Error ? e.message : "未知错误" }); } catch { /* 流已取消 */ }
        }
      } finally {
        closed = true;
        clearInterval(hb);
        // token 计量落日志（成本可见性）：每次真实上游调用一条
        if (cfg.provider !== "demo") {
          logEvent({
            route: "chat-usage",
            task: body.task ?? "generic",
            provider: cfg.provider,
            model: cfg.model,
            // 日志脱敏：邮箱不进日志，只留可聚合的前 8 位哈希指纹（account 字段无按账号消费方）
            account: session
              ? createHash("sha256").update(session.email).digest("hex").slice(0, 8)
              : clientIp(req),
            byok: byok ? 1 : 0,
            prompt_tokens: stats.promptTokens ?? 0,
            completion_tokens: stats.completionTokens ?? 0,
          });
        }
        try {
          push({ t: "end" });
          controller.close();
        } catch { /* cancel 后控制器已关闭 */ }
      }
    },
    cancel() {
      // 客户端断开 → 中止上游，停止白烧 token（旧实现缺这条：断连后上游继续跑完）
      outer.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
