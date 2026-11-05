"use client";

/* 首页主对话框（v2，通用智能体 harness）
 * 内核：runAgent 工具循环（原生 tool_calls + 围栏降级、审批门、打转守卫）。
 * UI：消息流（含过程产物 meta）+ 流式正文 + 审批卡队列 + 引用来源。
 * 页面关系：对话是主入口；学习/读书/圆桌/笔记库保留为工作台，Agent 的写入
 * 最终都落到这些工作台的数据里。 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Circle, Eraser, ImagePlus, Link2, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { runAgent, type PendingAction } from "@/lib/agent/runner";
import { TOOLS, type ApprovalDecision, type PlanStep, type ToolCall } from "@/lib/agent/protocol";
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import type { ChatMsg } from "@/lib/types";

const CHIPS = ["帮我查一下最新的 Next.js 15 有什么新特性", "协程和线程到底差在哪？", "把「间隔重复的原理」整理成一篇笔记存起来"];

/* 图片压缩：模型对超大图会拒绝且浪费 token；长边压到 1400、JPEG 0.82 足够读代码截图 */
async function compressImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持图片处理");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), w, h };
}

interface Attachment {
  dataUrl: string;
  name: string;
  w: number;
  h: number;
}

function buildCtx(): string {
  const s = useAppStore.getState();
  const goal = s.goals.find((g) => g.status === "active");
  const today = new Date().toISOString().slice(0, 10);
  const due = s.knowledge.filter((k) => k.nextReviewAt && k.nextReviewAt <= today).length;
  return JSON.stringify({
    today,
    activeGoal: goal ? { topic: goal.topic, direction: goal.direction } : null,
    knowledgeCount: s.knowledge.length,
    dueReviews: due,
    books: s.books.length,
    userName: s.settings.userName || null,
  });
}

/** 审批卡内容预览（按动作类型取关键字段） */
function actionPreview(a: PendingAction): string | null {
  const p = a.payload as Record<string, unknown>;
  if (a.kind === "save_note" || a.kind === "update_note") {
    const body = typeof p.body === "string" ? p.body : "";
    return body ? body.slice(0, 400) : null;
  }
  if (a.kind === "create_goal") {
    const criteria = Array.isArray(p.successCriteria) ? p.successCriteria.join("；") : "";
    return [p.direction, p.motivation, criteria].filter((x) => typeof x === "string" && x).join("\n") || null;
  }
  if (a.kind === "add_book") return [p.author, p.brief].filter((x) => typeof x === "string" && x).join(" · ") || null;
  if (a.kind === "update_settings") return a.summary;
  return null;
}

