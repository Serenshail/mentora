import { NextRequest } from "next/server";
import { PROVIDERS, type AIConfig } from "@/lib/ai/providers";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { verifySession, type SessionUser } from "@/lib/server/auth";
import { assertSafePublicUrl } from "@/lib/server/url-guard";
import { checkAndCountServerKey } from "@/lib/server/quota";
import * as P from "@/lib/ai/prompts";
import { logEvent } from "@/lib/server/config";
import {
  demoCouncil, demoIntake, demoLesson, demoPlan, demoQuizGrade,
  demoReadingChat, demoReadingPlan, demoReview, demoReviewGrade,
} from "@/lib/ai/demo";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  system?: string; // 仅服务端内部使用；客户端不再发送
  args?: Record<string, unknown>; // 纯数据参数,服务端据此组装系统提示词
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
  task?: string;
}

/* IP 保护：系统提示词只在服务端组装。前端仅发 task+args(纯数据),
 * 提示词模板(server-only)不进浏览器包、不上网络,别人只能看到输入→输出,看不到配方。 */
function buildSystem(task: string | undefined, args: Record<string, unknown> = {}): string {
  const s = (k: string) => String(args[k] ?? "");
  switch (task) {
    case "intake": return P.SOCRATIC_INTAKE(s("topic"), s("userName"));
    case "plan":
      return args.mode === "master" ? P.PLANNER_MASTER(s("cardJson")) : P.PLANNER_PHASE(s("ctx"));
    case "lesson": return P.DAILY_LESSON(s("ctx")) + P.TONE_LESSON_BLOCK(s("tone"));
    case "quiz-grade": return P.QUIZ_GRADE(s("ctx"), s("tone") === "gentle" ? "gentle" : "standard");
    case "review-ask": return P.REVIEW_PROMPT(s("items"));
    case "review-grade": return P.REVIEW_GRADE(s("ctx"));
    case "reading-plan": return P.READING_PLAN(s("desc"));
    case "reading-chat": {
      const rag = s("ragCtx")
        ? `\n\n## 你的主人的第二大脑里有这些相关笔记（聊天时自然引用，别硬塞）\n${s("ragCtx")}`
        : "";
      // 五模式引擎：显式 mode 走模式硬契约；未传 mode 保留旧的按知识类型自适应
      return s("mode") ? P.READING_MODE_CHAT(s("mode") as never, s("bookCtx")) + rag : P.READING_CHAT(s("bookCtx")) + rag;
    }
    case "verify-score": return P.VERIFY_SCORE(args as Parameters<typeof P.VERIFY_SCORE>[0]);
    case "insight": return P.INSIGHT_EXTRACT(s("text"));
    case "autolink": return P.AUTOLINK({ note: s("note"), candidates: s("candidates") });
    case "coach-qa": return P.ASK_COACH(s("ctx"));
    case "note-assist": return P.NOTE_ASSIST(s("mode"), s("text"));
    case "wiki-compile": return P.WIKI_COMPILE(s("target"), s("candidates"));
    case "resource-fix": return P.RESOURCE_FIX(s("bad"), s("ctx"));
    case "direction-guide": return P.DIRECTION_GUIDE(s("ctx"));
    case "life-post": return P.LIFE_POST(s("events"), Number(args.streak ?? 0));
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

function envKeys(): Record<string, string> {
  return {
    zai: process.env.ZAI_API_KEY || "",
    deepseek: process.env.DEEPSEEK_API_KEY || "",
    moonshot: process.env.MOONSHOT_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || "",
  };
}

/* ============================================================
 * 模型配置解析（v17 安全重构）
 *
 * 旧版的洞：客户端头可以拼出"服务端 Key + 攻击者 baseUrl"的组合
 * （provider=deepseek 不带 key → env Key 装上车，baseurl 头无白名单 →
 * Bearer <部署者 Key> 直接发给攻击者 URL）——公开提款机。
 *
 * 新版铁律：**Key 与 baseUrl 必须同源**，不存在任何混配路径：
 *  · BYOK：客户端给了自己的 Key。baseUrl 只来自①内置服务商表（服务端常量）
 *    或②custom 端点（必须过 url-guard：公网 https + DNS 解析取证）。
 *    外发的 Authorization 里只有用户自己的 Key，泄的是他自己。
 *  · 服务端模式：客户端没给 Key。provider/baseUrl/model **全部来自 env**，
 *    客户端头一概无视。未配置任何 Key → 演示脚本（不花钱，不登录也能玩）。
 * ============================================================ */

type ErrRes = { error: string; status: number };

function resolveByok(req: NextRequest, userKey: string): Promise<AIConfig | ErrRes> | AIConfig | ErrRes {
  const header = (n: string) => req.headers.get(n) || "";
  const provider = header("x-mentora-provider");
  const model = header("x-mentora-model");

  if (provider === "custom") {
    // custom 端点唯一允许客户端指定 baseUrl 的地方——必须过出网守卫（禁 https 之外/内网/元数据）
    const raw = header("x-mentora-baseurl");
    return (async () => {
      const guard = await assertSafePublicUrl(raw, { allowHttp: false });
      if (!guard.ok) return { error: `自定义端点不可用：${guard.reason}（需为公网 HTTPS 地址）`, status: 400 } satisfies ErrRes;
      if (!model) return { error: "自定义端点请同时填写模型名", status: 400 } satisfies ErrRes;
      return { provider: "custom", baseUrl: raw, apiKey: userKey, model } satisfies AIConfig;
    })();
  }

  if (provider && provider !== "demo" && provider in PROVIDERS) {
    const info = PROVIDERS[provider as keyof typeof PROVIDERS];
    return { provider: info.id, baseUrl: info.baseUrl, apiKey: userKey, model: model || info.defaultModel };
  }
  return { error: "已提供 API Key，但没有选择对应的服务商", status: 400 };
}

function serverConfig(): AIConfig {
  const keys = envKeys();
  const envProvider = process.env.AI_PROVIDER || "";
  let provider = "";
  let apiKey = "";
  let baseUrl = "";
  if (envProvider === "custom" && process.env.AI_BASE_URL) {
    provider = "custom";
    baseUrl = process.env.AI_BASE_URL;
    apiKey = process.env.CUSTOM_API_KEY || "";
  } else if (envProvider && keys[envProvider]) {
    provider = envProvider;
    apiKey = keys[envProvider];
  } else {
    for (const [p, k] of Object.entries(keys)) {
      if (k) { provider = p; apiKey = k; break; }
    }
  }
  if (!provider || !apiKey) return { provider: "demo", baseUrl: "", apiKey: "", model: "demo" };
  const info = PROVIDERS[provider as keyof typeof PROVIDERS] ?? PROVIDERS.demo;
  const model = process.env.AI_MODEL || info.defaultModel;
  if (!model) return { provider: "demo", baseUrl: "", apiKey: "", model: "demo" };
  return { provider: info.id, baseUrl: baseUrl || info.baseUrl, apiKey, model };
}

function demoTask(
  task: string | undefined,
  system: string,
  messages: Body["messages"]
): AsyncGenerator<string> {
  const s = system || "";
  switch (task) {
    case "intake": return demoIntake(messages);
    case "plan": return demoPlan(s);
    case "lesson": return demoLesson();
    case "quiz-grade": return demoQuizGrade(s);
    case "review-ask": return demoReview(s);
    case "review-grade": return demoReviewGrade();
    case "reading-plan": return demoReadingPlan(s);
    case "reading-chat": return demoReadingChat(messages);
    case "autolink":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).demoAutolink();
      })();
    case "persona-distill":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).demoPersona();
      })();
    case "coach-qa":
      return demoCouncil(messages);
    case "app-assistant":
      return (async function* () {
        yield* (await import("@/lib/ai/demo")).chunked(
          "**演示模式的助手只会照本宣科。**接上真模型后，我可以告诉你每个功能在哪、怎么用——比如 Obsidian 导入、三重验收、后台密码门。"
        );
      })();
    default: return demoCouncil(messages);
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
}

