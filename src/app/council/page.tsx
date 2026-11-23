"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge, Button, Card, Input, Modal, PageHeader, Skeleton } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { ChatActivity } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated } from "@/lib/use-chat";
import {
  ALL_SEAT_METAS, seatById, normalizeSeatColor, type SeatMeta,
} from "@/lib/ai/persona-meta";
import { extractJson, personaDistillSchema, streamChat } from "@/lib/ai/client";
import { rebuildRtRetry } from "@/lib/rt-retry";
import { runDiscussion, isSessionBusy, type SeatStatus } from "@/lib/agent/council-engine";
import { cn, uid } from "@/lib/utils";
import { toast } from "sonner";
import { ChevronRight, Compass, FlaskConical, Plus, Trash2, UserPlus, Users, X, Zap } from "lucide-react";
import type { CustomPersona } from "@/lib/types";

/* 内置席位在前端只有展示元数据（无 system 提示词）；自建人物带用户自己蒸馏的 system */
type ResolvedPersona = SeatMeta | (CustomPersona & { id: string });
const isCustomPersona = (p: ResolvedPersona): p is CustomPersona & { id: string } =>
  "identityNote" in p;

/* 内置 12 席的 hedcut 点刻肖像（public/personas/）；自建人物回落到墨色首字母 */
const PORTRAITS: Record<string, string> = {
  naval: "/personas/naval.jpg",
  jobs: "/personas/jobs.jpg",
  munger: "/personas/munger.jpg",
  feynman: "/personas/feynman.jpg",
  taleb: "/personas/taleb.jpg",
  graham: "/personas/graham.jpg",
  karpathy: "/personas/karpathy.jpg",
  musk: "/personas/musk.jpg",
  zhangxuefeng: "/personas/zhangxuefeng.jpg",
  zhangyiming: "/personas/zhangyiming.jpg",
  mrbeast: "/personas/mrbeast.jpg",
  sutskever: "/personas/sutskever.jpg",
};

function PersonaAvatar({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className?: string; // 尺寸由调用方给，如 size-9 / size-10
}) {
  const src = PORTRAITS[id];
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className={cn("shrink-0 rounded-xl border border-border bg-surface-2 object-cover", className)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-xl bg-ink font-black text-white",
        className
      )}
    >
      {name.slice(0, 1)}
    </div>
  );
}

export default function CouncilPage() {
  return <Suspense fallback={<Skeleton className="h-40 rounded-2xl" />}><CouncilWorkspace /></Suspense>;
}

