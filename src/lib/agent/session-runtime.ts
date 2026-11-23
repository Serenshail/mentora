"use client";

/* 会话运行管理器（CX-01/CX-02）
 *
 * 解决的问题：首页对话框此前把 busy / abortRef / pendingActions / 草稿 / 滚动位
 * 全部放在**单个组件实例**里——发一次问就全局忙，切会话会把运行态清掉，两个会话
 * 不可能同时有在途任务，上滚后发送不回底。「每个会话独立运行」要真做到，运行态
 * 必须按 [userId, sessionId, runId] 归属，且生命周期独立于当前渲染的聊天组件。
 *
 * 本模块的边界（与 PRD §4.1 对齐）：
 *  - 画面状态（草稿/附件/滚动位/运行快照）进 zustand，供 UI 订阅；
 *  - AbortController、审批门 resolver、Promise 句柄只存在模块级 Map 里，
 *    绝不进 state、不进 JSON、不进 localStorage；
 *  - 事件按发起时的身份定位：所有写入都带显式 sessionId，绝不用「回调时的 activeSession」；
 *  - runId + seq 用于丢弃重复/过时回调（迟到的 delta 不得写回新会话）。
 *
 * 不支持：跨设备同步、服务端续跑。刷新后无法续跑的在途任务标 interrupted，
 * 保留已保存内容并允许用户显式重发，禁止自动重放未知副作用（见 readInflight）。
 */

import { create } from "zustand";
import type { ApprovalDecision, PendingAction, PlanStep, ToolCall } from "./protocol";
import type { TracePhase } from "@/components/agent-trace";

/** 附件（截图/代码图）：只在内存与当前会话草稿里，不落盘 */
export interface Attachment {
  dataUrl: string;
  name: string;
  w: number;
  h: number;
}

/** 运行状态机（PRD §4.2 的 Mentora 落点；queued 由并发上限使用） */
export type RunStatus =
  | "queued"
  | "preparing"
  | "generating"
  | "executing_tool"
  | "awaiting_approval"
  | "cancelling"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

/** 未完成的运行态（还在转圈的都算） */
export function isInFlight(status: RunStatus): boolean {
  return (
    status === "queued" ||
    status === "preparing" ||
    status === "generating" ||
    status === "executing_tool" ||
    status === "awaiting_approval" ||
    status === "cancelling"
  );
}

/** 过程步骤的来源类别（PRD §5.2：必须标明来源，不允许伪造思考） */
export type StepSource = "tool_event" | "plan" | "result_summary" | "waiting";

export interface SessionRun {
  runId: string;
  sessionId: string;
  /** 事件序号：迟到的低序号回调一律丢弃 */
  seq: number;
  status: RunStatus;
  /** 折叠标题依据的粗阶段 */
  phase: "thinking" | "acting" | "answering";
  startedAt: number;
  finishedAt?: number;
  /** 折叠时可见的最新一条有证据的事件（真实来源，不编造） */
  headline: string;
  /** 首个模型增量到达时刻（真实事件计时；绝不用准备请求的几毫秒当思考时长） */
  firstDeltaAt?: number;
  /** 首个工具开始时刻 */
  firstToolAt?: number;
  plan: PlanStep[];
  tools: ToolCall[];
  /** 历史遗留字段：只在 startRun 时初始化为 []，从无写入方也**没有消费方**——
   *  轨迹展示由 tracePhasesOf(run) 从真实事件实时重算，不读这里。
   *  保留是因为 3 处 startRun 初始化与既有测试夹具都按此形状构造；
   *  新增代码不要往里写轨迹（写了也不会被渲染）。 */
  phases: TracePhase[];
  /** 流式正文（未终结） */
  partialAnswer: string;
  /** 终态正文（用于消息落库前的展示一致性） */
  finalAnswer?: string;
  pendingActions: PendingAction[];
  error?: string | null;
  cancelled?: boolean;
}