/** 带超时 + 指数退避重试的上游请求（仅在尚未产出任何增量前重试，保证幂等）。
 *  parentSignal：客户端断开时由流的 cancel() 触发，向上游传递中止，停止白烧 token。 */
async function fetchUpstream(
  cfg: AIConfig,
  body: Body,
  stats: UpstreamStats,
  parentSignal?: AbortSignal
): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  // OpenAI 官方与 DeepSeek 支持流式回带 usage；其余 provider 保守不发这个字段（防 400）
  const wantsUsage = cfg.provider === "deepseek" || cfg.provider === "openai";
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // 500ms → 1s
    }
  }
  logEvent({ route: "chat-upstream", status: "fail", lastErr, attempts: MAX_ATTEMPTS });
  throw new Error(`${lastErr || "上游模型不可用"}（已重试 ${MAX_ATTEMPTS} 次）`);
}

async function* upstreamDeltas(
  cfg: AIConfig,
  body: Body,
  stats: UpstreamStats,
  parentSignal?: AbortSignal
) {
  const res = await fetchUpstream(cfg, body, stats, parentSignal);
  const streamBody = res.body;
  if (!streamBody) return; // fetchUpstream 已保证 ok+body,此处仅为类型收窄

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
      if (payload === "[DONE]") return;
      try {
        const j = JSON.parse(payload);
        // usage 通常在最后一个不带 choices 的块里
        if (j.usage) {
          stats.promptTokens = j.usage.prompt_tokens ?? stats.promptTokens;
          stats.completionTokens = j.usage.completion_tokens ?? stats.completionTokens;
        }
        const delta = j.choices?.[0]?.delta;
        const piece: string = delta?.content || "";
        if (piece) yield { piece };
      } catch { /* 半包，忽略 */ }
    }
  }
}

