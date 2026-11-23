"use client";

/* ============================================================
 * 共享圆桌讨论引擎（批次 D 主体，C03/C04）
 *
 * 从 council 页抽取的执行逻辑，供两处使用同一套：
 *   1. 人生伙伴页（roundtableSend 委托到这里，UI 状态经回调驱动）；
 *   2. 首页智能体 run_discussion 工具（无页面状态，直接消费结果）。
 *
 * 纪律（继承 council 页 PR1 + 用户验收标准）：
 *   - 单一会话互斥：activeRuns 登记，同会话并发发起直接拒绝；
 *   - 停止即停：abort 后不再启动后续请求（席位/主持），迟到增量与迟到落库一律拒绝；
 *   - 已删除会话不复活：store 写入对不存在的会话天然 no-op，迟到写不串写；
 *   - 失败残片不进纪要：有效发言（含保留的 goodTakes）≥2 席才综合；
 *   - 部分失败可恢复：失败席位单独重试（已完成席位不重复调用/不重复保存）；
 *     主持人失败复用已完成发言单独重试，不重跑整桌；
 *   - 重试状态持久化在会话上（pendingRetry），跨轮次/跨入口可用。
 * ============================================================ */
import { streamChat } from "@/lib/ai/client";
import { councilEvidence } from "@/lib/web-search";
import { useAppStore } from "@/lib/store";
import { uid } from "@/lib/utils";
import type { CustomPersona } from "@/lib/types";

export interface EnginePersona {
  id: string;
  name: string;
  system?: string; // 自建人物的用户 system；内置席位只发 id 由服务端解析
}

export type SeatStatus = "pending" | "streaming" | "done" | "failed";

export interface DiscussionResult {
  status: "done" | "partial" | "insufficient" | "failed" | "cancelled";
  sessionId: string;
  question: string;
  /** 本轮有效发言（含重试保留的 goodTakes），seatId → 全文 */
  goodTakes: Record<string, string>;
  failedSeatIds: string[];
  /** 主持人纪要全文；未生成（不足两席/主持失败/取消）为 null */
  hostText: string | null;
  hostFailed: boolean;
  /** 写入会话的消息数（席位 + 主持人/门槛提示），供结果核对 */
  savedMessages: number;
  /** 失败原因（单人模式/席位异常时的真实错误，供上层如实转述；不含隐私） */
  error?: string;
}

export interface DiscussionCallbacks {
  /** 阶段通知：searching（联网检索中）/ takes（席位发言开始）/ host（主持人开始） */
  onPhase?: (phase: "searching" | "takes" | "host") => void;
  /** 席位累计文本（流式），seatId → 当前累计 */
  onSeatDelta?: (seatId: string, cumulative: string) => void;
  onSeatStatus?: (seatId: string, status: SeatStatus) => void;
  /** 主持人增量（分片） */
  onHostDelta?: (delta: string) => void;
  /** 用户消息/席位/主持落库后的通知（页面刷新本地视图用） */
  onSaved?: (kind: "user" | "seat" | "host" | "note", seatId?: string) => void;
}

export interface DiscussionOptions {
  sessionId: string;
  /** 讨论问题（席位/主持收到的问题；重试路径仍要传原问题） */
  question: string;
  /** 落库的用户消息（fresh 轮=用户原话；重试补答轮传空串则不重复落库）。缺省=question */
  userMessage?: string;
  /** 发给席位/主持人的上下文问题（缺省=question）。继续讨论时在此合成原议题+历史要点+新约束 */
  seatQuestion?: string;
  participants: EnginePersona[];
  mode: "single" | "roundtable";
  /** 重试路径：保留的已完成发言（这些席位本轮不再调用） */
  goodTakes?: Record<string, string>;
  /** 重试路径：只跑这些席位（缺省=全部未完成席位） */
  onlySeats?: string[];
  /** 主持人单独重试：跳过所有席位，直接用 goodTakes 出纪要 */
  hostOnly?: boolean;
  /** 单人模式的历史上下文（页内 useChat 自管；智能体续聊时传入） */
  history?: { role: "user" | "assistant"; content: string }[];
  signal: AbortSignal;
  callbacks?: DiscussionCallbacks;
}

/** 同会话互斥登记（页面与智能体共用）：同一会话不能交叉写入 */
const activeRuns = new Map<string, true>();

/** 圆桌席位上限（模型/工具驱动路径的硬上限）：每席一次真实模型调用 + 主持一次，
 *  与 create_session 的 slice(0,6) 同口径。UI 手工建桌另有「>6 席」显著警告，属用户
 *  知情选择；工具路径由模型生成名单，必须设硬闸，否则一次批准可触发 19+ 并发调用。 */
