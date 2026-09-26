"use client";

import { z } from "zod";

export interface WireMsg {
  role: "user" | "assistant";
  content: string;
}

export type ChatTask =
  | "intake" | "plan" | "lesson" | "quiz-grade"
  | "review-ask" | "review-grade"
  | "reading-plan" | "reading-chat" | "council"
  | "autolink" | "persona-distill" | "coach-qa"
  | "verify-score" | "app-assistant" | "insight" | "note-assist" | "wiki-compile" | "resource-fix";

/**
 * 调用 /api/chat 的 NDJSON 流：
 *   {"t":"d","v":"文本增量"} | {"t":"e","v":"错误"} | {"t":"end"}
 * BYOK：provider/key/model 由请求头携带（客户端设置存储，服务端不落盘）。
 * task：显式任务类型，服务端 demo 模式按此分流（不嗅探提示词内容）。
 */
export async function streamChat(
  opts: {
    /** 纯数据参数；核心任务的系统提示词由服务端组装,前端不持有模板（IP 保护） */
    args?: Record<string, unknown>;
    /** 遗留通道：仅 council 暂用 */
    system?: string;
    messages: WireMsg[];
    temperature?: number;
    signal?: AbortSignal;
    task?: ChatTask;
    onDelta: (text: string) => void;
  }
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      args: opts.args,
      system: opts.system,
      messages: opts.messages,
      temperature: opts.temperature,
      task: opts.task,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    let msg = `请求失败 (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.t === "d") {
          full += ev.v;
          opts.onDelta(ev.v);
        } else if (ev.t === "e") {
          throw new Error(ev.v || "模型返回错误");
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // 半行，忽略
        throw e;
      }
    }
  }
  return full;
}

/** 从 LLM 输出中稳健提取 JSON（容忍 ```json 围栏 / 前后缀文本） */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // 大括号/中括号配对扫描（跳过字符串内部）
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  candidates.push(text.trim());

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch { /* try next */ }
  }
  throw new Error("无法从模型输出中解析 JSON");
}

/* ========= 结构化产物 Schema ========= */

export const goalCardSchema = z.object({
  topic: z.string(),
  direction: z.string(),
  domainKind: z.enum(["coding", "language", "humanities", "exam", "career", "other"]),
  motivation: z.string(),
  background: z.string(),
  deadline: z.string().optional().nullable(), // 已废弃日期承诺，仅兼容旧数据
  weeklyHours: z.number().min(1).max(80),
  learnerProfile: z.array(z.string()).optional().nullable(),
  successCriteria: z.array(z.string()).min(1),
  assumptions: z.array(z.string()).optional().nullable(),
});
export type GoalCard = z.infer<typeof goalCardSchema>;

export const masterPlanSchema = z.object({
  summary: z.string(),
  totalDaysEstimate: z.number().optional().nullable(),
  phases: z
    .array(
      z.object({
        title: z.string(),
        outcome: z.string(),
        estDays: z.number().optional().nullable(),
        outline: z.array(z.string()).min(1),
        boundary: z.string().optional().nullable(),
      })
    )
    .min(1),
});
export type MasterPlanDraft = z.infer<typeof masterPlanSchema>;

export const phasePlanSchema = z.object({
  boundary: z.string().optional().nullable(),
  days: z
    .array(
      z.object({
        title: z.string(),
        knowledgePoints: z.array(z.string()).min(1),
        resources: z.array(
          z.object({
            title: z.string(),
            url: z.string().optional().nullable(),
            why: z.string(),
            /* 资料时效/类型元数据:容错解析——模型常把年份写成字符串/带"年"、kind 自由发挥。
             * 这些是可选增强字段,绝不能因格式不符让整个计划 parse 失败(工程:边界降级)。 */
            year: z.preprocess(
              (v) =>
                typeof v === "number"
                  ? v
                  : typeof v === "string"
                    ? parseInt(v.replace(/\D/g, ""), 10) || null
                    : null,
              z.number().optional().nullable()
            ),
            kind: z.preprocess((v) => (typeof v === "string" ? v : null), z.string().optional().nullable()),
            evergreen: z.preprocess(
              (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null),
              z.boolean().optional().nullable()
            ),
          })
        ),
        method: z.string(),
        example: z
          .object({
            title: z.string(),
            description: z.string(),
            code: z.string().optional().nullable(),
          })
          .optional()
          .nullable(),
        acceptance: z
          .array(
            z.object({
              kind: z.preprocess(
                (v) => (["explain", "apply", "oral", "essay", "build"].includes(String(v)) ? v : "apply"),
                z.enum(["explain", "apply", "oral", "essay", "build"])
              ),
              question: z.string(),
              hint: z.string().optional().nullable(),
            })
          )
          .min(2),
      })
    )
    .min(1),
});
export type PhasePlanDraft = z.infer<typeof phasePlanSchema>;

