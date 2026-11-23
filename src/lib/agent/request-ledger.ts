"use client";

/* 请求账本 v2（独立复核第二轮 E1 要求重做）
 *
 * v1 的四个缺陷（复核逐条指出）：
 *  1. 只记浏览器 API 请求，**看不到服务端对上游的重试** —— route.ts 的 MAX_ATTEMPTS
 *     循环里一次 API 请求可能产生多次 provider 尝试，v1 的「48 次上限」形同虚设；
 *  2. 计数只存内存，**脚本重启/页面刷新即归零**，跨脚本无法累计；
 *  3. 关联靠「最近一个未结束的请求」猜 —— 并发/重试时必然错配；
 *  4. 没有 batchId，多轮跑批的记录混在一起，无法说清「这 32 次属于哪一批」。
 *
 * v2 的设计：
 *  - **provider 层记账**：由服务端在真正发往上游前登记，客户端只做展示与预算闸门；
 *    API 请求数与 provider 请求数分开计。
 *  - **稳定 batchId**：写入 localStorage，跨重启/刷新持续累计；换批次必须显式开新批。
 *  - **显式关联**：每条记录带 batchId / caseId / attemptId / runId / sessionId，
 *    不靠下标或「最近一个」猜。
 *  - **预算口径的当前真相（勿再按旧注释理解）**：生产代码里唯一的记账写入方是
 *    runner.chat() 与 phase-regen 的 **provider 层**（layer:"provider"）。
 *    `layer:"browser"` 目前**没有任何生产写入方**，所以 apiUsed 恒为 0、apiLimit 分支
 *    是前向保留（不是当前生效的第二道闸）；真正在拦请求的只有 providerLimit。
 *    要恢复「双口径」，必须先在客户端 /api/chat 调用处补 browser 层记账。
 *  - **批次自动滚动**：隐式批次（purpose === "other"，即生产主对话）超过
 *    BATCH_TTL_MS 自动开新批——否则 localStorage 里的累计记录永不归零，
 *    用户用满 48 次后整条主对话链路对该浏览器档案永久不可用。
 *    显式 startNewBatch/configureBudget 的跑批批次不自动滚动（换批仍须显式）。
 */

export type UsageSource = "provider" | "estimated" | "unknown";

export interface RequestRecord {
  id: string;
  /** 稳定批次 id（跨重启累计的依据） */
  batchId: string;
  /** 用例归属（Q01… 或 plan-edit），便于逐题核账 */
  caseId?: string;
  /** 同一 caseId 的第几次尝试（补跑时递增） */
  attemptId?: number;
  userId: string | null;
  sessionId: string;
  runId: string;
  /** browser = 浏览器发出的 /api/chat；provider = 服务端真正发往上游的一次尝试 */
  layer: "browser" | "provider";
  task: string;
  round: number;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  error?: string;
  retryOf?: string;
  /** provider 层第几次尝试（1 起；>1 = 上游重试） */
  providerAttempt?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  usageSource: UsageSource;
}

export interface LedgerBudget {
  /** 浏览器 API 请求上限（一个 API 请求可含多次 provider 尝试） */
  apiLimit: number;
  /** 真正发往 provider 的请求上限 —— 这才是花钱的口径 */
  providerLimit: number;
  purpose: string;
}

interface LedgerState {
  batchId: string;
  /** 本批开始时刻（隐式批次自动滚动的依据） */
  batchStartedAt: number;
  budget: LedgerBudget;
  records: RequestRecord[];
  rejected: number;
}

const BATCH_KEY = "mentora:agent:ledger.batch";
const STATE_KEY = "mentora:agent:ledger.state";
/** 隐式批次（生产主对话）的存活时长：到期自动开新批，见文件头「批次自动滚动」。
 *  12 小时 ≈ 一次使用窗口，既不会在一次对话中途把已花预算清零，也不会让档案永久停摆。 */
const BATCH_TTL_MS = 12 * 60 * 60 * 1000;

