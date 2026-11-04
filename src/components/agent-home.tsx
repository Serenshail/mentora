"use client";

/* 首页学习智能体入口（M2）
 * 与学习教练的区别：单点问题直接答、零引导、零建档；
 * 只有用户明确说"想系统学 X"时才在回答末尾建议立目标（不启动引导）。
 * 思考轨迹复用 AgentTrace（检索笔记 → 思考回答 → 折叠耗时）。 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Circle, Eraser, ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { runAgent, type PendingWrite } from "@/lib/agent/runner";
import { TOOLS, type PlanStep, type ToolCall } from "@/lib/agent/protocol";
import { todayISO, uid } from "@/lib/utils";
import { toast } from "sonner";
import type { ChatMsg } from "@/lib/types";

const CHIPS = ["协程和线程到底差在哪？", "帮我看下今天该学什么", "用一句话解释闭包"];

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
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
  const [reasoning, setReasoning] = useState("");
  const [runPhase, setRunPhase] = useState<"thinking" | "acting" | "answering" | "done" | "failed" | "cancelled">("thinking");
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const pickFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("目前支持图片；文档请用「第二大脑 → 上传文档」");
      return;
    }
    if (f.size > 12 * 1024 * 1024) {
      toast.error("图片太大了（>12MB），请压缩后再传");
      return;
    }
    try {
      const img = await compressImage(f);
      setAttach({ ...img, name: f.name });
    } catch {
      toast.error("图片读取失败");
    }
  };

  const buildCtx = (ragCtx = "") => {
    const s = useAppStore.getState();
    const goal = s.goals.find((g) => g.status === "active");
    const activeDay = goal?.plan
      ? Object.values(goal.plan.days).find((d) => d.status === "active")
      : null;
    const today = todayISO();
    const due = s.knowledge.filter((k) => k.nextReviewAt && k.nextReviewAt <= today).length;
    return JSON.stringify({
      activeGoal: goal
        ? { topic: goal.topic, direction: goal.direction, currentDay: activeDay?.title ?? null }
        : null,
      dueReviews: due,
      knowledgeCount: s.knowledge.length,
      notesEvidence: ragCtx || null,
    });
  };

  /* eslint-disable react-hooks/purity -- send 只在事件/effect 回调里执行，
   * 其中的 Date.now() 用于阶段耗时统计，不会在渲染期调用（编译器静态误判） */
  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    /* 只有图片没有文字也允许（"讲讲这段代码"由图片内容本身承载） */
    if ((!q && !attach) || busy) return;
    setInput("");
    setBusy(true);
    setPending("");
    const t0 = Date.now();
    setPhases([{ label: "看看你的笔记", state: "running" }]);
    const shownText = attach ? `${q || "请看这张图"}（附图片）` : q;
    const userMsg: ChatMsg = { id: uid("m"), role: "user", content: shownText, at: new Date().toISOString() };
    appendAgentMsg(userMsg);
    const imgForModel = attach?.dataUrl ?? null;
    setAttach(null);
    const ac = new AbortController();
    abortRef.current = ac;
    setPlan([]);
    setTools([]);
    setPendingWrite(null);
    setReasoning("");
    try {
      /* 不再预检索：检索是智能体的一个工具（search_brain），
       * 由模型判断该不该用——预检索会让它"白拿证据"，永远学不会调用工具。 */
      const t1 = Date.now();
      setPhases([
        {
          label: "思考",
          state: "done",
          durationMs: t1 - t0,
          detail: "需要时会自己检索你的笔记",
        },
        { label: "回答中", state: "running" },
      ]);

      const history = [...useAppStore.getState().agentChat].slice(-8).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const { wantsDeepExplanation } = await import("@/lib/ai/prompts-lite");
      const deep = wantsDeepExplanation(q, !!imgForModel);

      /* 真正的工具循环（M3）：模型可反复要求检索/查看状态/存笔记/出题 */
      const answer = await runAgent({
        question: q || "请讲讲这张图里的内容。",
        context: buildCtx(""),
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
          onReasoning: (r) => {
            /* 思考流是模型的内部独白，只保留末段作"当前在想什么"的提示 */
            setReasoning((prev) => (prev + r).slice(-48));
          },
          onDelta: (d) => {
            /* 流式期间也剥掉 tool/plan 指令块：用户不该看到 JSON 协议 */
            setPending((prev) => {
              const merged = prev + d;
              const stripped = merged.replace(/```(?:tool|plan)[\s\S]*?```/g, "").replace(/```(?:tool|plan)[\s\S]*$/, "");
              return stripped;
            });
          },
          onPendingWrite: (w) => setPendingWrite(w),
        },
      });

      const t2 = Date.now();
      setPhases((prev) =>
        prev.map((p) => (p.state === "running" ? { ...p, state: "done", durationMs: t2 - t1 } : p))
      );
      if (answer.trim()) {
        appendAgentMsg({
          id: uid("m"),
          role: "assistant",
          content: answer,
          at: new Date().toISOString(),
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
            {shown.length === 0 ? "问什么都可以：概念、代码、图片、书里的观点" : ""}
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
          <p className="font-brand text-3xl text-ink">想弄明白什么？</p>
          <p className="mt-2 max-w-md text-[12.5px] leading-relaxed text-ink-dim">
            单独问一个问题，我直接答；贴一段代码或截图，我按行讲解。
            想系统学一门东西，去「学习」排计划——这里不逼你建档。
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

          {/* 工具调用（Codex CommandExecutionItem 模型）：状态 + 耗时 + 失败原文 */}
          {tools.length > 0 && (
            <div className="space-y-1.5">
              {tools.map((t) => (
                <div
                  key={t.id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px]",
                    t.status === "failed"
                      ? "border-bad/30 bg-bad/[0.04] text-bad"
                      : t.status === "in_progress"
                        ? "border-accent/25 bg-accent/[0.04] text-ink-dim"
                        : "border-border bg-white text-ink-dim"
                  )}
                >
                  {t.status === "in_progress" ? (
                    <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
                  ) : t.status === "failed" ? (
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

          {/* 写入确认卡（D4：智能体永不静默写入） */}
          {pendingWrite && (
            <div className="rounded-xl border border-accent/30 bg-accent/[0.04] p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
                待确认 · 存入第二大脑
              </p>
              <p className="mt-1.5 text-[13px] font-bold text-ink">{pendingWrite.title}</p>
              <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-dim">
                {pendingWrite.body.slice(0, 600)}
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  onClick={() => {
                    const { addKnowledge } = useAppStore.getState();
                    addKnowledge(
                      [{ title: pendingWrite.title, body: pendingWrite.body, domain: pendingWrite.domain }],
                      "manual",
                      "智能体对话"
                    );
                    toast.success(`已存入笔记库《${pendingWrite.title}》`);
                    setPendingWrite(null);
                  }}
                  className="cursor-pointer rounded-lg bg-[#1d1d1f] px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:bg-black/80"
                >
                  确认保存
                </button>
                <button
                  onClick={() => setPendingWrite(null)}
                  className="cursor-pointer rounded-lg border border-border bg-white px-3 py-1.5 text-[11.5px] text-ink-dim transition hover:text-ink"
                >
                  不要了
                </button>
              </div>
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
            void pickFile(e.target.files?.[0]);
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
          placeholder="问一个具体问题，或贴截图让我逐行讲解（Ctrl+V 可粘贴）"
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