/** 每会话的界面状态（草稿、附件、滚动） */
export interface SessionView {
  /** 用户发出去后为 null（已随消息落库），运行中仍可继续写 */
  run: SessionRun | null;
  /** 未中断的提示（如上一轮刷新被中断） */
  notice?: string | null;
}

interface RuntimeState {
  drafts: Record<string, string>;
  attachments: Record<string, Attachment | null>;
  /** 「继续回答」重试用的原图暂存（按会话）：附件在首次发送受理后即被清空，
   *  ChatMsg 只存文本不存图片——不暂存的话，带图提问失败/中断后重发就只剩文本。
   *  只存内存不落盘（dataUrl 太大不能进 localStorage）；刷新后丢失，UI 会如实
   *  提示需要重新上传，而不是静默发一条没有图的重试。 */
  stashedAttachments: Record<string, Attachment | null>;
  /** 滚动跟随最新（false = 用户上翻在看历史） */
  following: Record<string, boolean>;
  /** 每会话滚动位置，切会话恢复 */
  scrollTops: Record<string, number>;
  views: Record<string, SessionView>;
  /* ---- 草稿/附件/滚动 ---- */
  setDraft: (sessionId: string, text: string) => void;
  setAttachment: (sessionId: string, a: Attachment | null) => void;
  setStashedAttachment: (sessionId: string, a: Attachment | null) => void;
  setFollowing: (sessionId: string, v: boolean) => void;
  setScrollTop: (sessionId: string, top: number) => void;
  /* ---- 运行快照 ---- */
  startRun: (sessionId: string, run: SessionRun) => void;
  /** 按 runId 核对后合并；runId 不符（过时/别的运行）一律忽略。
   *  stamp 是可选的**事件序号**（用于明确的乱序事件）：小于当前序号即视为过时丢弃。
   *  正常回调用不到 stamp——同一次运行内的事件由 runId 唯一确定。 */
  patchRun: (sessionId: string, runId: string, patch: Partial<SessionRun>, stamp?: number) => void;
  /* 注：没有独立的 endRun——运行收尾统一走 patchRun(终态 status) + clearRun，
   * 此前那个与 patchRun 同构的 endRun 全仓零调用（含测试），已删除。 */
  clearRun: (sessionId: string) => void;
  setNotice: (sessionId: string, notice: string | null) => void;
  /* ---- 账户/会话清理 ---- */
  dropSession: (sessionId: string) => void;
  dropAllForUser: () => void;
}

export const useRuntimeStore = create<RuntimeState>()((set) => ({
  drafts: {},
  attachments: {},
  stashedAttachments: {},
  following: {},
  scrollTops: {},
  views: {},

  setDraft: (sessionId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } })),
  setAttachment: (sessionId, a) =>
    set((s) => ({ attachments: { ...s.attachments, [sessionId]: a } })),
  setStashedAttachment: (sessionId, a) =>
    set((s) => ({ stashedAttachments: { ...s.stashedAttachments, [sessionId]: a } })),
  setFollowing: (sessionId, v) =>
    set((s) => ({ following: { ...s.following, [sessionId]: v } })),
  setScrollTop: (sessionId, top) =>
    set((s) => ({ scrollTops: { ...s.scrollTops, [sessionId]: top } })),

  startRun: (sessionId, run) =>
    set((s) => ({ views: { ...s.views, [sessionId]: { run, notice: null } } })),

  patchRun: (sessionId, runId, patch, stamp) =>
    set((s) => {
      const cur = s.views[sessionId]?.run;
      /* 身份核对：别的运行的迟到回调、或明确更旧的事件序号，一律不写入 */
      if (!cur || cur.runId !== runId) return s;
      if (stamp != null && stamp < cur.seq) return s;
      const next = { ...cur, ...patch, seq: cur.seq + 1 };
      return { views: { ...s.views, [sessionId]: { ...s.views[sessionId], run: next } } };
    }),

  clearRun: (sessionId) =>
    set((s) => ({ views: { ...s.views, [sessionId]: { run: null, notice: null } } })),

  setNotice: (sessionId, notice) =>
    set((s) => ({
      views: { ...s.views, [sessionId]: { run: s.views[sessionId]?.run ?? null, notice } },
    })),

  dropSession: (sessionId) =>
    set((s) => {
      const drafts = { ...s.drafts };
      const attachments = { ...s.attachments };
      const stashedAttachments = { ...s.stashedAttachments };
      const following = { ...s.following };
      const scrollTops = { ...s.scrollTops };
      const views = { ...s.views };
      delete drafts[sessionId];
      delete attachments[sessionId];
      delete stashedAttachments[sessionId];
      delete following[sessionId];
      delete scrollTops[sessionId];
      delete views[sessionId];
      return { drafts, attachments, stashedAttachments, following, scrollTops, views };
    }),

  dropAllForUser: () => set({ drafts: {}, attachments: {}, stashedAttachments: {}, following: {}, scrollTops: {}, views: {} }),
}));