export function AgentHome() {
  const agentChat = useAppStore((s) => s.agentChat);
  const appendAgentMsg = useAppStore((s) => s.appendAgentMsg);
  const clearAgentChat = useAppStore((s) => s.clearAgentChat);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [phases, setPhases] = useState<TracePhase[]>([]);
  const [attach, setAttach] = useState<Attachment | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [reasoning, setReasoning] = useState("");
  const [runPhase, setRunPhase] = useState<"thinking" | "acting" | "answering" | "done" | "failed" | "cancelled">("thinking");
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /* 审批门：requestApproval 挂起 runAgent，直到用户对每张卡做出决定 */
  const approvalResolveRef = useRef<((d: ApprovalDecision[]) => void) | null>(null);
  const decisionsRef = useRef<Map<string, boolean>>(new Map());
  const abortHandlerRef = useRef<(() => void) | null>(null);

  /* 粘贴截图：全局监听 paste，有图片就收进附件（不打断输入框正常粘贴文字） */
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      try {
        const img = await compressImage(file);
        setAttach({ ...img, name: "粘贴的截图" });
        toast.success("已读取截图，可以写你的问题");
      } catch {
        toast.error("图片读取失败");
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const requestApproval = (actions: PendingAction[]): Promise<ApprovalDecision[]> => {
    decisionsRef.current = new Map();
    setPendingActions(actions);
    return new Promise((resolve) => {
      const finish = (d: ApprovalDecision[]) => {
        if (abortHandlerRef.current && abortRef.current) {
          abortRef.current.signal.removeEventListener("abort", abortHandlerRef.current);
          abortHandlerRef.current = null;
        }
        approvalResolveRef.current = null;
        setPendingActions([]);
        resolve(d);
      };
      approvalResolveRef.current = finish;
      /* 等待审批期间用户点「停止」→ 全部拒绝并继续（模型会收到拒绝并收尾） */
      const onAbort = () => finish(actions.map((a) => ({ actionId: a.id, approved: false })));
      abortHandlerRef.current = onAbort;
      abortRef.current?.signal.addEventListener("abort", onAbort);
    });
  };

  const decide = (actionId: string, approved: boolean) => {
    decisionsRef.current.set(actionId, approved);
    setPendingActions((prev) => {
      const rest = prev.filter((a) => a.id !== actionId);
      if (rest.length === 0) {
        approvalResolveRef.current?.(
          [...decisionsRef.current].map(([id, ok]) => ({ actionId: id, approved: ok }))
        );
      }
      return rest;
    });
  };

  /* eslint-disable react-hooks/purity */
  const send = async (preset?: string) => {
    const q = (preset ?? input).trim();
    if ((!q && !attach) || busy) return;
    setInput("");
    setBusy(true);
    setPending("");
    setPlan([]);
    setTools([]);
    setPendingActions([]);
    setReasoning("");
    const ac = new AbortController();
    abortRef.current = ac;
    const imgForModel = attach?.dataUrl ?? null;
    setAttach(null);

    const t0 = Date.now();
    setPhases([
      { label: "思考", state: "running" },
      { label: "回答中", state: "pending" },
    ]);

    const userMsg: ChatMsg = { id: uid("m"), role: "user", content: q || "（图片）", at: new Date().toISOString() };
    appendAgentMsg(userMsg);

    try {
      setPhases([
        { label: "思考", state: "done", durationMs: Date.now() - t0 },
        { label: "回答中", state: "running" },
      ]);
      const history = [...useAppStore.getState().agentChat].slice(-9).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const { wantsDeepExplanation } = await import("@/lib/ai/prompts-lite");
      const deep = wantsDeepExplanation(q, !!imgForModel);

      const { answer, meta } = await runAgent({
        question: q || "请讲讲这张图里的内容。",
        context: buildCtx(),
        imageUrl: imgForModel,
        history,
        deep,
        signal: ac.signal,
        cb: {
          onPhase: (ph) => setRunPhase(ph),
          onPlan: (pl) => setPlan(pl),
          onTool: (tc) => {
            setPending(""); // 该轮正文只是过渡语，清掉等最终答案
            setTools((prev) => {
              const i = prev.findIndex((x) => x.id === tc.id);
              if (i < 0) return [...prev, tc];
              const copy = [...prev];
              copy[i] = tc;
              return copy;
            });
          },
          onReasoning: (r) => setReasoning((prev) => (prev + r).slice(-48)),
          onDelta: (d) => {
            /* 流式期间剥掉 tool/plan 指令块：用户不该看到 JSON 协议 */
            setPending((prev) => {
              const merged = prev + d;
              return merged.replace(/```(?:tool|plan)[\s\S]*?```/g, "").replace(/```(?:tool|plan)[\s\S]*$/, "");
            });
          },
          requestApproval,
        },
      });

      const t2 = Date.now();
      setPhases((prev) =>
        prev.map((p) => (p.state === "running" ? { ...p, state: "done", durationMs: t2 - t0 } : p))
      );
      if (answer.trim() || meta.tools.length > 0 || meta.citations.length > 0) {
        appendAgentMsg({
          id: uid("m"),
          role: "assistant",
          content: answer,
          at: new Date().toISOString(),
          meta: {
            plan: meta.plan.length ? meta.plan : undefined,
            tools: meta.tools.length
              ? meta.tools.map((t) => ({
                  id: t.id,
                  name: t.name,
                  status: t.status,
                  summary: t.summary,
                  durationMs: t.endedAt ? t.endedAt - t.startedAt : undefined,
                }))
              : undefined,
            citations: meta.citations.length ? meta.citations.slice(0, 8) : undefined,
          },
        });
      }
      setPending("");
    } catch (e) {
      setPhases((prev) => prev.map((p) => (p.state === "running" ? { ...p, state: "failed" } : p)));
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        toast.error(e instanceof Error ? e.message : "回答失败，请重试");
      }
      setPending("");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };
  /* eslint-enable react-hooks/purity */

  const shown = agentChat.slice(-10);

  return (
    <div className="flex h-[calc(100dvh-150px)] min-h-[520px] flex-col">
      {/* 极简头部：一个标识 + 清空（Codex 式的克制） */}
      <div className="flex items-center justify-between px-1 pb-3">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-lg bg-[#1d1d1f] text-white">
            <Sparkles className="size-3.5" />
          </span>
          <p className="text-[13px] font-semibold text-ink">Mentora</p>
          <span className="text-[11px] text-ink-dim/70">
            {shown.length === 0 ? "问什么都可以：搜索、讲解、建笔记、改设置" : ""}
          </span>
        </div>
        {agentChat.length > 0 && (
          <button
            onClick={clearAgentChat}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink"
            title="清空这段对话"
          >
            <Eraser className="size-3" /> 清空
          </button>
        )}
      </div>

      {shown.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
          <p className="font-brand text-3xl text-ink">想做什么？</p>
          <p className="mt-2 max-w-md text-[12.5px] leading-relaxed text-ink-dim">
            提问、联网搜索、建笔记、加书、开目标、改设置——说一声就行。
            写入操作会先给你确认，不会不打招呼就动你的数据。
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {CHIPS.map((c) => (
              <button
                key={c}
                onClick={() => void send(c)}
                className="cursor-pointer rounded-full border border-border bg-white px-3.5 py-2 text-[12px] text-ink-dim transition hover:border-accent/40 hover:text-ink"
              >
                {c}
              </button>
            ))}
            <button
              onClick={() => fileRef.current?.click()}
              className="cursor-pointer rounded-full border border-accent/30 bg-accent/[0.06] px-3.5 py-2 text-[12px] text-accent transition hover:bg-accent/[0.12]"
            >
              📎 传张截图 / 代码图
            </button>
          </div>
        </div>
      )}

      {shown.length > 0 && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-3">
          {shown.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#1d1d1f] px-3.5 py-2 text-[12.5px] text-white">
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-border bg-white px-3.5 py-2.5">
                  <Markdown text={m.content} className="text-[12.5px]" />
                  <MsgMetaView meta={m.meta} />
                </div>
              )}
            </div>
          ))}
          {pending && (
            <div
              aria-live="polite"
              className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-border bg-white px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink"
            >
              {pending}
              <span className="stream-cursor" />
            </div>
          )}

          {/* 审批卡队列：写入操作等待用户逐个决定 */}
          {pendingActions.map((a) => {
            const preview = actionPreview(a);
            return (
              <div key={a.id} className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                  待确认 · {a.label}
                </p>
                <p className="mt-1.5 text-[13px] font-bold text-ink">{a.summary}</p>
                {preview && (
                  <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-dim">
                    {preview}
                  </p>
                )}
                <div className="mt-2.5 flex gap-2">
                  <button
                    onClick={() => decide(a.id, true)}
                    className="cursor-pointer rounded-lg bg-[#1d1d1f] px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:bg-black/80"
                  >
                    批准执行
                  </button>
                  <button
                    onClick={() => decide(a.id, false)}
                    className="cursor-pointer rounded-lg border border-border bg-white px-3 py-1.5 text-[11.5px] text-ink-dim transition hover:text-ink"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            );
          })}

          {/* 思考摘要（Codex ReasoningItem 模型）：只给骨架，不给完整思维链 */}
          {(reasoning || (busy && runPhase !== "answering")) && (
            <div className="flex items-center gap-2 text-[11.5px] text-ink-dim">
              {busy && runPhase !== "answering" ? (
                <Loader2 className="size-3 animate-spin text-accent" />
              ) : (
                <Check className="size-3 text-ok/70" />
              )}
              <span className="line-clamp-2 leading-4">
                {reasoning
                  ? reasoning.replace(/\s+/g, " ").slice(-40)
                  : runPhase === "thinking"
                    ? "正在理解你的问题…"
                    : runPhase === "acting"
                      ? "正在调用工具…"
                      : "准备回答"}
              </span>
            </div>
          )}

          {/* 外显计划（Codex PlanItem 模型）：每步三态可见 */}
          {plan.length > 0 && (
            <div className="rounded-xl border border-border bg-surface-2/50 px-3 py-2.5">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
                计划
              </p>
              <ol className="space-y-1">
                {plan.map((st) => (
                  <li key={st.id} className="flex items-start gap-2 text-[12px]">
                    <span className="mt-[3px] shrink-0">
                      {st.status === "completed" ? (
                        <Check className="size-3.5 text-ok" />
                      ) : st.status === "in_progress" ? (
                        <Loader2 className="size-3.5 animate-spin text-accent" />
                      ) : st.status === "skipped" ? (
                        <X className="size-3.5 text-ink-dim/40" />
                      ) : (
                        <Circle className="size-3.5 text-ink-dim/30" />
                      )}
                    </span>
                    <span
                      className={cn(
                        st.status === "in_progress" ? "text-ink" : "text-ink-dim",
                        st.status === "completed" && "line-through decoration-ink-dim/30"
                      )}
                    >
                      {st.text}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* 工具调用（Codex CommandExecutionItem 模型）：状态 + 耗时 + 失败/拒绝原文 */}
          {tools.length > 0 && (
            <div className="space-y-1.5">
              {tools.map((t) => (
                <div
                  key={t.id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px]",
                    t.status === "failed"
                      ? "border-bad/30 bg-bad/[0.04] text-bad"
                      : t.status === "declined"
                        ? "border-border bg-surface-2 text-ink-dim line-through decoration-ink-dim/40"
                        : t.status === "in_progress"
                          ? "border-accent/25 bg-accent/[0.04] text-ink-dim"
                          : "border-border bg-white text-ink-dim"
                  )}
                >
                  {t.status === "in_progress" ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
                  ) : t.status === "failed" ? (
                    <X className="size-3 shrink-0" />
                  ) : t.status === "declined" ? (
                    <X className="size-3 shrink-0" />
                  ) : (
                    <Check className="size-3 shrink-0 text-ok" />
                  )}
                  <span className="font-medium">{TOOLS[t.name]?.label ?? t.name}</span>
                  {t.summary && <span className="truncate opacity-70">· {t.summary}</span>}
                  {t.endedAt && (
                    <span className="ml-auto shrink-0 tabular-nums opacity-50">
                      {t.endedAt - t.startedAt}ms
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <AgentTrace phases={phases} />
        </div>
      )}

      {attach && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-accent/25 bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={attach.dataUrl} alt={attach.name} className="size-14 rounded-lg border border-border object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11.5px] font-medium text-ink">{attach.name}</p>
            <p className="text-[10.5px] text-ink-dim">
              {attach.w}×{attach.h} · 会先读图再讲解
            </p>
          </div>
          <button
            onClick={() => setAttach(null)}
            aria-label="移除图片"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-ink-dim transition hover:bg-black/[0.05] hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="mt-auto flex gap-2 border-t border-border/60 pt-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void compressImage(f).then((img) => setAttach({ ...img, name: f.name })).catch(() => toast.error("图片读取失败"));
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="上传图片（也可以直接 Ctrl+V 粘贴截图）"
          aria-label="上传图片"
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl border border-border bg-white text-ink-dim transition hover:border-accent/40 hover:text-ink"
        >
          <ImagePlus className="size-4" />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void send()}
          placeholder="提问、搜索、建笔记、改设置……（Ctrl+V 可粘贴截图）"
          disabled={busy}
          className="h-10 w-full rounded-xl border border-border bg-white px-3.5 text-sm outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12] disabled:opacity-60"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          aria-label="发送"
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl bg-[#1d1d1f] text-white transition hover:bg-black/80 disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
      {busy && (
        <button
          onClick={() => abortRef.current?.abort()}
          className="mt-2 cursor-pointer text-[11px] text-ink-dim hover:text-ink"
        >
          停止
        </button>
      )}
    </div>
  );
}

/** 历史消息的过程产物渲染（计划/工具/引用来源，刷新后仍在） */
function MsgMetaView({ meta }: { meta?: ChatMsg["meta"] }) {
  if (!meta) return null;
  const hasAny =
    (meta.plan && meta.plan.length > 0) ||
    (meta.tools && meta.tools.length > 0) ||
    (meta.citations && meta.citations.length > 0);
  if (!hasAny) return null;
  return (
    <div className="mt-2.5 space-y-2 border-t border-border/60 pt-2.5">
      {meta.tools && meta.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {meta.tools.map((t) => (
            <span
              key={t.id}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[10.5px]",
                t.status === "failed"
                  ? "bg-bad/[0.08] text-bad"
                  : t.status === "declined"
                    ? "bg-surface-2 text-ink-dim line-through"
                    : "bg-surface-2 text-ink-dim"
              )}
              title={t.summary}
            >
              {TOOLS[t.name as keyof typeof TOOLS]?.label ?? t.name}
              {t.durationMs != null && <span className="opacity-50"> {t.durationMs}ms</span>}
            </span>
          ))}
        </div>
      )}
      {meta.citations && meta.citations.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim">
            <Link2 className="size-3" /> 来源
          </p>
          {meta.citations.slice(0, 5).map((c, i) => (
            <a
              key={`${c.url}-${i}`}
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-[11px] text-accent underline-offset-2 hover:underline"
            >
              [{i + 1}] {c.title || c.url}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
