"use client";

/* 首页主对话框（v2，通用智能体 harness）
 * 内核：runAgent 工具循环（原生 tool_calls + 围栏降级、审批门、打转守卫）。
 * UI：消息流（含过程产物 meta）+ 流式正文 + 审批卡队列 + 引用来源。
 * 页面关系：对话是主入口；学习/读书/圆桌/笔记库保留为工作台，Agent 的写入
 * 最终都落到这些工作台的数据里。 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, Circle, Eraser, ImagePlus, Link2, Loader2, PanelsTopLeft, Plus, Sparkles, X, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { runAgent, type PendingAction } from "@/lib/agent/runner";
import { TOOLS, type ApprovalDecision, type PlanStep, type ToolCall } from "@/lib/agent/protocol";
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import type { ChatMsg } from "@/lib/types";

/* 工作台「产物」统计的写入类工具集合（与 tool-executors 的写工具一致） */
const WRITE_TOOL_NAMES = new Set(["save_note", "update_note", "delete_note", "create_goal", "add_book", "create_session", "update_settings", "memory", "reminders", "update_plan_resources", "regenerate_phase"]);

/** SOLO 右栏的分块容器 */
function RailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-2.5">
      <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim">{title}</p>
      {children}
    </div>
  );
}

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
  /* 上下文选择雏形（阶段二）：注入"学习焦点"而不是计数——
   * 当前天、最近卡壳的验收、快到期的知识点标题；计数类已被 read_context 工具覆盖。 */
  const s = useAppStore.getState();
  const goal = s.goals.find((g) => g.status === "active");
  const today = new Date().toISOString().slice(0, 10);
  const cut40 = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t);

  const days = goal?.plan ? Object.values(goal.plan.days) : [];
  const currentDay = days.find((d) => d.status === "active")?.title ?? null;

  /* 最近卡壳：最近 3 条验收里非 correct 的项（dayId 反查当天标题） */
  const recentStruggles: { day: string; verdict: string; question: string }[] = [];
  for (const q of [...(goal?.quizLog ?? [])].reverse()) {
    if (recentStruggles.length >= 3) break;
    for (const it of q.items) {
      if (it.verdict !== "correct" && recentStruggles.length < 3) {
        recentStruggles.push({
          day: cut40(goal?.plan?.days[q.dayId]?.title ?? q.dayId),
          verdict: it.verdict,
          question: cut40(it.question),
        });
      }
    }
  }

  const dueSample = s.knowledge
    .filter((k) => k.nextReviewAt && k.nextReviewAt <= today)
    .slice(0, 3)
    .map((k) => cut40(k.title));

  return JSON.stringify({
    today,
    activeGoal: goal ? { topic: goal.topic, direction: goal.direction } : null,
    currentDay,
    dueReviews: s.knowledge.filter((k) => k.nextReviewAt && k.nextReviewAt <= today).length,
    dueSample,
    recentStruggles,
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
  /* v23.2 多会话：渲染与写入都走 agentSessions；agentChat 仅是 v6 迁移遗留 */
  const activeId = useAppStore((s) => s.agentActiveId);
  const sessions = useAppStore((s) => s.agentSessions);
  const appendAgentMsg = useAppStore((s) => s.appendAgentMsg);
  const clearAgentChat = useAppStore((s) => s.clearAgentChat);
  const newAgentSession = useAppStore((s) => s.newAgentSession);
  const setAgentActive = useAppStore((s) => s.setAgentActive);
  const removeAgentSession = useAppStore((s) => s.removeAgentSession);
  const activeSession = sessions.find((x) => x.id === activeId) ?? null;
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  /* v26.1：本轮生成归属的会话——切走会话后，运行态（流式/工具/审批卡）只在归属会话视图渲染 */
  const [runSessionId, setRunSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [phases, setPhases] = useState<TracePhase[]>([]);
  const [attach, setAttach] = useState<Attachment | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [runPhase, setRunPhase] = useState<"thinking" | "acting" | "answering" | "done" | "failed" | "cancelled">("thinking");
  const abortRef = useRef<AbortController | null>(null);
  /* v26.1 消息自动滚动：用户在底部附近时跟随最新内容；主动上滚查看历史时不强制拉回 */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [pending, activeId]);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /* 审批门：requestApproval 挂起 runAgent，直到用户对每张卡做出决定 */
  const approvalResolveRef = useRef<((d: ApprovalDecision[]) => void) | null>(null);
  const decisionsRef = useRef<Map<string, boolean>>(new Map());
  const abortHandlerRef = useRef<(() => void) | null>(null);

  /* 粘贴截图：全局监听 paste，有图片就收进附件。不劫持其它可编辑区
   * （焦点在助手输入框/笔记编辑器时照常粘贴，内容不静默丢失）；自家输入框内仍收图。 */
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const t = e.target as HTMLElement | null;
      const inOwnInput = !!t && !!inputRef.current?.contains(t);
      if (t && !inOwnInput && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
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

  /* 卸载（切路由）时中止在途 runAgent：工具循环最多 5 轮 + 最终回答，全部会打到上游
   * 白烧 token；返回首页再提问还会出现两条并发循环（use-chat.ts:108 已有同款清理）。 */
  useEffect(() => () => abortRef.current?.abort(), []);

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
    // 只有内容来自输入框时才清空，点示例 chip 不清掉用户正在写的草稿
    if (!preset) setInput("");
    setBusy(true);
    setPending("");
    setPlan([]);
    setTools([]);
    setPendingActions([]);
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
    const runSid = useAppStore.getState().appendAgentMsg(userMsg);
    setRunSessionId(runSid);

    try {
      setPhases([
        { label: "思考", state: "done", durationMs: Date.now() - t0 },
        { label: "回答中", state: "running" },
      ]);
      /* 历史上下文：当前激活会话最近 9 条（appendAgentMsg 已把本轮用户消息落库） */
      const stAfter = useAppStore.getState();
      const activeNow = stAfter.agentSessions.find((x) => x.id === stAfter.agentActiveId);
      const history = (activeNow?.messages ?? []).slice(-9).map((m) => ({
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
          onReasoning: () => {}, // v26.1：不展示原始推理文本，只保留阶段标签
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
          // v26.1：显式落回发起会话
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
        }, runSid);
      }
      setPending("");
    } catch (e) {
      // 用户主动「停止」= cancelled，不是失败：轨迹标中性，不伪装成红色失败
      const aborted = e instanceof DOMException && e.name === "AbortError";
      setPhases((prev) =>
        prev.map((p) => (p.state === "running" ? { ...p, state: aborted ? "cancelled" : "failed" } : p))
      );
      if (!aborted) {
        toast.error(e instanceof Error ? e.message : "回答失败，请重试");
      }
      setPending("");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };
  /* eslint-enable react-hooks/purity */

  const shown = (activeSession?.messages ?? []).slice(-10);
  const switchSession = (id: string) => {
    setAgentActive(id);
    setPending("");
    setPlan([]);
    setTools([]);
    setPendingActions([]);
  };
  /* 工作台「产物」：本会话的写入结果与引用来源（Trae Context 式聚合） */
  const artifacts = (() => {
    const arts: { key: string; label: string; summary?: string }[] = [];
    const cites: { title: string; url: string }[] = [];
    const seenUrl = new Set<string>();
    for (const m of activeSession?.messages ?? []) {
      for (const t of m.meta?.tools ?? []) {
        if (t.status === "completed" && WRITE_TOOL_NAMES.has(t.name)) {
          arts.push({ key: t.id, label: TOOLS[t.name as keyof typeof TOOLS]?.label ?? t.name, summary: t.summary });
        }
      }
      for (const c of m.meta?.citations ?? []) {
        if (!seenUrl.has(c.url)) { seenUrl.add(c.url); cites.push(c); }
      }
    }
    return { arts, cites };
  })();
  /* 最近一条带过程产物的历史消息（旧会话打开工作台也有上下文） */
  const latestMeta = [...(activeSession?.messages ?? [])].reverse().find((m) => m.meta?.plan?.length || m.meta?.tools?.length)?.meta;
  /* 工作台三块（任务 / 产物 / 会话）：桌面右栏与移动 slide-over 共用 */
  const railBlocks = (
    <>
      <RailBlock title="任务">
        {plan.length > 0 || tools.length > 0 ? (
          <>
            {runSessionId === activeId && plan.length > 0 && (
              <ol className="space-y-1">
                {plan.map((st) => (
                  <li key={st.id} className="flex items-start gap-1.5 text-[11.5px]">
                    <span className="mt-[3px] shrink-0">
                      {st.status === "completed" ? (
                        <Check className="size-3 text-ok" />
                      ) : st.status === "in_progress" ? (
                        <Loader2 className="size-3 animate-spin text-accent" />
                      ) : st.status === "skipped" ? (
                        <X className="size-3 text-ink-dim/40" />
                      ) : (
                        <Circle className="size-3 text-ink-dim/30" />
                      )}
                    </span>
                    <span className={cn(st.status === "in_progress" ? "text-ink" : "text-ink-dim", st.status === "completed" && "line-through decoration-ink-dim/30")}>
                      {st.text}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {runSessionId === activeId && tools.length > 0 && (
              <div className={cn("space-y-1", plan.length > 0 && "mt-2")}>
                {tools.map((t) => (
                  <div
                    key={t.id}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
                      t.status === "failed"
                        ? "border-bad/30 bg-bad/[0.04] text-bad"
                        : t.status === "declined"
                          ? "border-border bg-white text-ink-dim line-through decoration-ink-dim/40"
                          : t.status === "in_progress"
                            ? "border-accent/25 bg-accent/[0.04] text-ink-dim"
                            : "border-border bg-white text-ink-dim"
                    )}
                  >
                    {t.status === "in_progress" ? (
                      <Loader2 className="size-3 shrink-0 animate-spin text-accent" />
                    ) : t.status === "failed" || t.status === "declined" ? (
                      <X className="size-3 shrink-0" />
                    ) : (
                      <Check className="size-3 shrink-0 text-ok" />
                    )}
                    <span className="shrink-0 font-medium">{TOOLS[t.name]?.label ?? t.name}</span>
                    {t.summary && <span className="truncate opacity-70">· {t.summary}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : latestMeta?.plan?.length ? (
          <ol className="space-y-1">
            {latestMeta.plan.map((st) => (
              <li key={st.id} className={cn("flex items-center gap-1.5 text-[11.5px]", st.status === "completed" && "text-ink-dim line-through decoration-ink-dim/30")}>
                {st.status === "completed" ? <Check className="size-3 shrink-0 text-ok" /> : <Circle className="size-3 shrink-0 text-ink-dim/30" />}
                <span className="truncate">{st.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[11px] leading-relaxed text-ink-dim/60">多步任务会在这里展开为计划与工具调用；写入动作完成后沉淀到「产物」。</p>
        )}
      </RailBlock>
      <RailBlock title="产物">
        {artifacts.arts.length === 0 && artifacts.cites.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-ink-dim/60">存笔记、建目标、加书等写入结果与联网来源会沉淀在这里。</p>
        ) : (
          <div className="space-y-1.5">
            {artifacts.arts.map((a) => (
              <div key={a.key} className="flex items-center gap-1.5 text-[11.5px] text-ink-dim">
                <Check className="size-3 shrink-0 text-ok" />
                <span className="shrink-0 font-medium text-ink">{a.label}</span>
                {a.summary && <span className="truncate opacity-70">· {a.summary}</span>}
              </div>
            ))}
            {artifacts.cites.map((c, i) => (
              <a key={c.url} href={c.url} target="_blank" rel="noopener noreferrer" className="block truncate text-[11px] text-accent hover:underline">
                [{i + 1}] {c.title || c.url}
              </a>
            ))}
          </div>
        )}
      </RailBlock>
      <RailBlock title="会话">
        {sessions.length === 0 ? (
          <p className="text-[11px] text-ink-dim/60">还没有历史对话。</p>
        ) : (
          <div className="space-y-0.5">
            {sessions.map((sess) => (
              <div key={sess.id} className={cn("group flex items-center gap-1 rounded-lg px-1.5 py-1", sess.id === activeId ? "bg-surface-2" : "hover:bg-black/[0.04]")}>
                <button onClick={() => switchSession(sess.id)} className="min-w-0 flex-1 cursor-pointer text-left">
                  <p className="truncate text-[12px] text-ink">{sess.title}</p>
                  <p className="text-[10px] text-ink-dim/70">{sess.messages.length} 条 · {new Date(sess.updatedAt).toLocaleDateString("zh-CN")}</p>
                </button>
                <button onClick={() => removeAgentSession(sess.id)} aria-label="删除这段对话" className="cursor-pointer rounded-md p-1 text-ink-dim/50 opacity-0 transition hover:bg-bad/10 hover:text-bad group-hover:opacity-100">
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </RailBlock>
    </>
  );

  return (
    <div className="flex max-md:h-[calc(100dvh-var(--mobile-topbar-h)-var(--mobile-content-bottom)-36px)] max-md:min-h-[460px] md:h-[calc(100dvh-150px)] md:min-h-[520px] flex-col lg:flex-row lg:gap-5">
      {/* ===== Chat 主区（Trae SOLO 式左栏） ===== */}
      <section className="flex min-w-0 flex-1 flex-col">
      {/* 头部：标识 + 工作台(移动) + 新对话 + 清空 */}
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-lg bg-ink text-white">
            <Sparkles className="size-3.5" />
          </span>
          <p className="text-[13px] font-semibold text-ink">Mentora</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setWorkspaceOpen(true)}
            className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink lg:hidden"
          >
            <PanelsTopLeft className="size-3.5" /> 工作台
          </button>
          <button
            onClick={() => {
              if (busy) return;
              if (!activeSession || activeSession.messages.length > 0) newAgentSession();
            }}
            disabled={busy}
            className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink disabled:opacity-40"
            title="开始一段新对话"
          >
            <Plus className="size-3.5" /> 新对话
          </button>
          {shown.length > 0 && (
            <button onClick={clearAgentChat} className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink" title="清空这段对话">
              <Eraser className="size-3" /> 清空
            </button>
          )}
        </div>
      </div>
      {/* SOLO 式会话 tabs：横向切换，激活 tab 可删 */}
      {sessions.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto px-1 pb-2 [scrollbar-width:none]">
          {sessions.slice(0, 8).map((sess) => (
            <div
              key={sess.id}
              role="button"
              onClick={() => switchSession(sess.id)}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border px-2.5 py-1 text-[11.5px] transition",
                sess.id === activeId
                  ? "border-accent/40 bg-accent/[0.06] text-ink"
                  : "border-border bg-white text-ink-dim hover:text-ink"
              )}
            >
              <span className="max-w-[140px] truncate">{sess.title}</span>
              {sess.id === activeId && sessions.length > 1 && (
                <span
                  role="button"
                  aria-label="删除当前会话"
                  onClick={(e) => { e.stopPropagation(); removeAgentSession(sess.id); }}
                  className="opacity-40 transition hover:opacity-100"
                >
                  <X className="size-3" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

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
        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
          }}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-3">
          {(activeSession?.messages.length ?? 0) > shown.length && (
            <p className="text-center text-[11px] text-ink-dim/60">
              早期消息已折叠，仅显示最近 10 条（完整记录仍保存在会话里）
            </p>
          )}
          {shown.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[12.5px] text-white">
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
          {pending && runSessionId === activeId && (
            <div
              aria-live="polite"
              className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-border bg-white px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink"
            >
              {pending}
              <span className="stream-cursor" />
            </div>
          )}

          {/* 审批卡队列：写入操作等待用户逐个决定 */}
          {runSessionId === activeId && pendingActions.map((a) => {
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
                    className="cursor-pointer rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:bg-black/80"
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
          {(busy && runPhase !== "answering") && (
            <div className="flex items-center gap-2 text-[11.5px] text-ink-dim">
              <Loader2 className="size-3 animate-spin text-accent" />
              <span className="line-clamp-2 leading-4">
                {runPhase === "thinking"
                  ? "正在理解你的问题…"
                  : runPhase === "acting"
                    ? "正在调用工具…"
                    : "准备回答"}
              </span>
            </div>
          )}



          {runSessionId === activeId && <AgentTrace phases={phases} />}
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
          ref={inputRef}
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
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl bg-ink text-white transition hover:bg-black/80 disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
      {busy && runSessionId === activeId && (
        <button
          onClick={() => abortRef.current?.abort()}
          className="mt-2 cursor-pointer text-[11px] text-ink-dim hover:text-ink"
        >
          停止
        </button>
      )}
      {busy && runSessionId !== activeId && (
        <p className="mt-2 text-center text-[11px] text-ink-dim">
          上一段对话仍在后台生成中——切回「{sessions.find((x) => x.id === runSessionId)?.title ?? "原会话"}」查看或停止。
        </p>
      )}
      </section>

      {/* ===== 工作台（Trae SOLO 式右栏：任务 / 产物 / 会话） ===== */}
      <aside className="hidden w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/60 pl-4 lg:flex">
        {railBlocks}
      </aside>

      {/* 移动端工作台 slide-over */}
      {workspaceOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[2px] lg:hidden" onClick={() => setWorkspaceOpen(false)}>
          <aside className="flex h-full w-[320px] max-w-[85vw] flex-col gap-3 overflow-y-auto border-l border-border bg-white p-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="text-[12px] font-semibold text-ink">工作台</p>
              <button onClick={() => setWorkspaceOpen(false)} aria-label="关闭工作台" className="cursor-pointer rounded-lg p-1 text-ink-dim transition hover:bg-black/[0.04] hover:text-ink">
                <X className="size-4" />
              </button>
            </div>
            {railBlocks}
          </aside>
        </div>
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