/* ================= 模块级句柄（绝不进 state/JSON） ================= */

const controllers = new Map<string, AbortController>();
/** 审批门：按会话隔离，**决定也记在门里**。此前决定记在组件级 ref（decisionsRef），
 *  两个会话先后开审批门会互相重置——A 会话已批的第 1 张卡被 B 的开门清掉，
 *  回到 A 批第 2 张时 runner 只收到 1 个决定，缺失的那个按「没有决定 = 批准」执行，
 *  未批准的写入就这样穿透了审批门（PRD §6.1/§9.4 红线）。 */
interface ApprovalGate {
  resolve: (d: ApprovalDecision[]) => void;
  actions: PendingAction[];
  decisions: Map<string, boolean>;
}
const resolvers = new Map<string, ApprovalGate>();

/** 发起一次运行：登记 controller 并写入在途标记（刷新后据此标 interrupted） */
export function beginRun(sessionId: string, runId: string): AbortController {
  controllers.get(sessionId)?.abort(); // 同会话一次只允许一个任务
  const ac = new AbortController();
  controllers.set(sessionId, ac);
  markInflight(sessionId, runId);
  return ac;
}

export function controllerOf(sessionId: string): AbortController | null {
  return controllers.get(sessionId) ?? null;
}

export function isRunning(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const run = useRuntimeStore.getState().views[sessionId]?.run;
  return !!run && isInFlight(run.status);
}

/** 取消：立刻进 cancelling（UI 200ms 内有反馈），再 abort 底层请求 */
export function cancelRun(sessionId: string, reason: "user" | "switch" = "user"): void {
  const st = useRuntimeStore.getState();
  const run = st.views[sessionId]?.run;
  if (run && isInFlight(run.status)) {
    st.patchRun(sessionId, run.runId, { status: "cancelling", headline: "正在停止…" }, run.seq);
  }
  const ac = controllers.get(sessionId);
  controllers.delete(sessionId);
  clearInflight(sessionId);
  /* 审批门挂起时「停止」= 逐张拒绝（不写业务数据）。必须显式给 approved:false——
   * 传空数组会被 runner 当成「没有决定 = 批准」而真的执行写入。 */
  const gate = resolvers.get(sessionId);
  if (gate) {
    resolvers.delete(sessionId);
    gate.resolve(gate.actions.map((a) => ({ actionId: a.id, approved: false })));
  }
  try {
    ac?.abort(reason);
  } catch {
    /* abort 不该抛；真抛了也不该影响取消本身 */
  }
}

/** 取消所有会话的在途运行（账户切换/退出登录用） */
export function cancelAllRuns(reason: "user" | "switch" = "switch"): void {
  for (const sid of [...controllers.keys()]) cancelRun(sid, reason);
  /* 只有审批门没有 controller 的极端情形也要收口 */
  for (const sid of [...resolvers.keys()]) cancelRun(sid, reason);
}

export function registerApproval(
  sessionId: string,
  actions: PendingAction[],
  resolve: (d: ApprovalDecision[]) => void
): void {
  resolvers.set(sessionId, { resolve, actions, decisions: new Map() });
}

