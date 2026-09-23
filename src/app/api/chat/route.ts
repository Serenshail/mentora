import { NextRequest } from "next/server";
import { PROVIDERS, type AIConfig } from "@/lib/ai/providers";
import {
  demoCouncil, demoIntake, demoLesson, demoPlan, demoQuizGrade,
  demoReadingChat, demoReadingPlan, demoReview, demoReviewGrade,
} from "@/lib/ai/demo";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
  task?: string;
}

function resolveConfig(req: NextRequest): AIConfig {
  const header = (n: string) => req.headers.get(n) || "";
  let provider = header("x-mentora-provider") as string;
  let apiKey = header("x-mentora-key");
  let baseUrl = header("x-mentora-baseurl");
  let model = header("x-mentora-model");

  const envKeys: Record<string, string> = {
    zai: process.env.ZAI_API_KEY || "",
    deepseek: process.env.DEEPSEEK_API_KEY || "",
    moonshot: process.env.MOONSHOT_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || "",
  };

  // 用户选了具体 provider 但没填 Key → 服务端同名 Key 兜底
  if (provider && !["demo", "custom"].includes(provider) && !apiKey && envKeys[provider]) {
    apiKey = envKeys[provider];
  }
  if (provider === "custom" && !apiKey) {
    apiKey = process.env.CUSTOM_API_KEY || "";
  }

  // 未选择（或选"自动"）→ 跟随服务端配置；服务端无任何 Key → 演示模式
  if (!provider || provider === "demo") {
    const envProvider = process.env.AI_PROVIDER || "";
    if (envProvider === "custom" && process.env.AI_BASE_URL) {
      provider = "custom";
      baseUrl = baseUrl || process.env.AI_BASE_URL;
      apiKey = process.env.CUSTOM_API_KEY || "";
    } else if (envProvider && envKeys[envProvider]) {
      provider = envProvider;
      apiKey = envKeys[envProvider];
    } else {
      for (const [p, k] of Object.entries(envKeys)) {
        if (k) { provider = p; apiKey = k; break; }
      }
    }
    if (!model) model = process.env.AI_MODEL || "";
  }
  if (provider === "custom" && !baseUrl) baseUrl = process.env.AI_BASE_URL || "";

  const info = PROVIDERS[(provider as keyof typeof PROVIDERS) in PROVIDERS ? (provider as keyof typeof PROVIDERS) : "demo"];
  return {
    provider: info.id,
    baseUrl: baseUrl || info.baseUrl,
    apiKey: apiKey,
    model: model || info.defaultModel,
  };
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

/** 带超时 + 指数退避重试的上游请求（仅在尚未产出任何增量前重试，保证幂等） */
async function fetchUpstream(cfg: AIConfig, body: Body): Promise<Response> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
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
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok && res.body) return res;
      const text = await res.text().catch(() => "");
      lastErr = `上游模型返回 ${res.status}：${text.slice(0, 300)}`;
      if (!RETRYABLE.has(res.status)) throw new FatalUpstream(lastErr);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof FatalUpstream) throw e;
      lastErr =
        e instanceof Error && e.name === "AbortError"
          ? `上游模型响应超时（>${UPSTREAM_TIMEOUT_MS / 1000}s）`
          : e instanceof Error ? e.message : "网络错误";
    }
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // 500ms → 1s
    }
  }
  throw new Error(`${lastErr || "上游模型不可用"}（已重试 ${MAX_ATTEMPTS} 次）`);
}

async function* upstreamDeltas(cfg: AIConfig, body: Body) {
  const res = await fetchUpstream(cfg, body);
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
        const delta = j.choices?.[0]?.delta;
        const piece: string = delta?.content || "";
        if (piece) yield { piece };
      } catch { /* 半包，忽略 */ }
    }
  }
}

export async function POST(req: NextRequest) {
  const body: Body = await req.json().catch(() => ({ messages: [] }));
  const cfg = resolveConfig(req);

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
          for await (const piece of upstreamDeltas(cfg, body)) {
            if ("error" in piece) push({ t: "e", v: piece.error });
            else push({ t: "d", v: piece.piece });
          }
        }
      } catch (e) {
        push({ t: "e", v: e instanceof Error ? e.message : "未知错误" });
      } finally {
        push({ t: "end" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
