"use client";

/* 首页主对话框（v3，会话级运行态）
 *
 * 内核：runAgent 工具循环（原生 tool_calls + 围栏降级、审批门、打转守卫）。
 * UI：消息流（含过程产物 meta）+ 流式正文 + 审批卡队列 + 引用来源。
 *
 * v3 相对 v2 的改动（PRD CX-01/CX-02/UI-01/UI-02/UI-03）：
 *  - 运行态（busy/草稿/附件/滚动位/审批卡/流式正文）按会话归属，存进 session-runtime，
 *    组件只渲染「当前会话的运行视图」——两个会话可以真正同时在跑，切换不互相清空；
 *  - 输入框右侧同一按钮：空闲上箭头、运行中方形停止（不再把停止藏到输入框下方小字）；
 *  - 运行中草稿可继续编辑，Enter 不提交第二个任务；
 *  - 过程摘要用真实事件（工具/计划/结果）在消息内展示，可展开，不用固定思考标签；
 *  - 发送只回底当前会话，主动上翻即暂停跟随，切会话恢复各自的滚动位置。
 *
 * 页面关系：对话是主入口；学习/读书/圆桌/笔记库保留为工作台，Agent 的写入
 * 最终都落到这些工作台的数据里。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, Circle, Eraser, ImagePlus, Link2, Loader2, PanelsTopLeft, Plus, Sparkles, Square, X, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import { Modal } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { runAgent, stripMetaSentences, type PendingAction } from "@/lib/agent/runner";
import { TOOLS, WRITE_TOOL_NAMES, type ApprovalDecision, type PlanStep, type ToolCall } from "@/lib/agent/protocol";
import { buildAppContext } from "@/lib/agent/app-context";
import { extractFactsFromMessage, factsToContext, mergeFacts, type UserFact } from "@/lib/agent/user-facts";
import { checkOutputIntegrity, integrityNote } from "@/lib/agent/output-integrity";
import { filterCitationsForAnswer } from "@/lib/citation-match";
import { readImageDimensions } from "@/lib/image-dimensions";
import {
  beginRun,
  cancelRun,
  controllerOf,
  describeHeadline,
  isInFlight,
  markInterruptedOnLoad,
  recordApprovalDecision,
  registerApproval,
  releaseRun,
  resetRuntimeForAccount,
  STEP_SOURCE_LABEL,
  useRuntimeStore,
  type Attachment,
  type SessionRun,
  type StepSource,
} from "@/lib/agent/session-runtime";

/** 会话是否仍属于当前账户的 store：跨账户切换后，旧 sid 在新 store 里不存在，
 *  此时不许把旧回答经 appendAgentMsg 的兜底路径写成「幽灵会话」（P0-1/S07）。 */
function sessionExistsInStore(sessionId: string): boolean {
  return useAppStore.getState().agentSessions.some((x) => x.id === sessionId);
}
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import type { ChatMsg } from "@/lib/types";

/** SOLO 右栏的分块容器 */
function RailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-2.5">
      <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim">{title}</p>
      {children}
    </div>
  );
}

/** 任务块（E②）：默认简洁收起、可展开；执行中自动展开（busy 控制 open）。
 *  摘要行常显——收起时也能看到「进行到哪一步」。 */