function CouncilWorkspace() {
  const searchParams = useSearchParams();
  const requestedSession = searchParams.get("session");
  const hydrated = useHydrated();
  const sessions = useAppStore((s) => s.sessions);
  const addSession = useAppStore((s) => s.addSession);
  const addSessionMsg = useAppStore((s) => s.addSessionMsg);
  const updateSession = useAppStore((s) => s.updateSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const customPersonas = useAppStore((s) => s.customPersonas);
  const addCustomPersona = useAppStore((s) => s.addCustomPersona);
  const removeCustomPersona = useAppStore((s) => s.removeCustomPersona);

  /* 结果入口直达（批次 D 补充）：/council?session=<id> 自动选中对应会话，
   * 用户从首页执行结果点进来不需要再翻历史列表找。
   * 用惰性初始化读取（与页面既有 window.innerWidth 默认值同一模式），
   * 不在 effect 里同步 setState（避免级联渲染）。会话由本地持久化水合，
   * 客户端首次渲染时 store 已可用；目标不存在则回退到默认选择流程。 */
  /* 深链（E2 验收 4）：?session=<id> 直接选中；指向不存在的会话时界面明确提示，不静默回退。
   * 读 URL 是纯函数式取值，惰性初始化里算一次，两个 state 共享同一结果（不碰 ref）。 */
  const deepLinkState = (() => {
    const target = requestedSession;
    if (!target) return { id: null, missing: false };
    const exists = useAppStore.getState().sessions.some((s) => s.id === target);
    return { id: exists ? target : null, missing: !exists };
  })();
  const [activeId, setActiveId] = useState<string | null>(deepLinkState.id);
  const [deepLinkMissing, setDeepLinkMissing] = useState(deepLinkState.missing);
  /* 用户已对哪个深链目标点了「知道了」。不能用 setDeepLinkMissing(false) 表达关闭：
   * 深链 effect 的依赖含 deepLinkMissing，且未命中目标从不登记 appliedDeepLinkRef
   * （「云水合可能稍后补上」是刻意设计），effect 重跑的 rAF 会立刻把 missing 置回
   * true——「知道了」会闪回成死控件。按目标记录关闭，换目标自动失效。 */
  const [deepLinkDismissedFor, setDeepLinkDismissedFor] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  /* 手机：会话历史默认收起（对话区优先），桌面始终左栏常驻（PRD §5.7） */
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const { messages, setMessages, pending, streaming, activity, error, send, stop, cancel, isBusy } = useChat();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = activeId ? drafts[activeId] ?? "" : "";
  const setInput = (text: string) => {
    if (!activeId) return;
    setDrafts((current) => ({ ...current, [activeId]: text }));
  };
  const bottomRef = useRef<HTMLDivElement>(null);

  // 圆桌状态（Roundtable-First PR1）：每轮一个 runId，可取消、失败诚实、会话间隔离
  const [rtParticipants, setRtParticipants] = useState<string[]>([]);
  const [rtTakes, setRtTakes] = useState<Record<string, string>>({});
  const [rtHost, setRtHost] = useState("");
  const [rtBusy, setRtBusy] = useState(false);
  const rtBusyRef = useRef(false); // 同步互斥：双击 Enter/重试按钮不靠异步 state 拦
  const [rtPhase, setRtPhase] = useState<"searching" | "takes" | "host" | null>(null);
  const [rtSessionId, setRtSessionId] = useState<string | null>(null); // 运行归属会话（UI 只在该会话显示）
  const [rtSeatStatus, setRtSeatStatus] = useState<Record<string, "pending" | "streaming" | "done" | "failed">>({});
  const [rtRetry, setRtRetry] = useState<null | {
    sessionId: string;
    question: string;
    seats: ResolvedPersona[]; // 需要重跑发言的席位；空数组 = 只重试主持人
    goodTakes: Record<string, string>;
    note: string;
  }>(null);
  const runIdRef = useRef<string | null>(null);
  const rtAbortRef = useRef<AbortController | null>(null);
  const appliedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    // Apply each URL target once; ordinary message writes must not steal selection.
    if (requestedSession === appliedDeepLinkRef.current && !deepLinkMissing) return;
    const target = requestedSession;
    const exists = !!target && sessions.some((s) => s.id === target);
    const raf = requestAnimationFrame(() => {
      setDeepLinkMissing(!!target && !exists);
      if (!target) { appliedDeepLinkRef.current = null; return; }
      // Leave unresolved targets pending: cloud hydration may supply them later.
      if (!exists) return;
      appliedDeepLinkRef.current = target;
      if (target !== activeId) {
        cancel();
        rtAbortRef.current?.abort();
      }
      setActiveId(target);
      setPicking(false);
      setSessionsOpen(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [requestedSession, sessions, hydrated, activeId, cancel, deepLinkMissing]);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const isRoundtable = active?.personaId === "roundtable";

  const resolvePersona = (personaId: string): ResolvedPersona | null | undefined => {
    if (personaId === "roundtable") return null;
    const builtin = seatById(personaId);
    if (builtin) return builtin;
    const c = customPersonas.find((x) => x.id === personaId);
    if (c) return { ...c, system: c.system };
    return undefined;
  };
  const persona = active ? resolvePersona(active.personaId) : undefined;
  const unanswered = active?.messages.at(-1);

  /* 贴底守卫：流式期间每个 delta 都会触发滚底，用户上滑回读时会被一直拽回底部。
   * 只在「用户本来就在底部附近」时跟随滚动；上滑离开底部即停手。 */
  const stickBottomRef = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      const el = bottomRef.current;
      if (!el) return;
      stickBottomRef.current = el.getBoundingClientRect().top - window.innerHeight < 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!stickBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending, streaming, rtTakes, rtHost]);

  useEffect(() => {
    if (active) setMessages(active.messages);
    /* 切回圆桌会话时从历史重建补答入口：rtRetry 是组件内存态，路由切换/刷新即丢，
     * 而失败席位/主持人失败的消息已永久写进会话历史并承诺「可单独重试」——
     * 不重建的话补救入口静默失效，用户只能整题重问（历史里还会留下重复的问题消息）。
     * 无失败（或补答已完成）的会话重建结果为 null，等于顺手清掉过期入口。 */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 只随 activeId 切换执行一次；「忽略」按钮置 null 的入口不能改到渲染期派生（会被重建复活）
    setRtRetry(
      active?.personaId === "roundtable" ? rebuildRtRetry(active, resolvePersona) : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /* 切路由离开本页时中止在途圆桌：否则 N+1 路请求会跑完并继续写全局 store，
   * 重进同一会话再提问就是两轮并发交叉写入（use-chat.ts:108 已有同款清理）。 */
  useEffect(() => () => rtAbortRef.current?.abort(), []);

  const allPersonaOptions = [
    ...ALL_SEAT_METAS.map((p) => ({ id: p.id, name: p.name, color: p.color, custom: false })),
    ...customPersonas.map((c) => ({ id: c.id, name: c.name, color: c.color, custom: true })),
  ];

  const startWith = (personaId: string) => {
    setPicking(false);
    const sessionId = uid("sess");
    if (personaId === "roundtable") {
      // 默认推荐 3 席（判断/聚焦/风险的张力组合），全选的代价见弹窗提示
      const preferred = ["naval", "jobs", "taleb"].filter((id) =>
        allPersonaOptions.some((p) => p.id === id)
      );
      setRtParticipants(
        preferred.length >= 2 ? preferred : allPersonaOptions.slice(0, 3).map((p) => p.id)
      );
      setForgeRoundtableOpen(true);
      return;
    }
    cancel();
    const p = resolvePersona(personaId);
    addSession({
      id: sessionId,
      personaId,
      title: p ? p.name : "对话",
      messages: [],
      createdAt: new Date().toISOString(),
    });
    setActiveId(sessionId);
    setMessages([]);
  };

  /* 圆桌会话创建（选完与会者） */
  const [forgeRoundtableOpen, setForgeRoundtableOpen] = useState(false);
  const createRoundtable = () => {
    if (rtParticipants.length < 2) {
      toast.error("圆桌至少 2 位与会者");
      return;
    }
    const sessionId = uid("sess");
    const names = rtParticipants
      .map((id) => allPersonaOptions.find((p) => p.id === id)?.name ?? id)
      .join(" · ");
    /* 同 startWith：选完与会者才真正换会话，此刻作废在途单人流，
     * 否则旧流的 delta 与完成时的整表替换会盖到这张新圆桌上。 */
    cancel();
    addSession({
      id: sessionId,
      personaId: "roundtable",
      participants: [...rtParticipants],
      title: `圆桌(${rtParticipants.length}人)：${names.slice(0, 24)}…`,
      messages: [],
      createdAt: new Date().toISOString(),
    });
    setActiveId(sessionId);
    setMessages([]);
    setPicking(false); // 选择页显隐条件含 picking：不清它，新建的圆桌会被选择页盖住
    setForgeRoundtableOpen(false);
    toast.success("圆桌已就位——把问题扔进来，每位与会者都会独立发言，最后有主持人纪要。");
  };

  /* 单人对话发送 */
  const doSend = () => {
    const text = input.trim();
    if (!text || streaming || !active) return;
    if (isRoundtable) {
      /* 圆桌同一时刻只跑一桌（全局互斥）。但必须给反馈：
       * 旧实现静默 return，用户在另一桌跑动时按 Enter 完全没动静，以为是卡了。 */
      if (rtBusyRef.current) {
        toast("另一张圆桌还在出纪要，等它跑完再发。");
        return;
      }
      /* 不在这里清输入框：roundtableSend 内部还有 isSessionBusy 守卫可能拒绝本次发送，
       * 先清的话被拒时用户草稿已丢。清空在守卫全部通过后进行（roundtableSend 内）。 */
      void roundtableSend(text);
      return;
    }
    sendSingle(text);
  };

  const sendSingle = (text: string, retry = false) => {
    if (!active || !persona || isBusy()) return;
    if (isSessionBusy(active.id)) {
      toast("这段对话正在回复，请稍等。");
      return;
    }
    const sessionId = active.id;
    const history = useAppStore.getState().sessions.find((s) => s.id === sessionId)?.messages;
    if (!history) return;
    if (!retry) {
      setInput("");
      addSessionMsg(sessionId, { id: uid("m"), role: "user", content: text, at: new Date().toISOString() });
    }
    void send({
      args: { mode: "single", personaId: persona.id, customSystem: isCustomPersona(persona) ? persona.system : undefined },
      userText: retry ? undefined : text,
      task: "council",
      history,
      onDone: (full) => {
        if (full.trim())
          addSessionMsg(sessionId, {
            id: uid("m"),
            role: "assistant",
            content: full,
            at: new Date().toISOString(),
          });
      },
      temperature: 0.7,
    });
  };

  /* 圆桌发送：全员并行独立发言 → 主持人纪要。
   * 批次 D：执行逻辑委托共享引擎（src/lib/agent/council-engine.ts）——
   * 首页智能体 run_discussion 与本页使用同一套席位/主持/门槛/重试语义。
   * 页面保留：runId 隔离 UI 写入、停止（abort）、补答横幅（setRtRetry 由结果驱动；
   * 跨轮重建仍走 rebuildRtRetry 从历史扫描）。引擎负责：store 落库（经 signal 守卫）、
   * pendingRetry 持久化（跨入口重试）、同会话互斥登记。 */
  const roundtableSend = async (
    text: string,
    retry?: { sessionId: string; question: string; seats: ResolvedPersona[]; goodTakes: Record<string, string> }
  ) => {
    const sessionId = retry?.sessionId ?? active?.id;
    if (!sessionId || rtBusyRef.current) return;
    if (!retry && !text.trim()) return;
    if (retry && activeIdRef.current !== sessionId) setActiveId(sessionId); // 重试时把用户带回那张桌
    /* 同会话互斥（共享引擎登记）：首页智能体正在跑同一张桌时拒绝，防交叉写入 */
    if (isSessionBusy(sessionId)) {
      toast("这场讨论正在执行中，等它结束再操作。");
      return;
    }
    /* 重试时按当前人物表重解席位：结果驱动的 rtRetry 存的是 resolvePersona 当时解析出的
     * 快照对象，人物此后被删除时快照仍带旧 system——直接跑会向 participants 已不含此席
     * 的会话写回孤儿发言、多烧一次调用。已删除席位跳过（与 rebuildRtRetry「席位已被
     * 删除/失效：无法重跑」同口径）；全部被删则无可重跑对象，撤下补答入口。 */
    let retrySeats = retry?.seats ?? [];
    if (retry) {
      retrySeats = retry.seats.filter((s) => resolvePersona(s.id) != null);
      if (retrySeats.length !== retry.seats.length) {
        if (retrySeats.length === 0) {
          setRtRetry(null);
          return;
        }
        // 横幅同步收敛为仍可重跑的席位（功能更新拿 state 里现成的 note，不在此处杜撰）
        setRtRetry((prev) => (prev && prev.sessionId === retry.sessionId ? { ...prev, seats: retrySeats } : prev));
      }
    }
    rtAbortRef.current?.abort(); // 掐掉可能还在飞的旧轮，防双写
    const runId = uid("rt");
    runIdRef.current = runId;
    const ac = new AbortController();
    rtAbortRef.current = ac;
    rtBusyRef.current = true;
    setRtBusy(true);
    setRtSessionId(sessionId);
    setRtHost("");
    setRtTakes({});

    const question = retry?.question ?? text.trim();
    const participants = retry
      ? retrySeats
      : ((active?.participants ?? []).map((id) => resolvePersona(id)).filter(Boolean) as ResolvedPersona[]);

    setRtSeatStatus(() => {
      const next: Record<string, SeatStatus> = {};
      for (const p of participants) next[p.id] = "pending";
      for (const id of Object.keys(retry?.goodTakes ?? {})) next[id] = "done";
      return next;
    });

    /* 第一个问题落地后，把「圆桌(N人)：…」换成问题摘要——历史列表才分得清哪次决策。
     * 用户消息本身由引擎落库（userMessage=question），页面在这里只管标题。 */
    if (!retry && active && active.messages.length === 0) {
      const d = new Date();
      updateSession(sessionId, {
        title: `${question.replace(/\s+/g, " ").slice(0, 16)} · ${participants.length}人 · ${d.getMonth() + 1}/${d.getDate()}`,
      });
    }
    /* 守卫全部通过才清输入框：被互斥拒绝时用户草稿不丢（与 sendSingle 的守卫后清空
     * 同序）；重试补答不消费输入框草稿，不清。 */
    if (!retry) setInput("");

    try {
      const result = await runDiscussion(
        {
          sessionId,
          question,
          userMessage: retry ? "" : question, // 重试补答轮不重复落用户消息
          participants: participants.map((p) => ({
            id: p.id,
            name: p.name,
            system: isCustomPersona(p) ? p.system : undefined,
          })),
          mode: "roundtable",
          goodTakes: retry?.goodTakes,
          onlySeats: retry ? retrySeats.map((s) => s.id) : undefined,
          signal: ac.signal,
          callbacks: {
            onPhase: (ph) => {
              if (runIdRef.current === runId) setRtPhase(ph);
            },
            onSeatDelta: (id, cum) => {
              if (runIdRef.current === runId) setRtTakes((prev) => ({ ...prev, [id]: cum }));
            },
            onSeatStatus: (id, st) => {
              if (runIdRef.current === runId) setRtSeatStatus((s) => ({ ...s, [id]: st }));
            },
            onHostDelta: (d) => {
              if (runIdRef.current === runId) setRtHost((h) => h + d);
            },
            onSaved: () => {
              if (runIdRef.current !== runId) return;
              if (activeIdRef.current === sessionId) {
                setMessages(useAppStore.getState().sessions.find((x) => x.id === sessionId)?.messages ?? []);
              }
            },
          },
        },
        (id) => customPersonas.find((c) => c.id === id)
      );

      /* 结果 → 补答横幅（引擎已把 pendingRetry 持久化到会话，跨入口可重试） */
      if (runIdRef.current !== runId || ac.signal.aborted) return;
      const failedSeats = participants.filter((p) => result.failedSeatIds.includes(p.id));
      if (result.status === "insufficient") {
        const retryable = result.failedSeatIds.length > 0 && participants.length + Object.keys(retry?.goodTakes ?? {}).length >= 2;
        setRtRetry(
          retryable
            ? { sessionId, question, seats: failedSeats, goodTakes: result.goodTakes, note: `${failedSeats.length} 席发言失败` }
            : null
        );
      } else if (result.status === "partial") {
        setRtRetry({
          sessionId,
          question,
          seats: failedSeats,
          goodTakes: result.goodTakes,
          note: `${failedSeats.length} 席发言失败（纪要已按 ${Object.keys(result.goodTakes).length} 席生成）`,
        });
      } else if (result.status === "failed" && result.hostFailed) {
        setRtRetry({ sessionId, question, seats: [], goodTakes: result.goodTakes, note: "主持人纪要失败" });
      } else if (result.status === "done") {
        /* 全部席位到齐且纪要落定：撤下本会话的补答入口（防重复发言/重复计费） */
        setRtRetry((prev) => (prev && prev.sessionId === sessionId ? null : prev));
      }
    } finally {
      // 只有当前轮才能收尾：旧轮不许清掉新轮的 live 状态（多轮并发隔离的关键）
      if (runIdRef.current === runId) {
        if (activeIdRef.current === sessionId) {
          const finalMsgs = useAppStore.getState().sessions.find((x) => x.id === sessionId)?.messages ?? [];
          setMessages(finalMsgs);
        }
        setRtTakes({});
        setRtHost("");
        setRtSeatStatus({});
        setRtPhase(null);
        setRtBusy(false);
        rtBusyRef.current = false;
        runIdRef.current = null;
        rtAbortRef.current = null;
      }
    }
  };

  /* 停止本轮：完成的发言保留在记录里，未完成的不再继续 */
  const cancelRoundtable = () => {
    const ac = rtAbortRef.current;
    if (!ac) return;
    const sid = rtSessionId;
    ac.abort();
    if (sid) {
      addSessionMsg(sid, {
        id: uid("m"),
        role: "assistant",
        content: "> 已取消本轮圆桌：已完成的发言保留在记录里，未完成的不再继续。",
        at: new Date().toISOString(),
      });
    }
  };

  const newChat = () => {
    /* 新建会话即离开当前轮：作废在途单人流，否则它的 delta 会盖在选择页上、
     * 完成时还会用旧线程整体替换下一个会话的视图。 */
    cancel();
    setActiveId(null);
    setMessages([]);
    setPicking(true);
  };

  /* ---- 自定义智能体锻造 ---- */
  const [forgeOpen, setForgeOpen] = useState(false);
  /* 删除自建人物要二次确认：removeCustomPersona 会级联删掉与 TA 的全部单聊记录，
   * 且 2.5s 后自动推上云——误触一次就是跨设备不可逆丢失。 */
  const [deletingPersona, setDeletingPersona] = useState<{ id: string; name: string } | null>(null);
  /* 会话删除同样二次确认：整段对话记录，删了就找不回来。 */
  const [deletingSession, setDeletingSession] = useState<{ id: string; title: string } | null>(null);
  const [forgeName, setForgeName] = useState("");
  const [forgeHint, setForgeHint] = useState("");
  const [forging, setForging] = useState(false);
  const forgeAbortRef = useRef<AbortController | null>(null);
  const forgeGenRef = useRef(0); // 关窗即换代：迟到的蒸馏结果不许复活
  const [forged, setForged] = useState<null | {
    identityNote: string; name: string; tag: string; bio: string; color: string; system: string;
  }>(null);

  /* 关窗即中止本轮蒸馏：旧实现无 signal 也无丢弃检查，关掉弹窗后迟到的结果会在
   * 下次打开时「复活」，用户可能误把已放弃的人物存进圆桌。 */
  const closeForge = () => {
    forgeGenRef.current += 1;
    forgeAbortRef.current?.abort();
    setForgeOpen(false);
    setForged(null);
    setForging(false);
  };

  /* 卸载（路由切换）同样要中止蒸馏：persona-distill 是服务端长任务（LONG_GEN_TASKS，
   * 超时放宽到 120s），开着弹窗直接切路由时请求会继续跑完——BYOK 下烧的是用户的钱，
   * 结果还因组件卸载被丢弃；中途失败更会在下一个页面弹全局「蒸馏失败」toast。
   * gen 守卫保证迟到的失败不会误报（149 行圆桌清理 / use-chat.ts 卸载清理同款）。 */
  useEffect(() => () => forgeAbortRef.current?.abort(), []);

  const forge = async () => {
    if (!forgeName.trim()) {
      toast.error("先告诉我要蒸馏谁");
      return;
    }
    setForging(true);
    setForged(null);
    const gen = ++forgeGenRef.current;
    forgeAbortRef.current?.abort(); // 掐掉可能还在飞的上一轮
    const ac = new AbortController();
    forgeAbortRef.current = ac;
    try {
      const full = await streamChat({
        task: "persona-distill",
        args: { name: forgeName.trim(), hint: forgeHint.trim() },
        messages: [{ role: "user", content: `蒸馏：${forgeName.trim()}` }],
        temperature: 0.5,
        signal: ac.signal,
        onDelta: () => {},
      });
      if (gen !== forgeGenRef.current) return; // 已关窗/已换代：结果作废
      const p = personaDistillSchema.parse(extractJson(full));
      setForged({
        identityNote: p.identityNote,
        name: p.name,
        tag: p.tag,
        bio: p.bio,
        color: normalizeSeatColor(p.color),
        system: p.system,
      });
    } catch (e) {
      if (gen !== forgeGenRef.current || ac.signal.aborted) return; // 主动中止不是失败
      /* ZodError 的 message 是 issues 数组的 JSON 转储（BYOK 弱模型输出缺字段/类型不符
       * 并不罕见），直接进 toast 用户看到的是一段 [ {"code":…} ]。给可读文案，
       * 与同弹窗 extractJson 失败的中文口径一致。 */
      if (e instanceof Error && e.name === "ZodError") {
        toast.error("模型输出的人物资料不完整，换更明确的线索再蒸馏一次。");
        return;
      }
      toast.error(e instanceof Error ? e.message : "蒸馏失败，请重试");
    } finally {
      if (gen === forgeGenRef.current) setForging(false);
    }
  };

  const saveForged = () => {
    if (!forged) return;
    /* 重名拦截：圆桌历史按 **【显示名】** 前缀归属各席发言（引擎落库 council-engine.ts
     * 与补答重建 rt-retry.ts 都只用名字），同名两个人物进同一张桌会把同一段历史错配给
     * 两席——goodTakes 重复引用、一人失败两人同时标失败、重试重复烧调用。
     * 内置席位名同样占用（同一张桌里「Elon Musk」+自建同名人也是同前缀）。 */
    const name = forged.name.trim();
    if (allPersonaOptions.some((p) => p.name === name)) {
      toast.error(`已有同名人物「${name}」，换一个名字或补充线索重新蒸馏再入库。`);
      return;
    }
    const id = `custom:${uid("p")}`;
    addCustomPersona({
      id,
      name: forged.name,
      tag: forged.tag,
      bio: forged.bio,
      color: forged.color,
      identityNote: forged.identityNote,
      system: forged.system,
      createdAt: new Date().toISOString(),
    });
    toast.success(`「${forged.name}」已加入你的圆桌`);
    setForgeOpen(false);
    setForgeName("");
    setForgeHint("");
    setForged(null);
  };

  if (!hydrated) return <Skeleton className="h-40 rounded-2xl bg-surface/60" />;

  return (
    <div>
      <PageHeader
        icon={<Compass className="size-5" />}
        title="人生伙伴"
        desc="拿不定的事，问他们。他们不说客套话。"
        right={
          <Button variant="outline" onClick={newChat}>
            <Plus className="size-4" /> 选择伙伴或圆桌
          </Button>
        }
      />

      {/* deepLinkMissing 初值在挂载首帧计算，而 persist 为 skipHydration、store 要等
          /api/auth/me 后才切到用户仓（use-chat.ts useHydrated）——有效深链也会先被算成
          「不存在」。渲染期再用当前 sessions 复核：有效目标即使 state 尚未纠正（rAF
          前的一帧）也不亮横幅，误报消灭在渲染层，而不是闪一下再消失。 */}
      {deepLinkMissing &&
        !!requestedSession &&
        !sessions.some((s) => s.id === requestedSession) &&
        deepLinkDismissedFor !== requestedSession && (
        <Card className="mb-4 border-warn/30 bg-warn/[0.05] py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-dim">
              <X className="size-4 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0">
                链接指向的会话不存在（可能已被删除）。可以从下面的对话记录里重新选择，或开始新对话。
              </span>
            </p>
            <button
              type="button"
              onClick={() => setDeepLinkDismissedFor(requestedSession)}
              className="shrink-0 cursor-pointer text-xs font-semibold text-accent hover:opacity-75"
            >
              知道了
            </button>
          </div>
        </Card>
      )}

      <div className="mb-4 flex items-center gap-2 lg:hidden">
        <button
          onClick={() => setSessionsOpen((v) => !v)}
          aria-expanded={sessionsOpen}
          className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl border border-border bg-white px-3.5 py-2.5 text-left text-[13px] text-ink transition hover:bg-black/[0.02]"
        >
          <Users className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate font-medium">对话记录 · {sessions.length}</span>
          <ChevronRight className={cn("size-4 shrink-0 text-ink-dim transition", sessionsOpen && "rotate-90")} />
        </button>
      </div>

      {/* E2 验收 3：当前会话 / 参与人物 / 本轮议题一眼可见（不靠翻历史猜） */}
      {active && (
        <Card className="mb-4 border-accent/25 bg-accent/[0.03] py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">当前会话</p>
              <h3 className="mt-0.5 break-words text-base font-bold text-ink">{active.title}</h3>
              {(() => {
                const firstUser = active.messages.find((m) => m.role === "user");
                return firstUser ? (
                  <p className="mt-1 line-clamp-2 break-words text-sm text-ink-dim">
                    议题：{firstUser.content}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-ink-dim/70">还没有议题——在下面输入框说你的问题。</p>
                );
              })()}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {active.personaId === "roundtable" ? (
                (active.participants ?? []).map((pid) => {
                  const p = resolvePersona(pid);
                  return p ? <Badge key={pid} tone="dim">{p.name}</Badge> : null;
                })
              ) : (
                <Badge tone="dim">{resolvePersona(active.personaId)?.name ?? active.personaId}</Badge>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        {/* 会话列表：桌面=左栏常驻；手机=可折叠横条（默认收起，对话区占首屏，M6-4） */}
        <Card className={cn("h-fit lg:sticky lg:top-8", !sessionsOpen && "hidden lg:block")}>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-dim">
            对话记录
          </p>
          {sessions.length === 0 ? (
            <p className="text-xs text-ink-dim">还没有对话</p>
          ) : (
            <div className="space-y-1">
              {sessions.map((s) => {
                /* 会话行补键盘语义：div+onClick 时代键盘/读屏用户打不开历史会话。
                 * 行内含删除按钮，故不能换成真 button，用 role+tabIndex+Enter/Space。 */
                const openSession = () => {
                  // 点会话必须同时退出选择页：newChat 会把 picking 置 true，
                  // 只设 activeId 的话界面仍停在会话选择页（点旧会话看起来"没反应"）
                  setPicking(false);
                  /* 切换即作废在途单人流：整页只有一份 useChat（messages/pending 与
                   * 会话无关），不掐的话旧流的 delta 与完成时的整表替换会串到这张会话上。
                   * 视图作废 ≠ 丢回答：若响应恰在 abort 生效前已完整到达，use-chat 的
                   * send 会照常执行 onDone 把完整回答落回发起它的会话（use-chat.ts:87-93
                   * 刻意保留的语义，切回来能看到）——别把它当死代码移除。 */
                  if (s.id !== activeId) cancel();
                  setActiveId(s.id);
                  setSessionsOpen(false); // 手机折叠条：选完即收，消息区回首屏
                };
                return (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`打开对话：${s.title}`}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                      activeId === s.id ? "bg-accent/[0.08] font-medium text-accent" : "text-ink-dim hover:bg-black/[0.04]"
                    )}
                    onClick={openSession}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openSession();
                      }
                    }}
                  >
                    {s.personaId === "roundtable" ? (
                      <Users className="size-3.5 shrink-0" />
                    ) : (
                      <span className={cn("size-2 shrink-0 rounded-full", activeId === s.id ? "bg-accent" : "bg-black/20")} />
                    )}
                    <span className="truncate">{s.title}</span>
                    <button
                      className="tap-target ml-auto flex items-center justify-center opacity-60 transition hover:text-bad cursor-pointer"
                      aria-label="删除会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        /* 二次确认：会话里是完整对话记录，且删除会随云同步推到其他设备——
                         * 误触一次就不可逆。 */
                        setDeletingSession({ id: s.id, title: s.title });
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* 主区 */}
        <div className="min-w-0">
          {/* 无 active 即回选择页：旧条件在「active 为空但流式未结束（pending / rtBusy）」
              时留在对话区，删除当前会话后就出现 "?" 头像、空名称的幽灵聊天。 */}
          {picking || !active ? (
            <div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <button
                  onClick={() => startWith("roundtable")}
                  className="group rounded-2xl border border-accent/25 bg-accent/[0.04] p-5 text-left transition hover:border-accent/45 cursor-pointer sm:col-span-2 lg:col-span-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-ink">
                      <Users className="size-5 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-ink">圆桌研讨会</p>
                      <p className="text-xs text-ink-dim">
                        每人独立发言，主持人收拢成纪要。
                      </p>
                    </div>
                  </div>
                </button>

                {/* 添加智能体 */}
                <button
                  onClick={() => setForgeOpen(true)}
                  className="flex min-h-[108px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-accent/35 bg-accent/[0.03] p-4 text-ink-dim transition hover:border-accent/60 hover:text-accent cursor-pointer"
                >
                  <UserPlus className="size-6" />
                  <span className="text-sm font-semibold">添加人物</span>
                  <span className="text-[11px]">说一个名字，蒸馏到本人降临</span>
                </button>

                {/* 自定义智能体 */}
                {customPersonas.map((c) => (
                  <div key={c.id} className="relative">
                    <button
                      onClick={() => startWith(c.id)}
                      className="w-full rounded-2xl border border-accent/25 bg-accent/[0.03] p-4 text-left transition hover:border-accent/45 hover:bg-accent/[0.05] cursor-pointer h-full"
                    >
                      <div className="flex items-center gap-2.5">
                        <PersonaAvatar id={c.id} name={c.name} className="size-9 text-sm" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-ink">{c.name}</p>
                          <p className="text-[11px] text-ink-dim">{c.tag} · 自建</p>
                        </div>
                      </div>
                      <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-dim">{c.bio}</p>
                    </button>
                    <button
                      onClick={() => setDeletingPersona({ id: c.id, name: c.name })}
                      className="absolute right-2 top-2 rounded-lg p-1.5 text-ink-dim/60 hover:bg-bad/10 hover:text-bad cursor-pointer"
                      title="删除该人物"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}

                {ALL_SEAT_METAS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => startWith(p.id)}
                    className="group card-lift rounded-2xl border border-border bg-white p-4 text-left transition hover:border-accent/40 cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <PersonaAvatar id={p.id} name={p.name} className="size-9 text-sm" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-ink">{p.name}</p>
                        <p className="text-[11px] text-ink-dim">{p.tag}</p>
                      </div>
                    </div>
                    <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-dim">{p.bio}</p>
                  </button>
                ))}
              </div>

              <Card className="mt-6 border-warn/25 bg-warn/[0.05]">
                <p className="flex items-center gap-2 text-sm font-bold text-warn">
                  <Zap className="size-4" /> 规矩只有一条
                </p>
                <p className="mt-2 text-xs leading-relaxed text-ink-dim">
                  第一句就是判断，没有「取决于」。你错，他们直说。
                </p>
              </Card>
            </div>
          ) : (
            <>
              <Card className="mb-4 flex items-center gap-3">
                {isRoundtable ? (
                  <>
                    <div className="flex size-10 items-center justify-center rounded-xl bg-ink">
                      <Users className="size-5 text-white" />
                    </div>
                    <div>
                      <p className="font-bold text-ink">圆桌研讨会</p>
                      <p className="text-xs text-ink-dim">
                        {(active?.participants ?? []).length} 位与会者全员独立发言 + 主持人纪要
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <PersonaAvatar id={persona?.id ?? ""} name={persona?.name ?? "?"} className="size-10 text-sm" />
                    <div>
                      <p className="font-bold text-ink">{persona?.name}</p>
                      {persona && (
                        <button type="button" onClick={() => startWith(persona.id)} className="mt-1 text-xs font-medium text-accent hover:underline">
                          与 {persona.name} 新开对话
                        </button>
                      )}
                      <p className="text-xs text-ink-dim">{persona?.tag} · {persona?.bio}</p>
                    </div>
                  </>
                )}
              </Card>

              <div className="space-y-5">
                {!isRoundtable && messages.length === 0 && (
                  <p className="py-6 text-center text-sm text-ink-dim">直接向 {persona?.name} 提问。涉及最新消息时会自动查询公开网页。</p>
                )}
                {messages.map((m) => (
                  <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                    {m.role === "user" ? (
                      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-white">
                        {m.content}
                      </div>
                    ) : (
                      <Card
                        className={cn(
                          "w-full max-w-[72ch] rounded-xl border-border/70 px-4 py-3 shadow-none sm:px-5",
                          m.content.startsWith("## 圆桌纪要") && "border-accent/25 bg-accent/[0.04]"
                        )}
                      >
                        <Markdown text={m.content} className="prose-reading council-prose" />
                      </Card>
                    )}
                  </div>
                ))}
                {!isRoundtable && streaming && (
                  <ChatActivity activity={activity} waitingLabel={"正在等待 " + (persona?.name ?? "伙伴") + " 回复"} />
                )}
                {pending && !isRoundtable && (
                  <Card className="w-full max-w-[72ch] rounded-xl border-border/70 px-4 py-3 shadow-none sm:px-5">
                    <Markdown text={pending} className="prose-reading council-prose" />
                    <span className="stream-cursor" />
                  </Card>
                )}
                {/* 圆桌并行发言（流式中；只在本会话显示，切走不串台。
                 * 不挂 aria-live：席位正文逐 token 更新，播报交给下面的状态横幅） */}
                {isRoundtable && rtBusy && rtSessionId === activeId && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(active?.participants ?? []).map((pid) => {
                      const p = resolvePersona(pid);
                      if (!p) return null;
                      const text = rtTakes[pid];
                      const st = rtSeatStatus[pid];
                      return (
                        <Card key={pid} className="py-3.5">
                          <p className="mb-1.5 text-xs font-bold text-accent">{p.name}</p>
                          {text ? (
                            <div className="text-ink-dim">
                              <Markdown text={text} className="prose-reading council-prose" />
                              <span className="stream-cursor" />
                            </div>
                          ) : st === "failed" ? (
                            <p className="flex items-center gap-1.5 text-xs font-medium text-bad">
                              <X className="size-3.5 shrink-0" aria-hidden /> 发言失败（本轮结束后可单独重试）
                            </p>
                          ) : st === "done" ? (
                            <p className="text-xs text-ink-dim/60">已完成，发言见下方记录</p>
                          ) : (
                            <p className="text-xs text-ink-dim/60">思考中…</p>
                          )}
                        </Card>
                      );
                    })}
                    {rtHost && (
                      <Card className="border-accent/25 bg-accent/[0.04] py-3.5 sm:col-span-2">
                        <p className="mb-1.5 text-xs font-bold text-accent">主持人纪要（生成中）</p>
                        <Markdown text={rtHost} className="prose-reading council-prose" />
                        <span className="stream-cursor" />
                      </Card>
                    )}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              <div className="above-mobile-nav sticky mt-4 bg-bg py-2">
                {isRoundtable && rtBusy && rtSessionId === activeId && (
                  <div
                    aria-live="polite"
                    className="mb-2 flex items-center justify-between rounded-xl border border-accent/25 bg-accent/[.05] px-3 py-2 text-xs text-accent"
                  >
                    <span>
                      {rtPhase === "host"
                        ? "主持人正在综合各席发言…"
                        : rtPhase === "searching"
                          /* 联网检索最长 27 秒（web-search.ts AbortSignal.timeout），此前这段
                           * 时间被误标成「独立发言进行中 · 0/N 席完成」——用户看到在发言却
                           * 长时间 0 席动弹。现在如实说明当前在做什么。 */
                          ? "正在联网查找资料…（拿到资料后各席才开始发言）"
                          : `独立发言进行中 · ${Object.values(rtSeatStatus).filter((s) => s === "done").length}/${Object.keys(rtSeatStatus).length || (active?.participants ?? []).length} 席完成`}
                    </span>
                    <button onClick={cancelRoundtable} className="cursor-pointer font-semibold hover:opacity-75">
                      停止
                    </button>
                  </div>
                )}
                {isRoundtable && !rtBusy && rtRetry && rtRetry.sessionId === activeId && (
                  <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-warn/25 bg-warn/[.06] px-3 py-2 text-xs text-ink-dim">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <X className="size-3.5 shrink-0 text-warn" aria-hidden />
                      <span className="min-w-0">
                        {rtRetry.seats.length > 0
                          ? `${rtRetry.seats.map((s) => s.name).join("、")} 发言失败；${Object.keys(rtRetry.goodTakes).length} 席发言已保留`
                          : "主持人纪要生成失败；各席发言已保留"}
                        （{rtRetry.note}）
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <button
                        onClick={() => void roundtableSend("", rtRetry)}
                        className="cursor-pointer font-semibold text-accent hover:opacity-75"
                      >
                        {rtRetry.seats.length > 0 ? `重试 ${rtRetry.seats.length} 个失败席位` : "重试主持人纪要"}
                      </button>
                      <button onClick={() => setRtRetry(null)} className="cursor-pointer hover:text-ink">
                        忽略
                      </button>
                    </span>
                  </div>
                )}
                {!isRoundtable && error && <p role="alert" className="mb-2 text-xs text-bad">{error}</p>}
                {!isRoundtable && !streaming && persona && unanswered?.role === "user" && (
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-dim">
                    <span>上一条问题还没收到回复。</span>
                    <Button size="sm" variant="outline" onClick={() => sendSingle(unanswered.content, true)}>继续回答</Button>
                  </div>
                )}
                <div className="flex gap-2">
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    /* 中文输入法选词回车不该当发送：isComposing 期间放行给输入法 */
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && doSend()}
                    placeholder={
                      isRoundtable
                        ? "把问题扔到圆桌上…"
                        : persona
                          ? `向 ${persona.name} 抛出你的困惑、决策或焦虑…`
                          : "输入…"
                    }
                    disabled={streaming || (rtBusy && rtSessionId === activeId)}
                  />
                  {streaming && !isRoundtable && (
                    <Button variant="outline" onClick={stop} className="h-11 shrink-0 sm:h-10">
                      停止
                    </Button>
                  )}
                  <Button
                    onClick={doSend}
                    /* 忙碌状态按会话维度：旧实现用页面级 rtBusy，他桌跑动时本会话发送按钮
                     * 假装 loading/禁用而输入框照常可输，Enter 又真的能用——按钮状态撒谎。 */
                    loading={streaming || (rtBusy && rtSessionId === activeId)}
                    className="h-11 shrink-0 sm:h-10"
                  >
                    发送
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 圆桌与会者选择 */}
      <Modal open={forgeRoundtableOpen} onClose={() => setForgeRoundtableOpen(false)} title="圆桌研讨会 · 选择与会者" wide>
        <p className="mb-3 text-sm text-ink-dim">推荐 3 席起——有分歧才有价值。每位与会者独立发言，最后由主持人综合成纪要；席位越多越慢、消耗越大（每席一次模型调用）。</p>
        {rtParticipants.length > 6 && (
          <p className="mb-2 rounded-lg border border-warn/25 bg-warn/[.06] px-3 py-2 text-xs text-warn">
            当前选了 {rtParticipants.length} 席：将发起 {rtParticipants.length + 1} 次模型调用，等待明显变长、配额消耗显著。确定再开。
          </p>
        )}
        <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-3">
          {allPersonaOptions.map((p) => {
            const checked = rtParticipants.includes(p.id);
            return (
              <button
                key={p.id}
                aria-pressed={checked}
                onClick={() =>
                  setRtParticipants((prev) =>
                    checked ? prev.filter((x) => x !== p.id) : [...prev, p.id]
                  )
                }
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-xs transition cursor-pointer",
                  checked ? "border-accent/30 bg-accent/[0.08] font-medium text-accent" : "border-border bg-white text-ink-dim hover:text-ink"
                )}
              >
                <PersonaAvatar id={p.id} name={p.name} className="size-6 rounded-lg text-[10px]" />
                <span className="truncate">{p.name}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex justify-between">
          <Button variant="ghost" onClick={() => setRtParticipants(allPersonaOptions.map((p) => p.id))}>
            全选
          </Button>
          <Button onClick={createRoundtable}>
            <Users className="size-4" /> 开始圆桌（{rtParticipants.length} 人）
          </Button>
        </div>
      </Modal>

      {/* 删除会话确认 */}
      <Modal
        open={!!deletingSession}
        onClose={() => setDeletingSession(null)}
        title="删除这次对话？"
      >
        <p className="text-sm leading-relaxed text-ink">
          「{deletingSession?.title}」的全部消息会一起删除，并同步到其他设备。删了找不回来。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeletingSession(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!deletingSession) return;
              // 正在跑的圆桌先停掉再删，防止飞行中的请求继续写
              if (rtBusyRef.current && rtSessionId === deletingSession.id) rtAbortRef.current?.abort();
              // 单人对话在流式时也先停掉：否则 pending 仍在累积，onDone 还会往已删会话写消息
              if (streaming && deletingSession.id === activeId) stop();
              removeSession(deletingSession.id);
              if (activeId === deletingSession.id) {
                setActiveId(null);
                setMessages([]);
              }
              setDeletingSession(null);
              toast.success("已删除这次对话");
            }}
          >
            删除
          </Button>
        </div>
      </Modal>

      {/* 删除自建人物确认：明示级联删除范围（单聊记录会一起没） */}
      <Modal
        open={!!deletingPersona}
        onClose={() => setDeletingPersona(null)}
        title="删除这个人物？"
      >
        <p className="text-sm leading-relaxed text-ink">
          删除「{deletingPersona?.name}」会同时删除你和 TA 的全部单聊记录。
          圆桌历史里的发言还在，但席位不再可选。这个动作会同步到其他设备，找不回来。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeletingPersona(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!deletingPersona) return;
              const personaId = deletingPersona.id;
              /* 级联清理圆桌 participants：只删 personaId 命中的单聊会话会留下悬空 id，
               * 圆桌头部人数、实际席位卡、进度分母三处对不上。 */
              for (const s of useAppStore.getState().sessions) {
                if (s.personaId !== "roundtable") continue;
                if (!(s.participants ?? []).includes(personaId)) continue;
                updateSession(s.id, {
                  participants: (s.participants ?? []).filter((x) => x !== personaId),
                });
              }
              removeCustomPersona(personaId);
              toast.success(`已移除 ${deletingPersona.name}`);
              setDeletingPersona(null);
            }}
          >
            删除
          </Button>
        </div>
      </Modal>

      {/* 自定义智能体锻造 */}
      <Modal open={forgeOpen} onClose={closeForge} title="添加人物" wide>
        {!forged ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-dim">
              输入一个真实人物的名字（如「王阳明」「贝佐斯」「Jony Ive」），会先确认这是谁，再深度蒸馏：思想体系、真实原话、语言指纹、论敌立场——直到仿佛本人降临。
            </p>
            <Input
              placeholder="名字，如：王阳明"
              value={forgeName}
              onChange={(e) => setForgeName(e.target.value)}
            />
            <Input
              placeholder="补充线索（可选）：领域/时代/代表作，帮助认对人"
              value={forgeHint}
              onChange={(e) => setForgeHint(e.target.value)}
            />
            <div className="flex justify-end">
              <Button onClick={forge} loading={forging}>
                <FlaskConical className="size-4" /> 开始深度蒸馏
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Card className="border-accent/25 bg-accent/[0.04]">
              <p className="text-xs font-semibold uppercase tracking-wider text-accent">身份确认</p>
              <p className="mt-1.5 text-sm text-ink">{forged.identityNote}</p>
              <p className="mt-2 text-xs text-ink-dim">不是你想的那个人？改个更具体的名字或补充线索再试。</p>
            </Card>
            <div className="flex items-center gap-3">
              <PersonaAvatar id={forged.name} name={forged.name} className="size-11 text-base" />
              <div>
                <p className="font-bold text-ink">{forged.name}</p>
                <p className="text-xs text-ink-dim">{forged.tag} · {forged.bio}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setForged(null)}>重来</Button>
              <Button onClick={saveForged}>就是 TA，加入圆桌</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