function readPersisted(): { batchId: string; batchStartedAt: number; records: RequestRecord[]; rejected: number } {
  const fallback = { batchId: "", batchStartedAt: 0, records: [] as RequestRecord[], rejected: 0 };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (!raw) return fallback;
    const j = JSON.parse(raw) as { batchId?: string; batchStartedAt?: number; records?: RequestRecord[]; rejected?: number };
    const records = Array.isArray(j.records) ? j.records : [];
    /* 旧数据没有 batchStartedAt：用最早一条记录的 startedAt 近似批次起点，
     * 这样「早已耗尽且长期不用的档案」第一次加载就能滚进新批，而不是从今天重新数 12 小时。 */
    const earliest = records.reduce(
      (m, r) => (typeof r.startedAt === "number" && r.startedAt < m ? r.startedAt : m),
      Number.POSITIVE_INFINITY
    );
    return {
      batchId: typeof j.batchId === "string" ? j.batchId : "",
      batchStartedAt: typeof j.batchStartedAt === "number" ? j.batchStartedAt : Number.isFinite(earliest) ? earliest : 0,
      records,
      rejected: typeof j.rejected === "number" ? j.rejected : 0,
    };
  } catch {
    return fallback;
  }
}

function persist(s: LedgerState): void {
  if (typeof window === "undefined") return;
  try {
    const records = s.records.slice(-400); // 核账用，不是永久日志
    window.localStorage.setItem(
      STATE_KEY,
      JSON.stringify({ batchId: s.batchId, batchStartedAt: s.batchStartedAt, records, rejected: s.rejected })
    );
  } catch {
    /* 配额满/隐私模式：内存里仍计数，只是刷新后不续 */
  }
}

function initialBatchId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem(BATCH_KEY);
    if (existing) return existing;
    const fresh = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    window.localStorage.setItem(BATCH_KEY, fresh);
    return fresh;
  } catch {
    return `b_${Date.now().toString(36)}`;
  }
}

const persisted = readPersisted();
const state: LedgerState = {
  batchId: persisted.batchId || initialBatchId(),
  batchStartedAt: persisted.batchStartedAt || Date.now(),
  budget: { apiLimit: 48, providerLimit: 48, purpose: "other" },
  records: persisted.records,
  rejected: persisted.rejected,
};

/** 隐式批次（生产主对话）到期自动开新批：清空计数与记录，换新 batchId。
 *  只在 purpose === "other"（默认值，生产代码从不 configureBudget）时生效，
 *  显式跑批批次由调用方自己 startNewBatch 控制，不在这里被动重置。 */
function rolloverIfStale(): void {
  if (state.budget.purpose !== "other") return;
  if (Date.now() - state.batchStartedAt < BATCH_TTL_MS) return;
  state.batchId = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  state.batchStartedAt = Date.now();
  state.records = [];
  state.rejected = 0;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(BATCH_KEY, state.batchId);
    } catch {
      /* 写不进不影响内存计数 */
    }
  }
  persist(state);
}

/** 开新批次（跑批前显式调用）：换批次 = 新计数起点，旧记录不再计入新批次预算。 */
export function startNewBatch(purpose: string): string {
  state.batchId = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  state.batchStartedAt = Date.now();
  state.records = [];
  state.rejected = 0;
  state.budget = { ...state.budget, purpose };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(BATCH_KEY, state.batchId);
    } catch {
      /* 写不进不影响内存计数 */
    }
  }
  persist(state);
  return state.batchId;
}

export function currentBatchId(): string {
  rolloverIfStale();
  return state.batchId;
}

/** 设定本批预算（apiLimit 与 providerLimit 分开；provider 才是花钱口径）。 */
export function configureBudget(apiLimit: number, providerLimit: number, purpose: string): void {
  state.budget = {
    apiLimit: Math.max(1, Math.floor(apiLimit)),
    providerLimit: Math.max(1, Math.floor(providerLimit)),
    purpose,
  };
  persist(state);
}

export function budgetSnapshot() {
  rolloverIfStale();
  const api = state.records.filter((r) => r.layer === "browser").length;
  const provider = state.records.filter((r) => r.layer === "provider").length;
  return {
    ...state.budget,
    batchId: state.batchId,
    apiUsed: api,
    providerUsed: provider,
    apiRemaining: Math.max(0, state.budget.apiLimit - api),
    providerRemaining: Math.max(0, state.budget.providerLimit - provider),
    rejected: state.rejected,
  };
}

export function requestRecords(): RequestRecord[] {
  return state.records.map((r) => ({ ...r }));
}

export function resetLedger(): void {
  state.records = [];
  state.rejected = 0;
  state.batchStartedAt = Date.now();
  persist(state);
}

export interface BeginMeta {
  caseId?: string;
  attemptId?: number;
  userId: string | null;
  sessionId: string;
  runId: string;
  layer: "browser" | "provider";
  task: string;
  round: number;
  retryOf?: string;
  providerAttempt?: number;
}