export const MAX_ROUNDTABLE_SEATS = 6;

export function isSessionBusy(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

/** 单人模式一轮：写入用户消息（freshRound）→ 流式回复 → 落库 */
async function runSingleTurn(opts: DiscussionOptions): Promise<DiscussionResult> {
  const { sessionId, question, participants, signal, callbacks } = opts;
  const persona = participants[0];
  let savedMessages = 0;
  if (!persona) {
    return { status: "failed", sessionId, question, goodTakes: {}, failedSeatIds: [], hostText: null, hostFailed: false, savedMessages, error: "没有可用的对话人物（可能已被删除）。" };
  }
  const userMessage = opts.userMessage !== undefined ? opts.userMessage : question;
  if (userMessage) {
    useAppStore.getState().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "user",
      content: userMessage,
      at: new Date().toISOString(),
    });
    savedMessages += 1;
    callbacks?.onSaved?.("user");
  }
  let full = "";
  try {
    full = await streamChat({
      task: "council",
      args: { mode: "single", personaId: persona.id, customSystem: persona.system },
      messages: [...(opts.history ?? []), { role: "user", content: opts.seatQuestion || question }],
      temperature: 0.8,
      signal,
      onDelta: (d) => {
        if (signal.aborted) return;
        full += d;
        callbacks?.onSeatDelta?.(persona.id, full);
      },
    });
  } catch (e) {
    if (signal.aborted) return { status: "cancelled", sessionId, question, goodTakes: {}, failedSeatIds: [persona.id], hostText: null, hostFailed: false, savedMessages };
    /* 与圆桌模式对齐：失败必须在会话里留下可见痕迹并带重试指引。
     * 此前 catch{} 整体吞掉错误，会话里只留一条没有回复、没有失败标记的用户消息，
     * 用户不知道发生了什么、也不知道可以重发；错误原因（配额/Key/断网）全程不可见。 */
    const reason = e instanceof Error && e.message ? e.message : "未知错误";
    useAppStore.getState().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "assistant",
      content: `> 本轮回复失败：${reason.slice(0, 200)}\n> 你的问题已保留，重发一次即可继续。`,
      at: new Date().toISOString(),
    });
    savedMessages += 1;
    callbacks?.onSaved?.("note");
    return { status: "failed", sessionId, question, goodTakes: {}, failedSeatIds: [persona.id], hostText: null, hostFailed: false, savedMessages, error: reason };
  }
  if (signal.aborted) return { status: "cancelled", sessionId, question, goodTakes: {}, failedSeatIds: [persona.id], hostText: null, hostFailed: false, savedMessages };
  const text = full;
  if (text) {
    useAppStore.getState().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "assistant",
      /* 单人会话与会话既有历史同格式（页面单人流不带名字前缀） */
      content: text,
      at: new Date().toISOString(),
    });
    callbacks?.onSaved?.("seat", persona.id);
    return { status: "done", sessionId, question, goodTakes: { [persona.id]: text }, failedSeatIds: [], hostText: null, hostFailed: false, savedMessages: savedMessages + 1 };
  }
  /* 模型返回空正文：同样留痕，不静默 */
  useAppStore.getState().addSessionMsg(sessionId, {
    id: uid("m"),
    role: "assistant",
    content: "> 本轮回复为空：模型没有返回任何内容。你的问题已保留，重发一次即可继续。",
    at: new Date().toISOString(),
  });
  callbacks?.onSaved?.("note");
  return { status: "failed", sessionId, question, goodTakes: {}, failedSeatIds: [persona.id], hostText: null, hostFailed: false, savedMessages: savedMessages + 1, error: "模型返回空内容" };
}

export function resolveAddressedSeat(
  message: string,
  participants: { id: string; name: string }[]
): string | null {
  const text = (message || "").trim();
  if (!text || participants.length === 0) return null;

  /* 实际席位显示名是全名（"Naval Ravikant"/"Steve Jobs"），用户输入常用短名。
   * 别名集合 = 全名 + 首词 + 末词（长度 ≥3，避免过短词误命中）。 */
  const aliasesOf = (name: string): string[] => {
    const full = name.trim();
    const parts = full.split(/\s+/).filter(Boolean);
    const set = new Set<string>([full]);
    if (parts.length >= 2) {
      set.add(parts[0]);
      set.add(parts[parts.length - 1]);
    }
    return [...set].filter((a) => a.length >= 3);
  };

  const hit = participants.filter((p) => {
    if (!p.name.trim()) return false;
    return aliasesOf(p.name).some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const directed = new RegExp(`(?:只|仅|单)\\s*(?:请|让|要|叫|找)?\\s*${escaped}`, "i");
      const answering = new RegExp(`${escaped}\\s*(?:来|回答|发言|说|讲)`, "i");
      return directed.test(text) || answering.test(text);
    });
  });
  return hit.length === 1 ? hit[0].id : null;
}