/** 记一张卡的决定；全部卡都有决定时收口 resolve。决定跨会话不共享（P1-1 修复）。 */
export function recordApprovalDecision(sessionId: string, actionId: string, approved: boolean): void {
  const gate = resolvers.get(sessionId);
  if (!gate) return;
  gate.decisions.set(actionId, approved);
  if (gate.actions.every((a) => gate.decisions.has(a.id))) {
    resolvers.delete(sessionId);
    gate.resolve(
      gate.actions.map((a) => ({ actionId: a.id, approved: gate.decisions.get(a.id) === true }))
    );
  }
}

export function approvalResolverOf(sessionId: string | null | undefined): ((d: ApprovalDecision[]) => void) | null {
  if (!sessionId) return null;
  return resolvers.get(sessionId)?.resolve ?? null;
}

export function resolveApproval(sessionId: string, decisions: ApprovalDecision[]): void {
  const gate = resolvers.get(sessionId);
  resolvers.delete(sessionId);
  gate?.resolve(decisions);
}

/** 结束一次运行：清句柄与在途标记 */
export function releaseRun(sessionId: string): void {
  controllers.delete(sessionId);
  resolvers.delete(sessionId);
  clearInflight(sessionId);
}

/** 账户切换：立即取消旧用户的在途任务并清空运行态（S07：迟到结果不得写入新账户）。
 *  同一账户的重复调用是空操作——否则每次 /api/auth/me 刷新都会打断正在跑的任务。
 *
 *  R2（独立复核 2026-11-12）：**首次登记也必须设置作用域**。旧实现首次调用直接
 *  `return`，`runtimeUserScope` 一直停在 "anon"，于是登录用户第一轮运行的在途标记
 *  写成 `anon:session-A`——刷新后被判成别的账户，中断提示丢失，也给「未知归属」留下口子。 */
let runtimeAccountKey: string | null | undefined;
export function resetRuntimeForAccount(userId: string | null): void {
  if (runtimeAccountKey === userId) return;
  const first = runtimeAccountKey === undefined;
  /* 旧身份要在覆盖前取出来：清理必须用**旧**身份，新运行只许用新身份 */
  const previousScope = runtimeUserScope;
  runtimeAccountKey = userId;
  runtimeUserScope = userId ?? "anon";

  /* 匿名 → 登录（含首次登记）：把历史无前缀的匿名标记认领给该用户，
   * 否则「刷新后第一次登录」会丢掉自己上一轮的中断提示。
   * 只认「匿名 → 具名用户」这一个方向；匿名状态与跨用户切换都不认领
   * （未知归属不得直接归给当前用户，R3 要求）。 */
  /* 无归属旧键一律隔离，绝不认领给任何人（R4） */
  quarantineUnownedMarks();

  if (first) return; // 首次登记：没有旧运行要清，作用域与认领已就位

  cancelAllRuns("switch");
  useRuntimeStore.getState().dropAllForUser();
  /* 旧身份的在途标记作废：那些任务已随 cancelAllRuns 中止，留着只会在切回时误报中断 */
  if (previousScope !== runtimeUserScope) dropScopeMarks(previousScope);
}

/* ================= 在途标记（仅 sessionId/runId/时间，无内容） ================= */

/** 在途标记按用户分仓：A 账户刷新留下的中断标记不能被 B 账户消费掉（P2-5）。
 *  scope 由 resetRuntimeForAccount（store.ts 账户切换钩子）登记。 */
const INFLIGHT_KEY = "mentora:agent:inflight";
let runtimeUserScope = "anon";

/** 在途记录。新记录带 `owner`（写入时的用户 id）——这样**归属可自证**，
 *  不再需要靠键名前缀反推，也不需要把无主键认领给谁。 */
type InflightMap = Record<string, { runId: string; startedAt: number; owner?: string | null }>;

function readInflightMap(): InflightMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(INFLIGHT_KEY);
    return raw ? (JSON.parse(raw) as InflightMap) : {};
  } catch {
    return {};
  }
}