export const planSchema = z.object({
  summary: z.string(),
  totalDays: z.number(),
  weeklyHours: z.number(),
  phases: z.array(
    z.object({
      title: z.string(),
      outcome: z.string(),
      days: z.array(
        z.object({
          title: z.string(),
          knowledgePoints: z.array(z.string()).min(1),
          resources: z.array(
            z.object({
            title: z.string(),
            url: z.string().optional().nullable(),
            why: z.string(),
            /* 资料时效/类型元数据:容错解析——模型常把年份写成字符串/带"年"、kind 自由发挥。
             * 这些是可选增强字段,绝不能因格式不符让整个计划 parse 失败(工程:边界降级)。 */
            year: z.preprocess(
              (v) =>
                typeof v === "number"
                  ? v
                  : typeof v === "string"
                    ? parseInt(v.replace(/\D/g, ""), 10) || null
                    : null,
              z.number().optional().nullable()
            ),
            kind: z.preprocess((v) => (typeof v === "string" ? v : null), z.string().optional().nullable()),
            evergreen: z.preprocess(
              (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null),
              z.boolean().optional().nullable()
            ),
          })
          ),
          method: z.string(),
          example: z
            .object({
              title: z.string(),
              description: z.string(),
              code: z.string().optional().nullable(),
            })
            .optional()
            .nullable(),
          acceptance: z
            .array(
              z.object({
                kind: z.preprocess(
                (v) => (["explain", "apply", "oral", "essay", "build"].includes(String(v)) ? v : "apply"),
                z.enum(["explain", "apply", "oral", "essay", "build"])
              ),
                question: z.string(),
                hint: z.string().optional().nullable(),
              })
            )
            .min(2),
        })
      ).min(1),
    })
  ).min(1),
});
export type PlanDraft = z.infer<typeof planSchema>;

export const quizGradeSchema = z.object({
  items: z.array(
    z.object({
      itemId: z.string(),
      verdict: z.enum(["pass", "fail"]),
      feedback: z.string(),
    })
  ),
  overall: z.enum(["pass", "fail"]),
  summary: z.string(),
  reviewAdvice: z.string(),
});
export type QuizGrade = z.infer<typeof quizGradeSchema>;

export const bookProfileSchema = z.object({
  positioning: z.string(),
  author: z.string(),
  lineage: z.string(),
  controversies: z.string(),
});

export const readingPlanSchema = z.object({
  bookProfile: bookProfileSchema.optional().nullable(),
  planSummary: z.string(),
  chapters: z
    .array(
      z.object({
        title: z.string(),
        coreIdea: z.string().optional().nullable(),
        focusQuestion: z.string(),
        perspectives: z.array(z.string()).optional().nullable(),
        capture: z.array(z.string()).optional().nullable(),
      })
    )
    .min(3),
});
export type ReadingPlan = z.infer<typeof readingPlanSchema>;

export const insightsSchema = z.object({
  insights: z
    .array(
      z.object({
        title: z.string(),
        body: z.string().optional().nullable(),
        knowledgePoint: z.string().optional().nullable(),
      })
    )
    .min(1),
});

export const autolinkSchema = z.object({
  links: z
    .array(z.object({ targetId: z.string(), reason: z.string() }))
    .max(5),
});

export const personaDistillSchema = z.object({
  identityNote: z.string(),
  name: z.string(),
  tag: z.string(),
  bio: z.string(),
  coreIdeas: z.array(z.string()).optional().nullable(),
  signatureQuestions: z.array(z.string()).optional().nullable(),
  style: z.string().optional().nullable(),
  quotes: z.array(z.string()).optional().nullable(),
  color: z.string().optional().nullable(),
  system: z.string(),
});

export const reviewGradeSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  feedback: z.string(),
});