/**
 * 圆桌一轮：席位并行独立发言 → 门槛检查 → 主持人纪要。
 * store 写入全部经 signal 守卫；重试状态持久化到会话（pendingRetry）。
 */
export async function runDiscussion(opts: DiscussionOptions, customOf: (id: string) => CustomPersona | undefined = () => undefined): Promise<DiscussionResult> {
  const { sessionId, mode } = opts;
  if (activeRuns.has(sessionId)) {
    /* 重试轮走到这里说明 takePendingRetry 已把会话上的挂起态清空（取出即清空），
     * 而本函数因互斥没执行——必须原样放回，否则这次 retry 直接让重试入口消失。 */
    if (opts.onlySeats?.length || opts.hostOnly) {
      useAppStore.getState().updateSession(sessionId, {
        pendingRetry: {
          question: opts.question,
          seatQuestion: opts.seatQuestion,
          goodTakes: opts.goodTakes ?? {},
          failedSeatIds: opts.onlySeats ?? [],
          hostFailed: opts.hostOnly === true,
        },
      });
    }
    return { status: "failed", sessionId, question: opts.question, goodTakes: {}, failedSeatIds: [], hostText: null, hostFailed: false, savedMessages: 0 };
  }
  activeRuns.set(sessionId, true);
  try {
    const result = await (mode === "single" ? runSingleTurn(opts) : runRoundtable(opts, customOf));
    /* 重试轮提前退出（取消/定向失败/主持取消）时必须把「仍未完成的席位」写回挂起态：
     * takePendingRetry 已把会话上的旧 pendingRetry 清空（取出即清空），而 runRoundtable
     * 的取消/定向失败路径提前 return、不写 pendingRetry。不回写就会丢掉这些席位——它们
     * 本轮已完成的发言已在 goodTakes 里，旧 failedSeatIds 却还会让下次 retry 把它们
     * 重新真实调用一遍并重复写消息（重复计费 + 会话出现重复发言）。 */
    if (mode === "roundtable" && (opts.onlySeats?.length || opts.hostOnly) && (result.status === "cancelled" || result.status === "failed")) {
      const done = new Set(Object.keys(result.goodTakes).filter((id) => result.goodTakes[id]));
      const stillFailed = opts.hostOnly
        ? []
        : [...new Set([...result.failedSeatIds, ...(opts.onlySeats ?? []).filter((id) => !done.has(id))])];
      useAppStore.getState().updateSession(sessionId, {
        pendingRetry: {
          question: result.question,
          seatQuestion: opts.seatQuestion,
          goodTakes: result.goodTakes,
          failedSeatIds: stillFailed,
          hostFailed: result.hostFailed || opts.hostOnly === true,
        },
      });
    }
    return result;
  } finally {
    activeRuns.delete(sessionId);
  }
}