export async function POST(req: NextRequest) {
  // 防滥用/防打崩：每 IP 突发 30 次、每分钟回填 30 次（跨 isolate 一致的持久桶）
  if (!(await rateLimitPersistent(`chat:${clientIp(req)}`, { capacity: 30, refillPerSec: 30 / 60 }))) {
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

  const byok = (req.headers.get("x-mentora-key") ?? "").trim();
  // 仅 Vercel 部署（production/preview）强制登录；本地开发（VERCEL_ENV 未设）放行，保 e2e 冒烟链路
  const enforceLogin = Boolean(process.env.VERCEL_ENV);
  // 没带 cookie 就不必查库吊销版本（省一次读）
  let session: SessionUser | null = null;
  if (req.headers.get("cookie")?.includes("mentora_session")) session = await verifySession();

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
      const q = await checkAndCountServerKey(session?.email || clientIp(req));
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
      try {
        if (cfg.provider === "demo") {
          for await (const piece of demoTask(body.task, body.system || "", body.messages)) {
            push({ t: "d", v: piece });
          }
        } else if (!cfg.apiKey || !cfg.model) {
          push({ t: "e", v: "未配置模型：请在 设置 页填写 API Key，或使用演示模式" });
        } else {
          for await (const piece of upstreamDeltas(cfg, body, stats, outer.signal)) {
            if ("error" in piece) push({ t: "e", v: piece.error });
            else push({ t: "d", v: piece.piece });
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError" && outer.signal.aborted)) {
          logEvent({ route: "chat", task: body.task, error: e instanceof Error ? e.message : "unknown" });
          try { push({ t: "e", v: e instanceof Error ? e.message : "未知错误" }); } catch { /* 流已取消 */ }
        }
      } finally {
        // token 计量落日志（成本可见性）：每次真实上游调用一条
        if (cfg.provider !== "demo") {
          logEvent({
            route: "chat-usage",
            task: body.task ?? "generic",
            provider: cfg.provider,
            account: session?.email ?? clientIp(req),
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