function writeInflightMap(m: InflightMap): void {
  if (typeof window === "undefined") return;
  try {
    const keys = Object.keys(m);
    if (keys.length === 0) window.localStorage.removeItem(INFLIGHT_KEY);
    else window.localStorage.setItem(INFLIGHT_KEY, JSON.stringify(m));
  } catch {
    /* 隐私模式/配额满：标记写不下只影响「刷新后提示中断」，不影响本轮运行 */
  }
}

function scopedKey(sessionId: string): string {
  return `${runtimeUserScope}:${sessionId}`;
}

/** 隔离无归属的旧在途标记（R4，独立复核 2026-11-12 第二轮）。
 *
 *  上一版把没有作用域前缀的旧键**无条件认领**给当前登录用户——这是错的：
 *  旧记录只有 {runId, startedAt}，**没有任何可验证的所有权证据**，认领等于凭空
 *  把别人的会话挂到新用户头上（独立探针实测：预置 `unknown-session` 后首次登录
 *  user-B，markInterruptedOnLoad() 把它返回了）。
 *
 *  正确做法：**不认领**。无依据的键移入隔离区（保留原值以便审计，但不参与
 *  任何用户的「中断提示」），这样既不会误归属，也不丢证据。 */
const QUARANTINE_KEY = "mentora:agent:inflight.quarantine";

function quarantineUnownedMarks(): void {
  const m = readInflightMap();
  const unowned = Object.keys(m).filter((k) => !k.includes(":"));
  if (unowned.length === 0) return;
  let q: Record<string, unknown> = {};
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(QUARANTINE_KEY) : null;
    q = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    q = {};
  }
  for (const k of unowned) {
    /* 隔离记录附上隔离时间，便于审计「这条是什么时候被判为无主的」 */
    q[k] = { ...(m[k] as Record<string, unknown>), quarantinedAt: new Date().toISOString() };
    delete m[k];
  }
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(QUARANTINE_KEY, JSON.stringify(q));
  } catch {
    /* 写不进隔离区也不认领：宁可丢提示，不可错归属 */
  }
  writeInflightMap(m);
}

/** 旧账户的在途标记在切走后作废：那些任务已经随 cancelAllRuns 中止，留着只会
 *  在下次切回时误报「中断」（真实任务早已结束，属于过期标记）。 */
function dropScopeMarks(scope: string): void {
  const m = readInflightMap();
  let changed = false;
  for (const k of Object.keys(m)) {
    if (k.startsWith(`${scope}:`)) {
      delete m[k];
      changed = true;
    }
  }
  if (changed) writeInflightMap(m);
}

function markInflight(sessionId: string, runId: string): void {
  const m = readInflightMap();
  m[scopedKey(sessionId)] = { runId, startedAt: Date.now(), owner: runtimeAccountKey ?? null };
  writeInflightMap(m);
}

function clearInflight(sessionId: string): void {
  const m = readInflightMap();
  const k = scopedKey(sessionId);
  if (k in m) {
    delete m[k];
    writeInflightMap(m);
  }
}

/** 刷新后调用：把「上次还在跑但进程已没了」的会话标成 interrupted。
 *  只标状态，不重放、不伪造已完成，也不删除已保存内容。 */