function CollapsibleRailBlock({
  title,
  open,
  onToggle,
  summary,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-2.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim">
          {title}
          {summary ? <span className="ml-1.5 font-normal normal-case tracking-normal opacity-70">{summary}</span> : null}
        </span>
        <ChevronDown className={cn("size-3.5 shrink-0 text-ink-dim/60 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

const CHIPS = ["帮我安排今天的学习", "协程和线程到底差在哪？", "把「间隔重复的原理」整理成一篇笔记存起来"];

/* 图片压缩：模型对超大图会拒绝且浪费 token；长边压到 1400、JPEG 0.82 足够读代码截图。
 * 解码前防护（稳定性）：先按文件头读像素尺寸——超大像素图直接拒绝（此前全尺寸解码
 * 一张 2 亿像素全景图 ≈ 800MB 位图，移动端可能直接崩标签页，catch 接不住那种死法）；
 * 拿得到尺寸时把缩放传给 createImageBitmap 的 resize 选项，解码阶段就缩小。
 * 头解析不了（HEIC 等）退回原路径，由解码异常兜底。 */
const MAX_SOURCE_PIXELS = 50_000_000;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

async function compressImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error("图片文件过大（超过 50MB），无法读取");
  const maxSide = 1400;
  const dims = await readImageDimensions(file);
  if (dims && dims.width * dims.height > MAX_SOURCE_PIXELS) {
    throw new Error(`图片分辨率过大（${dims.width}×${dims.height}），无法读取`);
  }
  const scaled =
    dims && (dims.width > maxSide || dims.height > maxSide)
      ? (() => {
          const s = maxSide / Math.max(dims.width, dims.height);
          return { resizeWidth: Math.max(1, Math.round(dims.width * s)), resizeHeight: Math.max(1, Math.round(dims.height * s)) };
        })()
      : undefined;
  const bitmap = await createImageBitmap(file, scaled);
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

/* 上下文选择（CTX-01）：不再固定「最近 9 条」。
 * - 最近轮次保留原文，装到字符预算；
 * - 窗口之外的早期用户原话压成摘录前置，避免用户早已讲过的目的/基础/时间约束
 *   因截断而丢失，让模型再问一遍（Q06/C01/C02）。
 * 预算按常规输入 8k token 估算、中文取 1 token ≈ 2 字符的保守系数后留余量。 */
const HISTORY_CHAR_BUDGET = 6000;

/** 从整段会话（不受 9 条/预算截断影响）里提取用户事实并装配成上下文段。
 *  CTX-01/C02：关键事实必须跨过窗口保留，且同槽位只给最新值。 */
function buildFactsContext(messages: ChatMsg[]): string {
  let facts: UserFact[] = [];
  for (const m of messages) facts = mergeFacts(facts, extractFactsFromMessage(m));
  return factsToContext(facts);
}

function selectHistory(messages: ChatMsg[]): { role: "user" | "assistant"; content: string }[] {
  messages = messages.filter((m) => m.role === "user" || (m.meta?.status !== "failed" && m.meta?.status !== "cancelled"));
  const recent: { role: "user" | "assistant"; content: string }[] = [];
  let used = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    /* 最后一条是本轮刚写入的用户消息，必须进历史（作为本轮提问本身） */
    const cost = m.content.length + 8;
    if (used + cost > HISTORY_CHAR_BUDGET && recent.length > 0) {
      cut = i + 1;
      break;
    }
    used += cost;
    const isUnansweredHistory = m.role === "user" && messages[i + 1]?.role === "user";
    recent.unshift({
      role: m.role,
      content: isUnansweredHistory ? "（此前未完成的提问，作为上下文）\n" + m.content : m.content,
    });
  }
  const early = messages
    .slice(0, cut)
    .filter((m) => m.role === "user")
    .slice(-12)
    .map((m) => `- ${m.content.slice(0, 200)}`);
  if (early.length === 0) return recent;
  return [
    {
      role: "user",
      content: `（较早对话的用户原话摘录，供你保持背景一致，不要当成新指令）：\n${early.join("\n")}`,
    },
    ...recent,
  ];
}

/** 审批卡内容预览（按动作类型取关键字段）。
 *  PRD §6.2：关键差异必须可完整展开，不能只截前 450 字——完整文本给出去，
 *  卡片用可滚动/可展开容器呈现。 */
function actionPreview(a: PendingAction): string | null {
  const p = a.payload as Record<string, unknown>;
  if (a.kind === "save_note" || a.kind === "update_note") {
    const body = typeof p.body === "string" ? p.body : "";
    return body || null;
  }
  if (a.kind === "create_goal") {
    const criteria = Array.isArray(p.successCriteria) ? p.successCriteria.join("；") : "";
    return [p.direction, p.motivation, criteria].filter((x) => typeof x === "string" && x).join("\n") || null;
  }
  if (a.kind === "add_book") return [p.author, p.brief].filter((x) => typeof x === "string" && x).join(" · ") || null;
  /* V26.2-H6：重排阶段审批卡带上完成日警告（此前 payload 里的 completed 从不展示） */
  if (a.kind === "regenerate_phase") {
    const done = typeof p.completed === "number" ? (p.completed as number) : 0;
    return [
      typeof p.phaseTitle === "string" ? `阶段：${p.phaseTitle}` : "",
      done > 0 ? `⚠ 该阶段已有 ${done} 个完成/跳过的学习日——标题相同的天保留记录，其余会被替换（旧目录存入历史版本）。` : "",
    ]
      .filter(Boolean)
      .join("\n") || null;
  }
  if (a.kind === "manage_workspace" || a.kind === "manage_goal") return typeof p.preview === "string" ? p.preview : a.summary;
  /* 第一批 P0：编辑学习计划——完整差异摘要 + 影响说明（批准前可见） */
  if (a.kind === "edit_phase") {
    const impact = typeof p.impactText === "string" ? p.impactText : "";
    const done = typeof p.removedCompletedDays === "number" ? (p.removedCompletedDays as number) : 0;
    const warn = done > 0 ? `⚠ 删除的阶段含 ${done} 个已完成学习日——成绩与笔记会保留，但不再计入当前路线。` : "";
    return [impact, warn].filter(Boolean).join("\n") || null;
  }
  /* 第二批 C（AG-05）：阅读与笔记动作——展示变更摘要，批准前可见 */
  if (a.kind === "edit_book_goal" || a.kind === "set_reading_progress" || a.kind === "move_chapter" || a.kind === "save_reading_deposit" || a.kind === "link_notes" || a.kind === "review_queue" || a.kind === "record_book_assessment" || a.kind === "update_book" || a.kind === "remove_book" || a.kind === "rebuild_reading_route" || a.kind === "restore_book_route" || a.kind === "manage_session" || a.kind === "forge_persona" || a.kind === "create_session") {
    const preview = typeof p.preview === "string" ? p.preview : "";
    return preview || a.summary;
  }
  return null;
}

/** 可展开过程步骤：计划步骤 + 真实工具事件（对象/动作/结果/错误全在 detail 里） */
function runSteps(run: SessionRun): { key: string; kind: "plan" | "tool"; label: string; status: string; detail?: string; ms?: number; source: StepSource }[] {
  const out: { key: string; kind: "plan" | "tool"; label: string; status: string; detail?: string; ms?: number; source: StepSource }[] = [];
  for (const st of run.plan) {
    out.push({ key: `p-${st.id}`, kind: "plan", label: st.text, status: st.status, source: "plan" });
  }
  for (const t of run.tools) {
    out.push({
      key: `t-${t.id}`,
      kind: "tool",
      label: TOOLS[t.name]?.label ?? t.name,
      status: t.status,
      detail: t.summary,
      ms: t.endedAt ? t.endedAt - t.startedAt : undefined,
      source: t.status === "completed" ? "result_summary" : "tool_event",
    });
  }
  return out;
}

function StepIcon({ status }: { status: string }) {
  if (status === "in_progress") return <Loader2 className="size-3 shrink-0 animate-spin text-accent" />;
  if (status === "completed") return <Check className="size-3 shrink-0 text-ok" />;
  if (status === "failed" || status === "declined") return <X className="size-3 shrink-0 text-bad" />;
  if (status === "cancelled") return <Circle className="size-3 shrink-0 text-ink-dim/50" />;
  return <Circle className="size-3 shrink-0 text-ink-dim/30" />;
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
  const accountId = useAppStore((s) => s._storeUserId);
  /* 当前会话重试可用的原图（内存暂存，见 session-runtime 的 stashedAttachments）：
   * 纯图片问题只有在它还在时才可「继续回答」，刷新丢失后 UI 如实提示 */
  const stashedAttach = useRuntimeStore((s) => (activeId ? s.stashedAttachments[activeId] ?? null : null));
  const lastMessage = activeSession?.messages.at(-1);
  /* 未收到回答的上一问：文本问题总能重发；纯图片问题只有在内存里还留着原图
   * （stashedAttachments，未刷新页面）时才可重发——与失败消息上的重试按钮同口径 */
  const unanswered =
    lastMessage?.role === "user" && (lastMessage.content !== "（图片）" || !!stashedAttach) ? lastMessage : null;

  /* ---- 运行态：全部按会话隔离，来自运行管理器（T1） ---- */
  const run = useRuntimeStore((s) => {
    const candidate = activeId ? s.views[activeId]?.run : null;
    return candidate?.sessionId === activeId ? candidate : null;
  });
  const notice = useRuntimeStore((s) => (activeId ? s.views[activeId]?.notice ?? null : null));
  const input = useRuntimeStore((s) => (activeId ? s.drafts[activeId] ?? "" : ""));
  const attach = useRuntimeStore((s) => (activeId ? s.attachments[activeId] ?? null : null));
  const followingLatest = useRuntimeStore((s) => (activeId ? s.following[activeId] ?? true : true));
  const runningIdsKey = useRuntimeStore((s) =>
    Object.keys(s.views)
      .filter((k) => {
        const r = s.views[k]?.run;
        return !!r && isInFlight(r.status);
      })
      .join(",")
  );
  const runningIds = useMemo(() => new Set(runningIdsKey ? runningIdsKey.split(",") : []), [runningIdsKey]);

  /* 本会话是否有在途任务：输入框只受**本会话**状态约束，不再全局禁用 */
  const busy = !!run && isInFlight(run.status);
  const runSessionId = run?.sessionId ?? null;
  const pending = run && (isInFlight(run.status) || run.status === "cancelling") ? run.partialAnswer : "";
  const plan = run?.plan ?? [];
  const tools = run?.tools ?? [];
  const pendingActions = run?.pendingActions ?? [];

  /* 失败终态消息的「继续回答」重试数据：在渲染体里做纯读取（纯 store/暂存判断），
   * JSX 里只做条件渲染——不把判断写成渲染期执行的 IIFE（react-hooks/refs 会把
   * 渲染期执行的闭包当渲染路径分析）。image-lost = 纯图片提问且原图暂存已随刷新
   * 丢失（渲染提示文案而不是一个点了没反应的按钮）。 */
  const failedRetry = (() => {
    const tail = activeSession?.messages.at(-1);
    if (!tail || tail.meta?.status !== "failed" || tail.meta.tools?.length || busy) return null;
    const last = activeSession ? [...activeSession.messages].reverse().find((item) => item.role === "user") : null;
    if (!last) return null;
    if (last.content === "（图片）") return stashedAttach ? { kind: "retry" as const, content: last.content } : { kind: "image-lost" as const };
    return { kind: "retry" as const, content: last.content };
  })();

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [historyLimits, setHistoryLimits] = useState<Record<string, number>>({});
  const historyLimit = activeId ? historyLimits[activeId] ?? 10 : 10;
  const historyScroll = useRef<{ sessionId: string; height: number; top: number } | null>(null);

  const setDraft = useCallback((text: string) => {
    const sid = useAppStore.getState().agentActiveId;
    if (sid) useRuntimeStore.getState().setDraft(sid, text);
  }, []);
  const setAttach = useCallback((a: Attachment | null) => {
    const sid = useAppStore.getState().agentActiveId;
    if (sid) useRuntimeStore.getState().setAttachment(sid, a);
  }, []);


  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastTop = useRef(0);
  const programmatic = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Resize on restored drafts as well as typing; long pastes scroll inside the composer.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 160)}px`;
  }, [input]);

  /* 没有当前会话时先建一个：草稿、附件、运行态都挂在会话上，
   * 否则用户还没发过消息就打字会「没有归属」（v2 把草稿放在组件里，所以没这个问题；
   * 改成按会话存以后必须保证总有一个当前会话）。 */
  useEffect(() => {
    if (!useAppStore.getState().agentActiveId) useAppStore.getState().newAgentSession();
  }, [activeId]);

  /* 刷新后：把「上次还在跑但进程已没了」的会话标成 interrupted（不重放、不伪造完成） */
  useEffect(() => {
    resetRuntimeForAccount(accountId);
    for (const sid of markInterruptedOnLoad()) {
      useRuntimeStore.getState().setNotice(sid, "上次的生成在刷新时中断了，可以直接重新发送这个问题。");
    }
  }, [accountId]);

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
      } catch (e) {
        /* 解码前的尺寸/体积拒绝带具体原因（分辨率过大等），如实展示而不是一律「读取失败」 */
        toast.error(e instanceof Error && e.message ? e.message : "图片读取失败");
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [setAttach]);

  /* ---- 滚动（UI-03）：只操纵消息容器；按会话保存跟随状态与位置 ----
   * 程序滚动的防误判标记：scroll 事件按规范在渲染步异步派发，必然晚于本同步体——
   * 若赋值后立刻复位标志，onMessagesScroll 的豁免守卫读到的永远是 false（旧实现
   * 守卫从未生效）。现在标志保持到下一次滚动事件由处理器消费；位置本就没变、
   * 不会触发 scroll 时，由 rAF 兜底复位，不会吞掉下一次用户滚动。 */
  const programmaticScrollTo = (el: HTMLDivElement, top: number) => {
    programmatic.current = true;
    el.scrollTop = top;
    lastTop.current = el.scrollTop;
    requestAnimationFrame(() => {
      programmatic.current = false;
    });
  };
  const scrollToBottom = useCallback((sid: string | null) => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      programmatic.current = true;
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
      requestAnimationFrame(() => {
        programmatic.current = false;
      });
      if (sid) useRuntimeStore.getState().setScrollTop(sid, el.scrollTop);
    });
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const st = useRuntimeStore.getState();
    const saved = st.scrollTops[activeId];
    programmaticScrollTo(el, saved ?? el.scrollHeight);
    if (saved == null) {
      st.setFollowing(activeId, true);
    } else {
      st.setFollowing(activeId, el.scrollHeight - saved - el.clientHeight < 90);
    }
  }, [activeId]);

  useLayoutEffect(() => {
    const anchor = historyScroll.current;
    const el = scrollRef.current;
    if (!anchor || !el || activeId !== anchor.sessionId) return;
    historyScroll.current = null;
    programmaticScrollTo(el, Math.max(0, anchor.top + el.scrollHeight - anchor.height));
    useRuntimeStore.getState().setScrollTop(activeId, el.scrollTop);
  }, [activeId, historyLimit]);

  const loadOlderMessages = () => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    historyScroll.current = { sessionId: activeId, height: el.scrollHeight, top: el.scrollTop };
    useRuntimeStore.getState().setFollowing(activeId, false);
    setHistoryLimits((limits) => ({ ...limits, [activeId]: historyLimit + 20 }));
  };

  const contentKey = `${activeSession?.messages.length ?? 0}:${pending.length}:${pendingActions.length}`;
  useEffect(() => {
    if (!activeId) return;
    if (!useRuntimeStore.getState().following[activeId]) return; // 用户在看历史：不抢回底
    scrollToBottom(activeId);
  }, [contentKey, activeId, scrollToBottom]);

  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const st = useRuntimeStore.getState();
    const top = el.scrollTop;
    const prev = lastTop.current;
    lastTop.current = top;
    st.setScrollTop(activeId, top);
    if (programmatic.current) {
      programmatic.current = false; // 消费一次：程序滚动引发的 scroll 事件不算用户操作
      return;
    }
    const nearBottom = el.scrollHeight - top - el.clientHeight < 90;
    if (nearBottom) {
      if (!(st.following[activeId] ?? true)) st.setFollowing(activeId, true);
      return;
    }
    /* 只有「主动向上滚动」（scrollTop 变小）才退出跟随：内容变高（展开过程、
     * 图片/表格撑开）时 scrollTop 不变，不误判为用户要求回底或想离开底部。 */
    if (top < prev - 8 && (st.following[activeId] ?? true)) st.setFollowing(activeId, false);
  };

  /** 审批门：写入动作挂起，等用户逐卡决定。决定累积在运行管理器**按会话隔离的门**里
   *  （P1-1：不再用组件级 ref，避免两会话开门互相清掉对方的已批决定）；
   *  「停止」走运行管理器统一逐卡拒绝。
   *  停止与开门的竞态：cancelRun 已经跑过（controller 已注销、状态进入 cancelling）
   *  就不再把状态翻回 awaiting_approval、不再注册无人收口的门——否则审批卡在用户
   *  点停止后仍会弹出，任务悬挂在 awaiting_approval 直到用户再次操作。检查与注册
   *  在同一同步块里，单线程 JS 下不存在第三种交错：cancelRun 要么完全在此之前
   *  （此处拦下并按「全部拒绝」收口），要么完全在此之后（cancelRun 会清掉这扇门）。 */
  const requestApproval = (sid: string, actions: PendingAction[]): Promise<ApprovalDecision[]> =>
    new Promise((resolve) => {
      const finish = (d: ApprovalDecision[]) => {
        const cur = useRuntimeStore.getState().views[sid]?.run;
        if (cur) {
          useRuntimeStore.getState().patchRun(
            sid,
            cur.runId,
            { pendingActions: [], status: cur.status === "awaiting_approval" ? "executing_tool" : cur.status }
          );
        }
        resolve(d);
      };
      const st = useRuntimeStore.getState();
      const cur = st.views[sid]?.run;
      const cancelled = !controllerOf(sid) || !cur || cur.status === "cancelling" || !isInFlight(cur.status);
      if (cancelled) {
        resolve(actions.map((a) => ({ actionId: a.id, approved: false })));
        return;
      }
      st.patchRun(
        sid,
        cur.runId,
        { pendingActions: actions, status: "awaiting_approval", headline: `等待你确认：${actions[0]?.label ?? "操作"}` }
      );
      registerApproval(sid, actions, finish);
    });

  const decide = (actionId: string, approved: boolean) => {
    const sid = activeId;
    if (!sid) return;
    const st = useRuntimeStore.getState();
    const cur = st.views[sid]?.run;
    if (!cur) return;
    const rest = cur.pendingActions.filter((a) => a.id !== actionId);
    st.patchRun(sid, cur.runId, { pendingActions: rest });
    /* 决定立刻记进门（即使还有别的卡没收口）：跨会话也不会丢 */
    recordApprovalDecision(sid, actionId, approved);
  };

  /* eslint-disable react-hooks/purity */
  const send = async (preset?: string, targetSessionId?: string, reuseQuestion = false) => {
    /* 发起对象在点击时定格：回调与回写全程用这个 sid，绝不用「回调时的 activeId」 */
    const sid = targetSessionId ?? useAppStore.getState().agentActiveId ?? newAgentSession();
    const st0 = useRuntimeStore.getState();
    const q = (preset ?? st0.drafts[sid] ?? "").trim();
    /* 重试（reuseQuestion）时从内存暂存里找回原图：附件在首次发送受理后已被清空，
     * ChatMsg 不存图片，不暂存的话「继续回答」会静默变成一次无图重试 */
    const att = reuseQuestion ? st0.stashedAttachments[sid] ?? null : st0.attachments[sid] ?? null;
    /* 同会话一次只允许一个任务；同会话双击/连按 Enter 只接受一次 */
    if ((!q && !att) || isRunningSession(sid)) return;
    if (!preset) st0.setDraft(sid, ""); // 只有内容来自输入框时才清空草稿
    if (!reuseQuestion) {
      st0.setAttachment(sid, null);
      /* 给「继续回答」留一份原图（内存，不落盘）；本条没带图就清掉，防止重试串到旧图 */
      st0.setStashedAttachment(sid, att);
    }
    /* 发送强制回到最新：清掉旧的「上翻暂停」意图（发送后的下一帧滚到底） */
    st0.setFollowing(sid, true);

    const runId = uid("run");
    const t0 = Date.now();
    const ac = beginRun(sid, runId);
    const patch = (p: Partial<SessionRun>) => useRuntimeStore.getState().patchRun(sid, runId, p);
    /* 流式增量批处理（F10）：client.ts 按 SSE 事件逐条触发 onDelta，旧实现每条都对
     * 整个已累计正文做拼接 + 两个全文正则 + stripMetaSentences 全文重处理，再触发
     * LiveRun 的全文 Markdown 重解析——长回答（30-40KB + 数千条 delta）累计 O(n²)，
     * 主线程被占满、正文追赶不上流。这里把 delta 攒进缓冲，80ms 时间窗合并后再
     * strip+patch；收尾/异常路径先冲刷缓冲，保证终态消息拿到完整正文。 */
    let deltaBuf = "";
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    const flushDelta = () => {
      if (deltaTimer != null) {
        clearTimeout(deltaTimer);
        deltaTimer = null;
      }
      if (!deltaBuf) return;
      const chunk = deltaBuf;
      deltaBuf = "";
      const cur = useRuntimeStore.getState().views[sid]?.run;
      const merged = (cur?.partialAnswer ?? "") + chunk;
      const noFence = merged
        .replace(/```(?:tool|plan)[\s\S]*?```/g, "")
        .replace(/```(?:tool|plan)[\s\S]*$/, "");
      patch({ partialAnswer: stripMetaSentences(noFence), firstDeltaAt: cur?.firstDeltaAt ?? Date.now() });
    };
    useRuntimeStore.getState().startRun(sid, {
      runId,
      sessionId: sid,
      seq: 1,
      status: "preparing",
      phase: "thinking",
      startedAt: t0,
      headline: "正在等待模型响应",
      plan: [],
      tools: [],
      phases: [],
      partialAnswer: "",
      pendingActions: [],
    });

    const userMsg: ChatMsg = { id: uid("m"), role: "user", content: q || "（图片）", at: new Date().toISOString() };
    if (!reuseQuestion) appendAgentMsg(userMsg, sid);
    scrollToBottom(sid);

    try {
      /* 历史上下文：本会话（按预算选择，不再固定最近 9 条） */
      const stAfter = useAppStore.getState();
      const activeNow = stAfter.agentSessions.find((x) => x.id === sid);
      const history = selectHistory(activeNow?.messages ?? []);

      const { wantsDeepExplanation } = await import("@/lib/ai/prompts-lite");
      const deep = wantsDeepExplanation(q, !!att);

      const factsCtx = buildFactsContext(activeNow?.messages ?? []);
      const { answer, meta } = await runAgent({
        /* 纯图片重试时 q 是占位符「（图片）」，带着暂存的原图走同一句兜底提问 */
        question: !q || (q === "（图片）" && !!att) ? "请讲讲这张图里的内容。" : q,
        context: () => [buildAppContext(q), factsCtx].filter(Boolean).join("\n\n"),
        imageUrl: att?.dataUrl ?? null,
        history,
        deep,
        signal: ac.signal,
        cb: {
          /* 账本归属：发起时定格（绝不取回调时的当前会话） */
          identity: { userId: useAppStore.getState()._storeUserId ?? null, sessionId: sid, runId },
          onPhase: (ph) => {
            const cur = useRuntimeStore.getState().views[sid]?.run;
            const phase = ph === "thinking" ? "thinking" : ph === "acting" ? "acting" : "answering";
            /* 状态机流转（PRD §4.2）：preparing → generating ↔ executing_tool；
             * 此前 status 一直停在 preparing，data-run-status 与状态机不符（P2-8）。 */
            const status: SessionRun["status"] =
              ph === "acting" ? "executing_tool" : "generating";
            patch({
              phase,
              /* 已在「正在停止…」（用户点了停止）就不把状态翻回 generating——
               * 停止反馈不被冲掉，审批门的取消检查也多一道依据 */
              status: cur?.status === "cancelling" ? cur.status : status,
              /* 取消标记按会话隔离（P1-3：组件级 ref 会被另一个会话的收尾读走） */
              cancelled: ph === "cancelled" ? true : cur?.cancelled,
              firstDeltaAt: cur?.firstDeltaAt ?? (ph === "answering" ? Date.now() : cur?.firstDeltaAt),
            });
          },
          onPlan: (pl: PlanStep[]) => patch({ plan: pl }),
          onTool: (tc: ToolCall) => {
            const cur = useRuntimeStore.getState().views[sid]?.run;
            const idx = cur?.tools.findIndex((x) => x.id === tc.id) ?? -1;
            const tools = cur ? [...cur.tools] : [];
            if (idx < 0) tools.push(tc);
            else tools[idx] = tc;
            patch({ tools, firstToolAt: cur?.firstToolAt ?? Date.now() });
          },
          onReasoning: () => {}, // v26.1：不展示原始推理文本；摘要是真实事件，不额外调模型编造
          onResetDelta: () => {
            /* 重置流式正文（写入工具执行后重开一段）：缓冲里的旧片段一并丢弃，
             * 否则待冲刷的旧文本会在下一窗被拼回新段开头 */
            deltaBuf = "";
            if (deltaTimer != null) {
              clearTimeout(deltaTimer);
              deltaTimer = null;
            }
            patch({ partialAnswer: "" });
          },
          onDelta: (d) => {
            /* 流式期间剥掉 tool/plan 指令块 + 私语句（V26.2-H3）：用户不该看到
             * JSON 协议或内部独白——剥离在 flushDelta 里对合并后的文本统一做。 */
            deltaBuf += d;
            if (deltaTimer == null) deltaTimer = setTimeout(flushDelta, 80);
          },
          requestApproval: (actions) => requestApproval(sid, actions),
        },
      });

      /* 取消走的是正常 resolve：按 runner 报告的终态收尾，不能把「回答中」伪装成 done 绿勾。
       * 取消标记读按会话隔离的 run.cancelled（P1-3），ac.signal 是本 run 闭包里的，安全。 */
      flushDelta(); // 收尾前冲刷：缓冲里可能还有没落进 partialAnswer 的尾段
      const runAtEnd = useRuntimeStore.getState().views[sid]?.run;
      const cancelled = !!runAtEnd?.cancelled || ac.signal.aborted;
      const finishedAt = Date.now();
      const partial = meta.tools.length > 0 && !answer.trim();
      const status: SessionRun["status"] = cancelled ? "cancelled" : partial ? "partial" : "completed";
      patch({ status, finishedAt, finalAnswer: answer });

      const head = useRuntimeStore.getState().views[sid]?.run;
      /* 输出完整性（第二轮复核 Q03）：不修补内容，只如实标注可疑残片 */
      const integrity = checkOutputIntegrity(answer);
      /* P0-1：账户切换/会话被删后，旧 sid 在当前 store 里已不存在——
       * 此时绝不落消息（store 兜底会凭空建「新对话」把旧用户内容写进新账户）。 */
      if (!sessionExistsInStore(sid)) {
        releaseRun(sid);
        useRuntimeStore.getState().dropSession(sid);
        return;
      }
      if (answer.trim() || meta.tools.length > 0 || meta.citations.length > 0) {
        appendAgentMsg(
          {
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
              citations: (() => {
                const matched = filterCitationsForAnswer(meta.citations, answer).slice(0, 8);
                return matched.length ? matched : undefined;
              })(),
              status,
              headline: head ? describeHeadline({ ...head, status, finishedAt }) : undefined,
              durationMs: finishedAt - t0,
              integrity: integrity.ok ? "ok" : "suspect",
              integrityNote: integrityNote(integrity) ?? undefined,
            },
          },
          sid
        );
      } else if (cancelled) {
        /* 用户主动停止：没有正文是预期结果，不能伪装成「上游返回为空」的失败。 */
        appendAgentMsg(
          {
            id: uid("m"),
            role: "assistant",
            content: "（已按你的操作停止本轮回答。）",
            at: new Date().toISOString(),
            meta: { status: "cancelled", headline: "已停止", durationMs: finishedAt - t0 },
          },
          sid
        );
      } else {
        /* P2-4：空回答且无工具/引用时不再无声吞掉——用户的问题悬空没有任何反馈。
         * 如实落一条「上游空返回」，标 failed，不伪造成功。 */
        appendAgentMsg(
          {
            id: uid("m"),
            role: "assistant",
            content: "（这一轮没有生成任何回答，上游返回了空内容——请重发一次。）",
            at: new Date().toISOString(),
            meta: { status: "failed", headline: "上游返回为空", durationMs: finishedAt - t0 },
          },
          sid
        );
      }
      /* 终态消息已落库：只清运行快照（保留该会话的草稿/滚动位/跟随状态——
       * dropSession 会连 UX 状态一起清掉，「回到最新」按钮会凭空消失）。
       * 避免同一条回答渲染两次。 */
      releaseRun(sid);
      useRuntimeStore.getState().clearRun(sid);
    } catch (e) {
      /* 用户主动「停止」= cancelled，不是失败：不伪装成红色失败 */
      flushDelta(); // 异常路径先冲刷缓冲：下面按 partialAnswer 保留半截回答，不能丢尾段
      const aborted = e instanceof DOMException && e.name === "AbortError";
      const finishedAt = Date.now();
      const detail = e instanceof Error ? e.message : "";
      const disconnected = e instanceof TypeError || /failed to fetch|networkerror|network error|load failed|连接中断/i.test(detail);
      const message = disconnected ? "连接中断，暂时没有收到完整回复。" : detail || "回答失败，请重试。";
      patch({ status: aborted ? "cancelled" : "failed", finishedAt, error: aborted ? null : message });
      const cur = useRuntimeStore.getState().views[sid]?.run;
      /* 与成功分支同一道边界（独立复核 2026-11-12 §3）：异常路径此前只凭 runtime 里还有
       * cur 就 append，账户已切换时同样会写出幽灵会话。会话不属于本账户就什么都不写。 */
      if (!sessionExistsInStore(sid)) {
        releaseRun(sid);
        useRuntimeStore.getState().dropSession(sid);
        return;
      }
      if (cur && (cur.partialAnswer.trim() || cur.tools.length > 0)) {
        /* 已接受的内容保留成一条消息（不丢半截回答），并如实标终态 */
        appendAgentMsg(
          {
            id: uid("m"),
            role: "assistant",
            content: cur.partialAnswer,
            at: new Date().toISOString(),
            meta: {
              tools: cur.tools.length
                ? cur.tools.map((t) => ({
                    id: t.id,
                    name: t.name,
                    status: t.status,
                    summary: t.summary,
                    durationMs: t.endedAt ? t.endedAt - t.startedAt : undefined,
                  }))
                : undefined,
              status: aborted ? "cancelled" : "failed",
              headline: aborted ? "已停止" : `任务失败：${message}`,
              durationMs: finishedAt - t0,
            },
          },
          sid
        );
      }
      if (!aborted && !(cur && (cur.partialAnswer.trim() || cur.tools.length > 0))) {
        appendAgentMsg({id:uid("m"),role:"assistant",content:message,at:new Date().toISOString(),meta:{status:"failed",headline:"回答未完成",durationMs:finishedAt-t0}},sid);
      }
      if (!aborted) toast.error(message);
      releaseRun(sid);
      useRuntimeStore.getState().clearRun(sid);
    }
  };
  /* eslint-enable react-hooks/purity */

  /* 停止：立刻进 cancelling（UI 有反馈），再取消底层请求 */
  const stop = () => {
    const sid = useAppStore.getState().agentActiveId;
    if (sid) cancelRun(sid, "user");
  };

  const shown = (activeSession?.messages ?? []).slice(-historyLimit);
  const switchSession = (id: string) => {
    setAgentActive(id);
    /* 运行态按会话保存，切会话只是换视图：本轮还在跑的会话继续在后台跑，
     * 各自的草稿、附件、审批卡、滚动位置都不受影响（CX-01）。 */
  };
  /* 删除会话（轨道 hover 垃圾桶 / 会话 tab 的 X 共用）：
   *  1) 先确认——这里删的是整段对话的全部消息，与删单篇笔记的 confirm 一致，
   *     且 tab 上的 X 紧贴激活 tab 主体，误触即永久丢失（store 无回收站）；
   *  2) 生成中的会话不可删——删掉后 appendAgentMsg(assistantMsg, runSid) 找不到
   *     该会话，store 兜底会凭空新建一个只装回答的「新对话」幽灵会话。 */
  const requestRemoveSession = (sess: { id: string; title: string }) => {
    if (runningIds.has(sess.id)) {
      toast.error("这段对话正在生成中，先「停止」再删除");
      return;
    }
    if (!confirm(`删除对话「${sess.title || "新对话"}」？其中的全部消息将永久删除，此操作不可撤销。`)) return;
    cancelRun(sess.id, "switch");
    useRuntimeStore.getState().setStashedAttachment(sess.id, null); // 重试暂存的原图一并清掉，防泄漏
    useRuntimeStore.getState().dropSession(sess.id);
    removeAgentSession(sess.id);
    setHistoryLimits((limits) => {
      const next = { ...limits };
      delete next[sess.id];
      return next;
    });
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
      <CollapsibleRailBlock
        title="任务"
        open={tasksOpen || busy}
        onToggle={() => setTasksOpen((v) => !v)}
        summary={
          busy
            ? "执行中"
            : plan.length + tools.length > 0
              ? `${tools.filter((t) => t.status === "failed").length > 0 ? `${tools.filter((t) => t.status === "failed").length} 失败 · ` : ""}${plan.length + tools.length} 步`
              : undefined
        }
      >
        {plan.length > 0 || tools.length > 0 ? (
          <>
            {runSessionId === activeId && plan.length > 0 && (
              <ol className="space-y-1">
                {plan.map((st) => (
                  <li key={st.id} className="flex items-start gap-1.5 text-[11.5px]">
                    <span className="mt-[3px] shrink-0">
                      <StepIcon status={st.status} />
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
                    <StepIcon status={t.status} />
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
      </CollapsibleRailBlock>
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
                  <p className="flex items-center gap-1 truncate text-[12px] text-ink">
                    {runningIds.has(sess.id) && <Loader2 className="size-3 shrink-0 animate-spin text-accent" aria-label="正在生成" />}
                    {sess.title}
                  </p>
                  <p className="text-[10px] text-ink-dim/70">{sess.messages.length} 条 · {new Date(sess.updatedAt).toLocaleDateString("zh-CN")}</p>
                </button>
                <button onClick={() => requestRemoveSession(sess)} aria-label="删除这段对话" className="cursor-pointer rounded-md p-1 text-ink-dim/50 opacity-0 transition hover:bg-bad/10 hover:text-bad focus-visible:opacity-100 group-hover:opacity-100 max-lg:opacity-100">
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </RailBlock>
    </>
  );

  const canSend = !!input.trim() || !!attach;

  return (
    <div className="agent-workspace flex min-w-0 flex-col xl:flex-row xl:gap-6">
      {/* ===== Chat 主区（Trae SOLO 式左栏） ===== */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 头部：标识 + 工作台(移动) + 新对话 + 清空 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 pb-3">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-lg bg-ink text-white">
            <Sparkles className="size-3.5" />
          </span>
          <p className="text-[13px] font-semibold text-ink">Mentora</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setWorkspaceOpen(true)}
            className="flex min-h-9 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-xs text-ink-dim transition hover:bg-black/[0.04] hover:text-ink xl:hidden"
          >
            <PanelsTopLeft className="size-3.5" /> 工作台
          </button>
          <button
            onClick={() => {
              if (!activeSession || activeSession.messages.length > 0) newAgentSession();
            }}
            className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink disabled:opacity-40"
            title="开始一段新对话"
            data-guide="new-chat"
          >
            <Plus className="size-3.5" /> 新对话
          </button>
          {shown.length > 0 && (
            <button
              onClick={() => { if (!busy) clearAgentChat(); }}
              disabled={busy}
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              title={busy ? "生成中：先「停止」再清空" : "清空这段对话"}
            >
              <Eraser className="size-3" /> 清空
            </button>
          )}
        </div>
      </div>
      {/* SOLO 式会话 tabs：横向切换，激活 tab 可删 */}
      {sessions.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-1 pb-3 [scrollbar-width:none]">
          {sessions.slice(0, 8).map((sess) => (
            <div
              key={sess.id}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-[11.5px] transition",
                sess.id === activeId
                  ? "border-accent/40 bg-accent/[0.06] text-ink"
                  : "border-border bg-white text-ink-dim hover:text-ink"
              )}
            >
              {/* 真按钮而非 div[role=button]：键盘可聚焦、Enter/Space 可切换，
                  aria-current 标出当前会话 */}
              <button
                type="button"
                onClick={() => switchSession(sess.id)}
                aria-current={sess.id === activeId ? "true" : undefined}
                className="flex max-w-[140px] cursor-pointer items-center gap-1 truncate text-left"
              >
                {runningIds.has(sess.id) && <Loader2 className="size-3 shrink-0 animate-spin text-accent" aria-label="正在生成" />}
                {sess.title}
              </button>
              {sess.id === activeId && sessions.length > 1 && (
                <button
                  type="button"
                  aria-label="删除当前会话"
                  title="删除这段对话"
                  onClick={() => requestRemoveSession(sess)}
                  className="cursor-pointer opacity-40 transition hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {shown.length === 0 && !run && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-2 py-4 text-center sm:px-6">
          <p className="text-xs font-medium tracking-widest text-accent">一起，把想法变成进展</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">今天，想学点什么？</h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-dim">
            从一个问题、一段阅读，或一个想完成的目标开始。
          </p>
          <div className="mt-6 grid w-full max-w-lg gap-2 text-left">
            {CHIPS.map((c) => (
              <button
                key={c}
                onClick={() => void send(c)}
                className="cursor-pointer rounded-xl border border-border bg-white px-4 py-3 text-left text-sm text-ink-dim transition hover:border-accent/40 hover:bg-accent/[0.03] hover:text-ink"
              >
                {c}
              </button>
            ))}
            <button
              onClick={() => fileRef.current?.click()}
              className="cursor-pointer rounded-xl px-4 py-2 text-center text-xs text-accent transition hover:bg-accent/[0.06]"
            >
              📎 传张截图 / 代码图
            </button>
          </div>
        </div>
      )}

      {(shown.length > 0 || !!run) && (
        <div
          ref={scrollRef}
          onScroll={onMessagesScroll}
          role="log"
          aria-label="对话消息"
          className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-3 [overflow-anchor:none]">
          {(activeSession?.messages.length ?? 0) > shown.length && (
            <div className="flex justify-center">
              <button type="button" onClick={loadOlderMessages} className="cursor-pointer rounded-lg px-3 py-2 text-xs font-medium text-accent hover:bg-accent/5">
                查看更早的消息
              </button>
            </div>
          )}
          {shown.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-4 py-3 text-sm leading-relaxed text-white [overflow-wrap:anywhere] sm:max-w-[85%]">
                  {m.content}
                </div>
              ) : (
                <div className="min-w-0 max-w-full rounded-2xl rounded-bl-md border border-border bg-white px-4 py-3 sm:max-w-[92%] sm:px-5 sm:py-4">
                  <Markdown text={m.content} className="prose-reading" />
                  <MsgMetaView meta={m.meta} answer={m.content} />
                  {failedRetry && (
                    failedRetry.kind === "image-lost" ? (
                      <p className="mt-2 text-xs text-ink-dim">原图没有随会话保存，重新粘贴截图后再问一次吧。</p>
                    ) : (
                      <button
                        type="button"
                        className="mt-2 cursor-pointer text-xs font-semibold text-accent hover:underline"
                        onClick={() => void send(failedRetry.content, activeSession?.id, true)}
                      >
                        继续回答
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          ))}

          {/* 在途/中断回答：过程摘要行 → 可展开步骤 → 正文 → 待确认动作（同一条消息区） */}
          {run && (
            <LiveRun
              key={`${run.sessionId}:${run.runId}`}
              run={run}
              notice={notice}
              onDecide={decide}
              onResume={unanswered ? () => void send(unanswered.content, run.sessionId, true) : undefined}
            />
          )}

          {!run && unanswered && activeId && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-dim">
              <span>上一条问题还没收到回复。</span>
              <button type="button" className="cursor-pointer rounded-lg border border-border px-3 py-2 font-medium text-accent hover:bg-accent/5" onClick={() => void send(unanswered.content, activeId, true)}>
                继续回答
              </button>
            </div>
          )}

          {!followingLatest && (
            <div className="sticky bottom-2 flex justify-center">
              <button
                onClick={() => {
                  if (activeId) useRuntimeStore.getState().setFollowing(activeId, true);
                  scrollToBottom(activeId);
                }}
                className="cursor-pointer rounded-full border border-border bg-white/95 px-3 py-1.5 text-[11.5px] text-ink-dim shadow-sm backdrop-blur transition hover:text-ink"
              >
                ↓ 回到最新
              </button>
            </div>
          )}
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

      <div className="mt-auto flex shrink-0 items-end gap-2 border-t border-border/60 pt-3">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              void compressImage(f)
                .then((img) => setAttach({ ...img, name: f.name }))
                .catch((err) => toast.error(err instanceof Error && err.message ? err.message : "图片读取失败"));
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="上传图片（也可以直接 Ctrl+V 粘贴截图）"
          aria-label="上传图片"
          className="grid size-12 shrink-0 cursor-pointer place-items-center rounded-xl border border-border bg-white text-ink-dim transition hover:border-accent/40 hover:text-ink"
        >
          <ImagePlus className="size-4" />
        </button>
        <textarea
          ref={inputRef}
          aria-label="给智能体发消息"
          data-guide="composer"
          aria-describedby="agent-composer-hint"
          rows={1}
          value={input}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            /* 中文输入法组合过程中的 Enter 是选词，不是发送 */
            if (e.key !== "Enter" || e.nativeEvent.isComposing || e.shiftKey) return;
            e.preventDefault();
            /* 运行中 Enter 不提交第二个任务，也不代替停止；草稿留在输入框里 */
            if (busy) return;
            void send();
          }}
          placeholder={busy ? "运行中可以继续写下一句草稿…" : "说说你的问题，或想完成的事…"}
          className="max-h-40 min-h-12 min-w-0 flex-1 resize-none overflow-y-auto rounded-xl border border-border bg-white px-3.5 py-3 text-base leading-6 outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12] sm:text-sm"
        />
        {/* 同位发送/停止（UI-01）：空闲=上箭头，运行中=方形停止；44×44 点击区、键盘可激活 */}
        <button
          onClick={() => (busy ? stop() : void send())}
          disabled={!busy && !canSend}
          aria-label={busy ? "停止当前回答" : "发送消息"}
          title={busy ? "停止当前回答" : "发送消息"}
          className={cn(
            "grid size-12 shrink-0 cursor-pointer place-items-center rounded-xl transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            busy ? "bg-white text-ink ring-1 ring-border hover:bg-black/[0.04]" : "bg-ink text-white hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-40"
          )}
        >
          {busy ? <Square className="size-4" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
      <p id="agent-composer-hint" className="mt-2 shrink-0 text-center text-[11px] leading-relaxed text-ink-dim">Enter 发送 · Shift + Enter 换行 · 修改数据前会请你确认</p>
      {run?.status === "cancelling" && (
        <p className="mt-2 text-center text-[11px] text-ink-dim">正在停止…已完成的写入会保留</p>
      )}
      </section>

      {/* ===== 工作台（Trae SOLO 式右栏：任务 / 产物 / 会话） ===== */}
      <aside aria-label="会话工作台" className="hidden w-[280px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/60 pl-5 xl:flex">
        {railBlocks}
      </aside>

      {/* 移动端工作台 slide-over */}
      <Modal open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} title="会话工作台">
        <div className="flex min-w-0 flex-col gap-3">{railBlocks}</div>
      </Modal>
    </div>
  );
}

/** 「本会话是否有在途任务」——运行管理器是唯一真源，不依赖组件状态 */
function isRunningSession(sessionId: string): boolean {
  const run = useRuntimeStore.getState().views[sessionId]?.run;
  return !!run && isInFlight(run.status);
}

/* ================= 消息内的运行块（UI-02） =================
 * 一条回答内从上到下：过程摘要行 → 可展开步骤 → 回答正文 → 待确认动作/结果。
 * 摘要只由真实事件生成（工具/计划/结果），没有证据时只说「正在等待模型响应」。 */
function LiveRun({
  run,
  notice,
  onDecide,
  onResume,
}: {
  run: SessionRun;
  notice?: string | null;
  onDecide: (actionId: string, approved: boolean) => void;
  onResume?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const live = isInFlight(run.status);
  const cancelled = run.status === "cancelled";
  const failed = run.status === "failed";
  const interrupted = run.status === "interrupted";
  const steps = runSteps(run);
  const headline = describeHeadline(run);

  return (
    <div
      className={cn(
        "max-w-[92%] rounded-2xl rounded-bl-md border px-3.5 py-2.5",
        failed ? "border-bad/30 bg-bad/[0.03]" : interrupted ? "border-warn/40 bg-warn/[0.04]" : "border-border bg-white"
      )}
      data-testid="live-run"
      data-session-id={run.sessionId}
      data-run-status={run.status}
    >
      {/* 过程摘要行：折叠时也显示当前具体阶段；展开入口始终可发现 */}
      <div className="flex items-center gap-2">
        {live ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
        ) : cancelled ? (
          <Circle className="size-3.5 shrink-0 text-ink-dim/50" />
        ) : failed ? (
          <X className="size-3.5 shrink-0 text-bad" />
        ) : interrupted ? (
          <Circle className="size-3.5 shrink-0 text-ink-dim/50" />
        ) : (
          <Check className="size-3.5 shrink-0 text-ok" />
        )}
        <span role="status" data-testid="run-headline" className="min-w-0 flex-1 text-[14px] leading-[1.45] text-ink-dim">
          {headline}
        </span>
        {(steps.length > 0 || interrupted) && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] text-ink-dim/70 transition hover:text-ink"
          >
            {open ? "收起" : "过程"}
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>

      {open && steps.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {steps.map((s) => (
            <div key={s.key} data-testid="run-step" data-source={s.source} className="flex items-start gap-1.5 text-[14px] leading-[1.45]">
              <span className="mt-[3px] shrink-0">
                <StepIcon status={s.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn(s.status === "failed" ? "text-bad" : "text-ink-dim")}>{s.label}</span>
                {s.detail && <span className="opacity-70"> · {s.detail}</span>}
              </span>
              <span className="shrink-0 text-[12px] text-ink-dim/70">
                {STEP_SOURCE_LABEL[s.source]}
                {s.ms != null && ` · ${s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)}s` : `${s.ms}ms`}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {run.partialAnswer && (
        <div className="mt-2">
          <Markdown text={run.partialAnswer} className="prose-reading" />
          {live && <span className="stream-cursor" />}
        </div>
      )}

      {interrupted && (
        <div className="mt-2 flex items-center gap-2">
          <p className="text-[14px] leading-[1.45] text-ink-dim">{notice ?? "上次的生成被页面刷新中断了。"}</p>
          {onResume && (
            <button
              type="button"
              onClick={onResume}
              className="cursor-pointer rounded-lg border border-border bg-white px-2.5 py-1 text-[11.5px] text-ink transition hover:bg-black/[0.04]"
            >
              继续回答
            </button>
          )}
        </div>
      )}

      {/* 审批卡队列：写入操作等待用户逐个决定（归属本会话运行，切走只隐藏） */}
      {run.pendingActions.map((a) => {
        const preview = actionPreview(a);
        return (
          <div key={a.id} className="mt-2.5 rounded-xl border border-accent/30 bg-accent/[0.04] p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
              待确认 · {a.label}
            </p>
            <p className="mt-1.5 text-[13px] font-bold text-ink">{a.summary}</p>
            {preview && (
              <details className="mt-1" open={preview.length <= 300}>
                <summary className="cursor-pointer text-[11px] text-ink-dim/80">变更内容</summary>
                <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-dim">
                  {preview}
                </p>
              </details>
            )}
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={() => onDecide(a.id, true)}
                className="cursor-pointer rounded-lg bg-ink px-3 py-1.5 text-[11.5px] font-medium text-white transition hover:bg-black/80"
              >
                批准执行
              </button>
              <button
                onClick={() => onDecide(a.id, false)}
                className="cursor-pointer rounded-lg border border-border bg-white px-3 py-1.5 text-[11.5px] text-ink-dim transition hover:text-ink"
              >
                拒绝
              </button>
            </div>
          </div>
        );
      })}

    </div>
  );
}

/** 历史消息的过程产物渲染（过程摘要行 + 可展开步骤 + 来源，刷新后仍在） */
function MsgMetaView({ meta, answer }: { meta?: ChatMsg["meta"]; answer: string }) {
  const [open, setOpen] = useState(false);
  if (!meta) return null;
  const citations = filterCitationsForAnswer(meta.citations ?? [], answer);
  const steps: { key: string; label: string; status: string; detail?: string; ms?: number; source: string }[] = [
    ...(meta.plan ?? []).map((p) => ({ key: `p-${p.id}`, label: p.text, status: p.status, source: "执行计划" })),
    ...(meta.tools ?? []).map((t) => ({
      key: `t-${t.id}`,
      label: TOOLS[t.name as keyof typeof TOOLS]?.label ?? t.name,
      status: t.status,
      detail: t.summary,
      ms: t.durationMs,
      source: t.status === "completed" ? "结果摘要" : "工具事件",
    })),
  ];

  const needsAttention = meta.status === "cancelled" || meta.status === "failed" || meta.status === "partial" || meta.status === "interrupted";
  if (!needsAttention && !steps.length && !meta.citations?.length && !meta.integrityNote) return null;

  return (
    <div className="mt-2.5 space-y-2 border-t border-border/60 pt-2.5">
      {(needsAttention || steps.length > 0) && (
        <div className="flex items-center gap-2" data-testid="msg-meta-headline">
          {needsAttention && (
            <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink-dim">
              {meta.headline || "这次回复没有完成"}
            </span>
          )}
          {steps.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] text-ink-dim/70 transition hover:text-ink"
            >
              {open ? "收起过程" : "查看过程"}
              <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            </button>
          )}
        </div>
      )}
      {open && steps.length > 0 && (
        <div className="space-y-1">
          {steps.map((s) => (
            <div key={s.key} data-testid="msg-step" data-source={s.source} className="flex items-start gap-1.5 text-[14px] leading-[1.45]">
              <span className="mt-[3px] shrink-0">
                <StepIcon status={s.status} />
              </span>
              <span className="min-w-0 flex-1 text-ink-dim">
                {s.label}
                {s.detail && <span className="opacity-70"> · {s.detail}</span>}
              </span>
              <span className="shrink-0 text-[12px] text-ink-dim/70">{s.source}</span>
            </div>
          ))}
        </div>
      )}
      {meta.integrityNote && (
        <p className="rounded-md bg-warn/[0.08] px-2 py-1 text-[12px] leading-[1.45] text-warn">
          {meta.integrityNote}
        </p>
      )}
      {citations.length > 0 && (
        <div className="space-y-1">
          <p className="flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim">
            <Link2 className="size-3" /> 来源
          </p>
          {citations.slice(0, 5).map((c, i) => (
            <a
              key={`${c.url}-${i}`}
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-[12px] text-accent underline-offset-2 hover:underline"
            >
              [{i + 1}] {c.kind === "snippet" ? "（搜索摘要）" : c.kind === "full" ? "（已读全文）" : ""}
              {c.title || c.url}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