async function runRoundtable(opts: DiscussionOptions, customOf: (id: string) => CustomPersona | undefined): Promise<DiscussionResult> {
  const { sessionId, signal, callbacks } = opts;
  void customOf;
  const store = () => useAppStore.getState();
  /* 用户消息：fresh 轮落库（重试补答轮传空 userMessage 不重复落） */
  const userMessage = opts.userMessage !== undefined ? opts.userMessage : opts.question;
  if (userMessage) {
    store().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "user",
      content: userMessage,
      at: new Date().toISOString(),
    });
    callbacks?.onSaved?.("user");
  }

  const goodTakes: Record<string, string> = { ...(opts.goodTakes ?? {}) };
  const failedSeatIds: string[] = [];
  let savedMessages = 0;
  let hostFailed = false;
  let hostText: string | null = null;
  let status: DiscussionResult["status"] = "done";

  /* 明确唯一点名：只发目标席位（PRD §4）。歧义时保持全席，不替用户选人。 */
  const addressed = !opts.hostOnly && !opts.onlySeats && userMessage
    ? resolveAddressedSeat(userMessage, opts.participants)
    : null;
  const seatList = opts.hostOnly
    ? []
    : addressed
      ? opts.participants.filter((p) => p.id === addressed)
      : opts.participants.filter((p) => !(opts.onlySeats ? !opts.onlySeats.includes(p.id) : p.id in goodTakes));


  /* 联网检索先于发言（时效问题必触发 /api/search，上限 27 秒）。此前 onPhase("takes")
   * 在 await 之前就发出，横幅显示「独立发言进行中 · 0/N 席完成」——用户看到「正在发言」
   * 却 27 秒内 0 席动弹，既无等待提示、状态语义也是错的。现在检索期间先报 searching，
   * 检索结束（或不需要检索）才报 takes，与单聊路径的搜索反馈同口径。 */
  const { evidence, sources } = await councilEvidence(opts.question, signal, () => callbacks?.onPhase?.("searching")).catch(() => ({ evidence: "", sources: "" }));
  if (signal.aborted) {
    return { status: "cancelled", sessionId, question: opts.question, goodTakes, failedSeatIds, hostText, hostFailed, savedMessages };
  }
  callbacks?.onPhase?.("takes");

  /* 席位并行（与 council 页一致：全员独立发言） */
  await Promise.all(
    seatList.map(async (p) => {
      let take = "";
      callbacks?.onSeatStatus?.(p.id, "streaming");
      try {
        const full = await streamChat({
          task: "council",
          args: { mode: "take", evidence, name: p.name, personaId: p.id, customSystem: p.system ?? customOf(p.id)?.system },
          messages: [{ role: "user", content: opts.seatQuestion || opts.question }],
          temperature: 0.8,
          signal,
          onDelta: (d) => {
            if (signal.aborted) return; // 已停止：增量一律不写
            take += d;
            callbacks?.onSeatDelta?.(p.id, take);
          },
        });
        if (signal.aborted) return;
        if (!full.trim()) throw new Error("发言为空");
        goodTakes[p.id] = full;
        callbacks?.onSeatStatus?.(p.id, "done");
        if (goodTakes[p.id]) {
          store().addSessionMsg(sessionId, {
            id: uid("m"),
            role: "assistant",
            content: `**【${p.name}】**\n\n${goodTakes[p.id]}`,
            at: new Date().toISOString(),
          });
          savedMessages += 1;
          callbacks?.onSaved?.("seat", p.id);
        }
      } catch {
        if (signal.aborted) return;
        failedSeatIds.push(p.id);
        callbacks?.onSeatStatus?.(p.id, "failed");
        store().addSessionMsg(sessionId, {
          id: uid("m"),
          role: "assistant",
          content: `**【${p.name}】**（发言失败——本轮结束后可单独重试）`,
          at: new Date().toISOString(),
        });
        savedMessages += 1;
        callbacks?.onSaved?.("seat", p.id);
      }
    })
  );
  if (signal.aborted) {
    return { status: "cancelled", sessionId, question: opts.question, goodTakes, failedSeatIds, hostText: null, hostFailed: false, savedMessages };
  }

  const nameOf = (id: string) => opts.participants.find((p) => p.id === id)?.name ?? customOf(id)?.name ?? "与会者";
  const validIds = Object.keys(goodTakes).filter((id) => goodTakes[id]);

  /* 定向单席：不套用「≥2 席」门槛；目标席失败给出可解释终态 */
  if (addressed && validIds.length === 0) {
    store().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "assistant",
      content: `> 定向追问未被回答：${nameOf(addressed)} 本轮没有产出有效内容，可重试该席位或改为全员圆桌。`,
      at: new Date().toISOString(),
    });
    callbacks?.onSaved?.("note");
    return { status: "failed", sessionId, question: opts.question, goodTakes, failedSeatIds, hostText: null, hostFailed: false, savedMessages: savedMessages + 1 };
  }
  /* 门槛：有效发言 ≥2 席才综合（失败残片不进纪要）；定向单席不适用 */
  if (!addressed && validIds.length < 2) {
    status = "insufficient";
    const totalSeats = opts.participants.length;
    const retryable = validIds.length + failedSeatIds.length >= 2 && totalSeats >= 2;
    store().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "assistant",
      content: retryable
        ? `> 本轮有效发言不足 2 席（${validIds.length}/${totalSeats}），主持人不强行综合。失败席位可单独重试，补齐后再出纪要。`
        : "> 这张圆桌凑不出 2 席有效发言（与会者已被删除或席位全部失效），无法生成纪要。请新建一张圆桌重新选人。",
      at: new Date().toISOString(),
    });
    savedMessages += 1;
    callbacks?.onSaved?.("note");
    /* 重试状态持久化（可跨轮重试失败席位） */
    store().updateSession(sessionId, {
      pendingRetry: retryable
        ? { question: opts.question, seatQuestion: opts.seatQuestion, goodTakes, failedSeatIds, hostFailed: false }
        : null,
    });
    return { status, sessionId, question: opts.question, goodTakes, failedSeatIds, hostText: null, hostFailed: false, savedMessages };
  }

  /* 定向追问不发主持（PRD §4：目标唯一时只发目标席位，不默认发主持） */
  if (addressed) {
    store().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "assistant",
      content: `（定向追问：本轮仅 ${nameOf(addressed)} 回答，不生成主持人纪要。）`,
      at: new Date().toISOString(),
    });
    callbacks?.onSaved?.("note");
    return { status: failedSeatIds.length > 0 ? "partial" : "done", sessionId, question: opts.question, goodTakes, failedSeatIds, hostText: null, hostFailed: false, savedMessages: savedMessages + 1 };
  }
  /* 主持人纪要 */
  callbacks?.onPhase?.("host");
  try {
    const names = validIds.map(nameOf).join("、");
    const takes = validIds.map((id) => `【${nameOf(id)}】${goodTakes[id]}`).join("\n\n");
    const full = await streamChat({
      task: "council",
      args: { mode: "host", names, takes, evidence, question: opts.seatQuestion || opts.question },
      messages: [{ role: "user", content: "请围绕这个问题写圆桌纪要：\n" + (opts.seatQuestion || opts.question) }],
      temperature: 0.4,
      signal,
      onDelta: (d) => {
        if (signal.aborted) return;
        callbacks?.onHostDelta?.(d);
      },
    });
    if (signal.aborted) {
      return { status: "cancelled", sessionId, question: opts.question, goodTakes, failedSeatIds, hostText: null, hostFailed: true, savedMessages };
    }
    if (!full.trim()) throw new Error("纪要为空");
    hostText = full + sources;
    store().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "assistant",
      content: (opts.goodTakes && !opts.hostOnly) || opts.onlySeats ? `## 圆桌纪要（补答后重出 · ${validIds.length} 席）\n\n${hostText}` : `## 圆桌纪要\n\n${hostText}`,
      at: new Date().toISOString(),
    });
    savedMessages += 1;
    callbacks?.onSaved?.("host");
    status = failedSeatIds.length > 0 ? "partial" : "done";
    /* 部分失败：纪要已按完成席位生成，失败席位留补答入口；全部完成则清掉挂起重试 */
    store().updateSession(sessionId, {
      pendingRetry:
        failedSeatIds.length > 0
          ? { question: opts.question, seatQuestion: opts.seatQuestion, goodTakes, failedSeatIds, hostFailed: false }
          : null,
    });
  } catch {
    if (signal.aborted) {
      return { status: "cancelled", sessionId, question: opts.question, goodTakes, failedSeatIds, hostText: null, hostFailed: true, savedMessages };
    }
    hostFailed = true;
    status = failedSeatIds.length > 0 ? "partial" : "failed";
    store().addSessionMsg(sessionId, {
      id: uid("m"),
      role: "assistant",
      content: "> 主持人纪要生成失败：各席发言已完整保留，可重试主持人纪要。",
      at: new Date().toISOString(),
    });
    savedMessages += 1;
    callbacks?.onSaved?.("note");
    store().updateSession(sessionId, {
      pendingRetry: {
        question: opts.question,
        seatQuestion: opts.seatQuestion,
        goodTakes,
        failedSeatIds,
        hostFailed: true,
      },
    });
  }

  return { status, sessionId, question: opts.question, goodTakes, failedSeatIds, hostText, hostFailed, savedMessages };
}

/** 消费挂起重试并清空（供 run_discussion 的 retry 语义）：返回 null 表示无可重试。
 *  契约：取出即清空——否则用户取消重试轮后旧 failedSeatIds 仍挂着，再次 retry 会把
 *  本轮已完成并已落库的席位重新真实调用一次、重复写消息。重试轮自身若提前退出
 *  （取消/失败），由 runDiscussion 按本轮实际结果回写挂起态。 */
export function takePendingRetry(sessionId: string): {
  question: string;
  seatQuestion?: string;
  goodTakes: Record<string, string>;
  failedSeatIds: string[];
  hostFailed: boolean;
} | null {
  const sess = useAppStore.getState().sessions.find((s) => s.id === sessionId);
  const pr = sess?.pendingRetry;
  if (!pr) return null;
  useAppStore.getState().updateSession(sessionId, { pendingRetry: null });
  return pr;
}