/** 预算闸门：**provider 口径**才是花钱那条；API 口径只防刷。
 *  按调用层各查各的口径（provider 请求不该被 browser 额度挡、反之亦然）——
 *  此前入参被 `void meta` 丢弃，两层闸门对任何调用都同时生效，语义含混。
 *  注意：`userId/sessionId/runId/task` 目前**不参与**预算判定（没有按用户/任务的
 *  预算模型），参数仅保留以记录调用归属，别把它们当成已生效的预算维度。 */
export function checkBudget(
  meta: Pick<BeginMeta, "layer" | "userId" | "sessionId" | "runId" | "task">
): { ok: true } | { ok: false; reason: string } {
  const snap = budgetSnapshot();
  if (meta.layer === "browser") {
    if (snap.apiUsed >= snap.apiLimit) {
      state.rejected += 1;
      persist(state);
      return {
        ok: false,
        reason: `本批浏览器请求已达上限（${snap.apiLimit} 次，批次 ${snap.batchId}）——已停止继续调用。已获得的结果都已保存。`,
      };
    }
    return { ok: true };
  }
  if (snap.providerUsed >= snap.providerLimit) {
    state.rejected += 1;
    persist(state);
    return {
      ok: false,
      reason: `本批真实模型请求已达上限（provider ${snap.providerLimit} 次，批次 ${snap.batchId}，用途 ${snap.purpose}）——为控制花费已停止继续调用。已获得的结果都已保存。`,
    };
  }
  return { ok: true };
}

export function beginRequest(meta: BeginMeta): RequestRecord {
  /* 与 checkBudget 同口径：隐式批次到期先滚动，避免「闸门放行后记账落进旧批」 */
  rolloverIfStale();
  const rec: RequestRecord = {
    id: `rq_${state.records.length + 1}`,
    batchId: state.batchId,
    caseId: meta.caseId,
    attemptId: meta.attemptId,
    userId: meta.userId,
    sessionId: meta.sessionId,
    runId: meta.runId,
    layer: meta.layer,
    task: meta.task,
    round: meta.round,
    startedAt: Date.now(),
    retryOf: meta.retryOf,
    providerAttempt: meta.providerAttempt,
    usageSource: "unknown",
  };
  state.records.push(rec);
  persist(state);
  return rec;
}

export function endRequest(
  id: string,
  patch: {
    ok: boolean;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    usageSource?: UsageSource;
  }
): void {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
  rec.endedAt = Date.now();
  rec.ok = patch.ok;
  rec.error = patch.error;
  if (patch.inputTokens != null) rec.inputTokens = patch.inputTokens;
  if (patch.outputTokens != null) rec.outputTokens = patch.outputTokens;
  if (patch.cachedTokens != null) rec.cachedTokens = patch.cachedTokens;
  rec.usageSource = patch.usageSource ?? (patch.inputTokens != null || patch.outputTokens != null ? "provider" : "unknown");
  persist(state);
}

/** 按 layer/task/caseId 汇总。缺 usage 的单独计 unknown，不并进 0。 */
export function ledgerSummary() {
  const bucket = (keyOf: (r: RequestRecord) => string) => {
    const m = new Map<string, { requests: number; input: number; output: number; unknownUsage: number; failed: number }>();
    for (const r of state.records) {
      const k = keyOf(r);
      const cur = m.get(k) ?? { requests: 0, input: 0, output: 0, unknownUsage: 0, failed: 0 };
      cur.requests += 1;
      if (r.usageSource === "unknown") cur.unknownUsage += 1;
      else {
        cur.input += r.inputTokens ?? 0;
        cur.output += r.outputTokens ?? 0;
      }
      if (r.ok === false) cur.failed += 1;
      m.set(k, cur);
    }
    return Object.fromEntries(m);
  };
  return {
    batchId: state.batchId,
    budget: budgetSnapshot(),
    totalRecords: state.records.length,
    byLayer: bucket((r) => r.layer),
    byTask: bucket((r) => r.task),
    byCase: bucket((r) => r.caseId ?? "(none)"),
    records: requestRecords(),
  };
}

/* 仅开发环境：账本挂到 window 供验收脚本读取/导出（生产不暴露）。 */
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __mentoraLedger?: unknown }).__mentoraLedger = {
    summary: ledgerSummary,
    budget: budgetSnapshot,
    reset: resetLedger,
    configure: configureBudget,
    newBatch: startNewBatch,
    batchId: currentBatchId,
  };
}