export function markInterruptedOnLoad(): string[] {
  const m = readInflightMap();
  /* 只取当前用户作用域的条目（键前缀 = scope:）；别的账户的中断标记留给它自己 */
  const ids = Object.keys(m)
    .filter((k) => k.startsWith(`${runtimeUserScope}:`))
    /* 归属自证：带 owner 的记录必须与当前作用域一致；owner 明确是别人的跳过。
     * （键前缀可被手改，owner 是写入时冻结的，两者一起看才可信。） */
    .filter((k) => {
      const rec = m[k];
      if (!rec || rec.owner === undefined) return true; // 旧记录无 owner 字段：键前缀即唯一依据
      return rec.owner === null ? runtimeUserScope === "anon" : rec.owner === runtimeUserScope;
    })
    .map((k) => k.slice(runtimeUserScope.length + 1))
    .filter((sessionId) => !controllers.has(sessionId));
  if (ids.length === 0) return ids;
  const st = useRuntimeStore.getState();
  for (const sid of ids) {
    const stale = m[scopedKey(sid)];
    st.startRun(sid, {
      runId: stale.runId,
      sessionId: sid,
      seq: 1,
      status: "interrupted",
      phase: "answering",
      startedAt: stale.startedAt,
      finishedAt: Date.now(),
      headline: "页面刷新前这个任务没有跑完，已中断——可以重新发送",
      plan: [],
      tools: [],
      phases: [],
      partialAnswer: "",
      pendingActions: [],
    });
  }
  /* R3（独立复核 2026-11-12）：只删**本次消费掉的**当前账户条目，
   * 别的账户的标记必须原样保留（旧实现 writeInflightMap({}) 会把 B 的也清掉，
   * B 登录后再也看不到自己的中断提示）。 */
  const rest = { ...m };
  for (const sid of ids) delete rest[scopedKey(sid)];
  writeInflightMap(rest);
  return ids;
}

/* ================= 过程摘要（真实事件，不编造） ================= */

/* PRD §5.2：没有摘要支持时展示真实执行事件；**只有心跳则说「正在等待模型响应」**。
 * 所以这里不给 thinking 阶段任何「正在理解/正在分析」式的说法——那是用户抱怨的
 * 「空转标签」，也是没有证据的猜测。只有正文真的流出来，才说「正在回答」。 */
const WAITING_LABEL = "正在等待模型响应";

/** 折叠时显示的那一行。来源只能是：工具开始/完成/失败事件、明确的计划步骤、
 *  真实结果摘要、供应商明确给出的摘要；没有证据时老实说「正在等待模型响应」，
 *  绝不为「看起来更懂」而多调一次模型编造思考。 */
export function describeHeadline(run: SessionRun): string {
  if (run.status === "interrupted") return run.headline || "任务已中断";
  if (run.status === "cancelling") return "正在停止…";
  /* 终态用终态文案：run.headline 是最后一次过程事件的摘要（如「正在等待模型响应」），
   * 完成消息若沿用它会挂着一句过期的话（P2-3）。 */
  if (run.status === "cancelled") return "已停止";
  if (run.status === "failed") return run.error ? `任务失败：${run.error}` : "任务失败";
  if (run.status === "partial") return "回答未完整：部分内容已生成";
  if (run.status === "completed") return "回答完成";
  if (run.status === "awaiting_approval") {
    const label = run.pendingActions[0]?.label;
    return label ? `等待你确认：${label}` : "等待你确认操作";
  }

  const curPlan = run.plan.find((p) => p.status === "in_progress");
  if (curPlan?.text) return `正在${curPlan.text}`;

  const running = [...run.tools].reverse().find((t) => t.status === "in_progress");
  if (running) {
    const label = TOOL_LABEL(running.name);
    return running.summary ? `正在${label} · ${running.summary}` : `正在${label}…`;
  }
  const done = [...run.tools].reverse().find((t) => t.status === "completed");
  if (done) {
    const label = TOOL_LABEL(done.name);
    const tail = run.partialAnswer ? "，正在准备回答" : "，继续处理中";
    return done.summary ? `已${label} · ${done.summary}${tail}` : `已${label}${tail}`;
  }
  if (run.partialAnswer.trim()) return "正在回答…";
  return WAITING_LABEL;
}

