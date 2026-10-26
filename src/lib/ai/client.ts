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
  | "verify-score" | "app-assistant" | "insight" | "note-assist" | "wiki-compile" | "resource-fix" | "direction-guide" | "life-post" | "graduation"
  /* RAG 增强（2026-10-26）：查询改写 / 结果精排 */ | "query-rewrite" | "rag-rerank";

/**
 * 调用 /api/chat 的 NDJSON 流：
 *   {"t":"d","v":"文本增量"} | {"t":"e","v":"错误"} | {"t":"end"}
 * BYOK：provider/key/model 由请求头携带（客户端设置存储，服务端不落盘）。
 * task：显式任务类型，服务端 demo 模式按此分流（不嗅探提示词内容）。
 */
/** v17：BYOK 真接线——设置里填了自己的 Key 就随请求带上
 *  （此前这些头服务端支持但客户端从不发送，"BYOK"只是文案）。
 *  动态 import：纯 Node 环境（vitest/e2e）拿不到浏览器 store 时静默降级为服务端模式。 */
async function byokHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const { useAppStore } = await import("@/lib/store");
    const st = useAppStore.getState().settings;
    if (st.apiKey && st.provider && st.provider !== "demo") {
      h["x-mentora-key"] = st.apiKey.trim();
      h["x-mentora-provider"] = st.provider;
      if (st.model.trim()) h["x-mentora-model"] = st.model.trim();
      if (st.provider === "custom" && st.baseUrl.trim()) h["x-mentora-baseurl"] = st.baseUrl.trim();
    }
  } catch { /* 无 store 环境：不带头，服务端走自身配置 */ }
  return h;
}

export async function streamChat(
  opts: {
    /** 纯数据参数；核心任务的系统提示词由服务端按 task 组装,前端不持有模板（IP 保护） */
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
    headers: await byokHeaders(),
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
  const scanned: { start: number; text: string }[] = [];
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
    // 记录起点,后面按"在原文中出现最早"排序——裸数组 "[{...}]" 时先命中整个数组而非首个对象
    if (end > start) scanned.push({ start, text: text.slice(start, end + 1) });
  }
  scanned.sort((a, b) => a.start - b.start);
  for (const s of scanned) candidates.push(s.text);
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
        knowledgePoints: z.array(z.union([
          z.string(),
          z.object({
            text: z.string(),
            knowledgeType: z.preprocess(
              (v) => {
                const s = String(v ?? "").toLowerCase();
                if (["fact", "concept", "procedure", "discrimination", "judgment", "creative"].includes(s)) return s;
                return undefined;
              },
              z.enum(["fact", "concept", "procedure", "discrimination", "judgment", "creative"]).optional()
            ),
          }),
        ])).min(1),
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
      verdict: z.preprocess(
        (v) => {
          const s = String(v ?? "").toLowerCase();
          // 兼容旧 pass/fail 格式
          if (s === "pass" || s === "correct") return "correct";
          if (s === "fail" || s === "incorrect") return "incorrect";
          if (s === "partially_correct" || s === "partial") return "partially_correct";
          if (s === "ungradable") return "ungradable";
          return "incorrect";
        },
        z.enum(["correct", "partially_correct", "incorrect", "ungradable"])
      ),
      /** 判分证据：必须引用讲义/知识点原文作为本次判定依据。
       *  v21：没有证据的 correct/partially_correct 会被降级为 ungradable（见 normalizeQuizGrade）——
       *  验收的参照物是当天讲义，不是模型自己的记忆。 */
      evidence: z.preprocess(
        (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 400) : ""),
        z.string()
      ),
      feedback: z.string(),
      hintLevel: z.preprocess(
        (v) => (typeof v === "number" ? Math.min(5, Math.max(0, Math.round(v))) : undefined),
        z.number().optional()
      ),
    })
  ),
  overall: z.preprocess(
    (v) => {
      const s = String(v ?? "").toLowerCase();
      if (s === "pass" || s === "correct") return "pass";
      if (s === "fail" || s === "incorrect") return "fail";
      return "fail";
    },
    z.enum(["pass", "fail"])
  ),
  /** 掌握升级所需证据表（Learn Anything assessment-integrity）：
   *  每项的四级判分+提示等级都在 items 里,由前端据此推掌握状态并执行 guided 封顶。 */
  summary: z.string(),
  reviewAdvice: z.string(),
  /** 每课即时复习门（Learn Anything 硬规则：未完成即时复习不得进入下一课）：
   *  迁移任务=变化后的新情境小题,summary 已含一句话总结;均由判分模型一次性产出。 */
  transferQuestion: z.preprocess(
    (v) => (typeof v === "string" && v.trim() ? v.trim() : null),
    z.string().nullable().optional()
  ),
});
export type QuizGrade = z.infer<typeof quizGradeSchema>;

