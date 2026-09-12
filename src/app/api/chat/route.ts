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
    default: return demoCouncil(messages);
  }
}

function ndjson(res: ReadableStreamDefaultController, chunk: string) {
  res.enqueue(new TextEncoder().encode(chunk + "\n"));
}

async function* upstreamDeltas(cfg: AIConfig, body: Body) {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        ...(body.system ? [{ role: "system", content: body.system }] : []),
        ...body.messages,
      ],
      stream: true,
      temperature: body.temperature ?? 0.7,
    }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    yield { error: `上游模型返回 ${res.status}：${text.slice(0, 300)}` };
    return;
  }

  const reader = res.body.getReader();
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