/** 工具名 → 中文短标签；未知名字原样显示（绝不谎报成一个好看的名字） */
function TOOL_LABEL(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/* 与 protocol.TOOLS 的 label 同源：这里单独取是因为本模块不 import 协议表，
 * 避免 UI 摘要依赖工具注册表的加载顺序（读不到时退回工具名，仍是真的）。
 * 漂移防护：缺项会让状态行显示原始英文 id（「正在manage_workspace…」），
 * 回归锁 agent-tool-labels-sync.test.ts 逐项核对本表覆盖 protocol.TOOLS 的全部工具名。 */
export const TOOL_LABELS: Record<string, string> = {
  /* 复合工具（manage_workspace/manage_goal）此前漏登记，状态行直接显示英文 id */
  manage_workspace: "搭建我的系统",
  manage_goal: "调整学习目标",
  search_brain: "检索笔记",
  read_context: "查看状态",
  get_note: "读笔记",
  list_goals: "列出目标",
  get_goal: "看目标详情",
  list_books: "看书架",
  list_sessions: "列出会话",
  get_settings_public: "读设置",
  make_quiz: "出题",
  web_search: "联网搜索",
  read_url: "读网页",
  save_note: "存笔记",
  update_note: "改笔记",
  delete_note: "删笔记",
  create_goal: "建目标",
  add_book: "加书",
  create_session: "建会话",
  get_session: "看会话",
  manage_session: "管理会话",
  forge_persona: "塑造人物",
  run_discussion: "发起讨论",
  set_participants: "调整阵容",
  update_settings: "改设置",
  resume_workflow: "恢复进度",
  regenerate_phase: "重排阶段",
  edit_phase: "编辑计划",
  update_plan_resources: "重出资源",
  get_book: "看书详情",
  record_book_assessment: "记验收",
  rebuild_reading_route: "重排路线",
  update_book: "改书目",
  remove_book: "删书",
  restore_book_route: "恢复路线",
  edit_book_goal: "改阅读目标",
  set_reading_progress: "更新进度",
  move_chapter: "调顺序",
  save_reading_deposit: "存沉淀",
  link_notes: "关联笔记",
  review_queue: "复习队列",
  memory: "长期记忆",
  reminders: "定时提醒",
};

/** 过程步骤的来源标注（PRD §5.2 要求标明来源类别） */
export const STEP_SOURCE_LABEL: Record<StepSource, string> = {
  tool_event: "工具事件",
  plan: "执行计划",
  result_summary: "结果摘要",
  waiting: "等待中",
};

/** 由真实事件重建轨迹阶段与耗时（AgentTrace 用；刷新/终态后可再次展开） */
export function tracePhasesOf(run: SessionRun): TracePhase[] {
  const d = (from: number, to: number) => Math.max(0, to - from);
  const end = run.finishedAt ?? Date.now();
  const cancelled = run.status === "cancelled" || run.status === "cancelling";
  const live = isInFlight(run.status);
  const firstInsight = run.firstDeltaAt ?? run.firstToolAt;

  const phases: TracePhase[] = [
    {
      label: "思考",
      state: cancelled && !firstInsight ? "cancelled" : firstInsight ? "done" : live ? "running" : "done",
      durationMs: firstInsight ? d(run.startedAt, firstInsight) : undefined,
    },
  ];

  if (run.tools.length > 0) {
    const toolStart = run.firstToolAt ?? run.startedAt;
    const toolEnd = run.tools.reduce((m, t) => (t.endedAt ? Math.max(m, t.endedAt) : m), toolStart);
    const allSettled = run.tools.every((t) => t.status !== "in_progress");
    phases.push({
      label: `${run.tools.length} 个步骤`,
      state: run.tools.some((t) => t.status === "failed")
        ? "failed"
        : cancelled && !allSettled
          ? "cancelled"
          : allSettled
            ? "done"
            : "running",
      durationMs: allSettled ? d(toolStart, toolEnd) : undefined,
    });
  }

  phases.push({
    label: "回答中",
    state:
      run.status === "failed"
        ? "failed"
        : cancelled
          ? "cancelled"
          : run.status === "completed" || run.status === "partial"
            ? "done"
            : run.partialAnswer || run.phase === "answering"
              ? "running"
              : "pending",
    durationMs:
      run.status === "completed" || run.status === "partial"
        ? d(run.firstDeltaAt ?? run.startedAt, end)
        : undefined,
  });

  return phases;
}

/* ================= 选择器 ================= */

/* 说明：不提供 useSessionView/Draft/Attachment 选择器——组件按字段分别订阅，
 * 避免一个粗粒度选择器让无关字段变化也触发重渲染。 */