/** 证据强制：把没有 evidence 的正向判定降级为 ungradable，并按降级后的 items 重算 overall。
 *  为什么必须在代码里做而不是只写提示词：模型经常"结论对、依据错"或干脆不给依据，
 *  而提示词约束不是确定性执行。这一层是验收可靠性的最后一道闸。 */
export function normalizeQuizGrade(g: QuizGrade): QuizGrade {
  const items = g.items.map((it) => {
    const positive = it.verdict === "correct" || it.verdict === "partially_correct";
    if (positive && !it.evidence) {
      return {
        ...it,
        verdict: "ungradable" as const,
        feedback: (it.feedback || "") + "（未引用讲义原文作为依据，本次判定不计为通过）",
      };
    }
    return it;
  });
  const hasIncorrect = items.some((it) => it.verdict === "incorrect");
  const hasPositive = items.some((it) => it.verdict === "correct" || it.verdict === "partially_correct");
  const hasUngradable = items.some((it) => it.verdict === "ungradable");
  /* 与提示词口径一致：全部 correct/partially 才算 pass；但模型说 pass 而实际没有正向证据时不得通过 */
  const overall: "pass" | "fail" =
    hasIncorrect || !hasPositive || hasUngradable ? "fail" : "pass";
  return { ...g, items, overall };
}

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
        knowledgeType: z.preprocess(
          (v) => {
            const s = String(v ?? "").toLowerCase();
            if (["fact", "concept", "procedure", "discrimination", "judgment", "creative"].includes(s)) return s;
            return "concept"; // 默认值
          },
          z.enum(["fact", "concept", "procedure", "discrimination", "judgment", "creative"])
        ),
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
  verdict: z.preprocess(
    (v) => {
      const s = String(v ?? "").toLowerCase();
      if (["pass", "correct", "true", "通过", "回忆成功"].includes(s)) return "pass";
      return "fail";
    },
    z.enum(["pass", "fail"])
  ),
  /** 复习通过必须引用笔记原文作为依据；无证据的 pass 在 normalizeReviewGrade 里降级为 fail。 */
  evidence: z.preprocess(
    (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 400) : ""),
    z.string()
  ),
  feedback: z.string(),
});

/** 复习证据强制：无 evidence 的 pass 一律改判 fail（不给"模棱两可也算记住"的口子）。 */
export function normalizeReviewGrade(g: { verdict: "pass" | "fail"; evidence: string; feedback: string }) {
  if (g.verdict === "pass" && !g.evidence) {
    return {
      ...g,
      verdict: "fail" as const,
      feedback: (g.feedback || "") + "（未能引用笔记原文作为依据，本次不计通过）",
    };
  }
  return g;
}

export const graduationSchema = z.object({
  noteMarkdown: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : ""),
    z.string().min(20, "结业笔记过短")
  ),
  nextSteps: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, 3) : []),
    z.array(z.string())
  ),
});
export type Graduation = z.infer<typeof graduationSchema>;
