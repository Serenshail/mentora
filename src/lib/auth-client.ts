"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useAppStore, setStoreUser } from "@/lib/store";
import { businessFingerprint, hasFilesMissingFromCloud, decideSyncAction, isSelfAcknowledgedUpload, shouldBlockAutoPush } from "@/lib/sync-decision";
import { decideReceiptRealign, shouldClearDirty, type ConflictPayload } from "@/lib/sync-receipt";
import { downloadJson } from "@/lib/utils";

export type MemberStatus = "legacy" | "active" | "expiring" | "expired";

export interface Entitlement {
  status: MemberStatus;
  plan: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
}

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
  plan?: string;
  planExpiresAt?: string;
  entitlement?: Entitlement;
}

const CHOICE_KEY = "mentora-sync-choice";
const syncChoiceKey = () => {
  const owner = useAppStore.getState()._storeUserId;
  return owner ? `${CHOICE_KEY}:${owner}` : CHOICE_KEY;
};
const dirtyKey = () => syncChoiceKey() + ":dirty";
const recentUploadsKey = () => syncChoiceKey() + ":uploads";
type UploadReceipt = { id: string; edit: number };
function localEditVersion(marker: string | null): number {
  return Number(marker?.split(":")[0]) || 0;
}
function recentUploads(): UploadReceipt[] {
  try {
    const receipts: unknown = JSON.parse(sessionStorage.getItem(recentUploadsKey()) ?? "[]");
    return Array.isArray(receipts) ? receipts.filter((item): item is UploadReceipt =>
      typeof item?.id === "string" && typeof item?.edit === "number") : [];
  } catch { return []; }
}

function rememberUpload(marker: string | null): string {
  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    sessionStorage.setItem(recentUploadsKey(), JSON.stringify([...recentUploads().slice(-7), { id, edit: localEditVersion(marker) }]));
  }
  catch { /* Without a local upload receipt, mismatched versions stay protected. */ }
  return id;
}

function acknowledgedUpload(cloud: PullCloudResult): boolean {
  if (cloud.status !== "ok") return false;
  return isSelfAcknowledgedUpload({
    cloudStatus: cloud.status,
    cloudUploadId: cloud.uploadId,
    receipts: recentUploads(),
    currentEdit: localEditVersion(readLocalEditMarker()),
    cloudData: cloud.data,
    localData: localData() as unknown as Record<string, unknown>,
  });
}

function readLocalEditMarker(): string | null {
  try { return localStorage.getItem(dirtyKey()); } catch { return null; }
}

function markLocalEdit() {
  try {
    const edit = Math.max(Date.now(), localEditVersion(readLocalEditMarker()) + 1);
    localStorage.setItem(dirtyKey(), `${edit}:${Math.random().toString(36).slice(2)}`);
  }
  catch { /* Local storage can be disabled. */ }
}

let applyingCloudSnapshot = false;
function applyCloudSnapshot(data: unknown): boolean {
  applyingCloudSnapshot = true;
  try { return useAppStore.getState().importData(data); }
  finally { applyingCloudSnapshot = false; }
}

function hasLegacyUnattributedWatermark(): boolean {
  try { return syncChoiceKey() !== CHOICE_KEY && localStorage.getItem(syncChoiceKey()) === null && localStorage.getItem(CHOICE_KEY) !== null; }
  catch { return true; }
}

/** 本机上次成功推送/拉取时记下的服务端 updatedAt（毫秒；0 = 从未同步/不可读）。
 *  设置页「从云端恢复」据此判断云端快照是否比本机旧，避免静默覆盖离线期间的改动。 */
export function getSyncWatermarkTs(): number {
  return Date.parse(getSyncWatermark() ?? "") || 0;
}

function getSyncWatermark(): string | undefined {
  try {
    return localStorage.getItem(syncChoiceKey()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** 手动恢复云端快照后对齐水位：否则 bootSync 会拿同一条快照再覆盖一次（幂等但多余）。 */
export function markSyncWatermark(updatedAt: string, opts: { clearDirty?: boolean } = {}) {
  try {
    localStorage.setItem(syncChoiceKey(), updatedAt || new Date().toISOString());
    if (opts.clearDirty !== false) localStorage.removeItem(dirtyKey());
  } catch {
    /* 配额满忽略 */
  }
}

/* 云端同步的可见状态：让"自动同步"从一句静态文案变成可感知的反馈（保存中/已同步/失败） */
export type SyncStatus = "idle" | "saving" | "saved" | "error" | "conflict";
export const useSyncStatus = create<{ status: SyncStatus }>(() => ({ status: "idle" }));
export const setSyncStatus = (status: SyncStatus) => useSyncStatus.setState({ status });

/* ---------------- 认证状态（全局单例：所有组件共享同一份） ---------------- */

let initialized = false;

interface AuthStore {
  user: AuthUser | null;
  checking: boolean;
  /** /api/auth/me 探测本身失败（网络抖动/5xx/超时）：与「确定未登录」是两回事。
   *  旧实现 catch 里一律置 user:null——已登录用户在慢网/函数冷启动>5s/瞬时 5xx 时
   *  会被静默甩进营销落地页，无错误提示也无重试入口。 */
  probeFailed: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string, password: string, name: string, inviteCode: string, refCode?: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; avatar?: string | null }) => Promise<AuthUser>;
  redeem: (code: string) => Promise<Entitlement>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  checking: true,
  probeFailed: false,

  login: async (email, password) => {
    /* 30s 硬超时：反代/连接挂起时不能把 busy 锁死整张登录表单（logout 8s / me 5s 同族先例，
     * 放宽到 30s 是因为服务端 db 层 withRetry 最坏 ≈4×5s 超时+退避 ≈22s，不能误杀慢而成功的请求） */
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || "登录失败");
    set({ user: j.user, probeFailed: false });
    // 切换到该账号的专属仓（同步加载，内存状态随之替换为该账号的数据或空仓）
    setStoreUser(j.user.userId);
    return j.user as AuthUser;
  },

  register: async (email, password, name, inviteCode, refCode) => {
    /* 同 login：30s 硬超时兜底（注册链路还有 DNS 取证/占码/写库，同样不能误杀慢请求） */
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, inviteCode, refCode }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || "注册失败");
    set({ user: j.user, probeFailed: false });
    setStoreUser(j.user.userId);
    return j.user as AuthUser;
  },

  logout: async () => {
    /* 登出要区分结果：断网/服务端 500 时 Set-Cookie 没送到，本地却切了登出 UI——
     * 刷新就被 /api/auth/me「登回」，用户以为幽灵登录。这里把失败原样抛出，
     * 调用方负责提示；本地的登出状态照常切换（不回滚用户操作）。 */
    let ok = false;
    let msg = "";
    try {
      const res = await fetch("/api/auth/logout", { method: "POST", signal: AbortSignal.timeout(8000) });
      ok = res.ok;
      if (!ok) msg = `退出登录未在服务端生效（${res.status}）`;
    } catch {
      msg = "网络异常，退出登录未在服务端生效";
    }
    set({ user: null, probeFailed: false }); // 主动登出≠探测失败：回到确定未登录态（落地页正常渲染）
    // 只切回匿名仓（内存状态同步替换），绝不 clear 用户仓——
    // 曾经的 clearLocalStore 先于切仓执行，会把空状态写进用户仓导致本地快照被毁
    setStoreUser(null);
    try { localStorage.removeItem(CHOICE_KEY); } catch { /* Logout must work even when browser storage is unavailable. */ }
    setSyncStatus("idle");
    if (!ok) throw new Error(msg);
  },

  updateProfile: async (patch) => {
    const owner = useAuthStore.getState().user?.userId;
    const res = await fetch("/api/auth/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || "保存失败");
    if (useAuthStore.getState().user?.userId !== owner || j.user?.userId !== owner) throw new Error("账户已切换，请在当前账户重新操作");
    set({ user: j.user });
    return j.user as AuthUser;
  },

  /** 续费：成功后就地更新权益，横幅/会员页立刻反映新到期日 */
  redeem: async (code) => {
    const owner = useAuthStore.getState().user?.userId;
    const res = await fetch("/api/subscription/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || "兑换失败");
    const entitlement = j.entitlement as Entitlement;
    const cur = useAuthStore.getState().user;
    if (cur?.userId !== owner) throw new Error("账户已切换，请在当前账户查看会员状态");
    if (cur) {
      useAuthStore.setState({
        user: { ...cur, entitlement, ...(entitlement.expiresAt ? { planExpiresAt: entitlement.expiresAt } : {}) },
      });
    }
    return entitlement;
  },
}));

/** 探测一次会话（useAuth 挂载 / retryAuthProbe 重试共用）。
 *  探测失败（catch）与「确定未登录」必须区分：失败置 probeFailed，
 *  页面据此显示错误+重试态，而不是把已登录用户静默当成游客。 */
async function runAuthProbe(): Promise<void> {
  try {
    const res = await fetch("/api/auth/me", {
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error("暂时无法确认登录状态");
    const j = await res.json();
    const user = j.user ?? null;
    useAuthStore.setState({ user, probeFailed: false });
    // 与当前仓不一致时切仓（setStoreUser 同步加载，无竞态、无破坏性清空）
    const target = user?.userId ?? null;
    if (useAppStore.getState()._storeUserId !== target) {
      setStoreUser(target);
    }
    // 刷新/新开页面即与云端对齐,不必重新登录才恢复数据
    if (user) void bootSync();
  } catch {
    useAuthStore.setState({ probeFailed: true });
  } finally {
    useAuthStore.setState({ checking: false });
  }
}

/** 探测失败后的手动重试入口（首页错误态按钮）：绕过一次性 initialized 门再探测一次 */
export function retryAuthProbe(): void {
  useAuthStore.setState({ checking: true });
  void runAuthProbe();
}

/** 挂载时校验会话；全局只发一次请求，登录后所有页面同步看到 */
export function useAuth() {
  const store = useAuthStore();
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    void runAuthProbe();
  }, []);
  return store;
}

/* ---------------- 云端同步（大负载 gzip 信封，绕开 Vercel 4.5MB body 限制） ---------------- */

const GZIP_THRESHOLD = 1024 * 1024; // 超过 1MB 走 gzip

async function gzipBytes(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf) as Uint8Array<ArrayBuffer>;
}

async function gunzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function localData() {
  const s = useAppStore.getState();
  return {
    goals: s.goals,
    knowledge: s.knowledge,
    folders: s.folders,
    books: s.books,
    sessions: s.sessions,
    customPersonas: s.customPersonas,
    /* v27：主对话多会话入云（修 AUDIT-V26.1 C2「换设备丢主对话」）。
     * 当前活跃会话指针不同步——UI 焦点状态跨端回写会拽动视图（v26.1.5 教训）。 */
    agentSessions: s.agentSessions ?? [],
    settings: { ...s.settings, apiKey: "" },
  };
}

export function downloadLocalBackup() {
  const exportedAt = new Date().toISOString();
  downloadJson(`mentora-backup-${exportedAt.slice(0, 10)}.json`, { exportedAt, ...localData() });
}

function hasLocalData() {
  const s = useAppStore.getState();
  /* 只有自定义智能体的用户登录后也能触发上传/回推（与 cloudHasData 同口径）。
   *
   * **空会话不算数据**（2026-11-12 第二轮复核抓到的真实数据丢失）：
   * agent-home 挂载时会保证「总有一个当前会话」（草稿/运行态要挂靠），于是本地会存在
   * `sessions=1` 但 `messages=[]` 的空壳。旧实现把 `agentSessions.length > 0` 当成
   * 「本地有数据」，bootSync 因此判定「云端空 & 本地有 → 推送本地」或「本地有 → 不拉云端」，
   * 结果切回账户时**真正的历史永远不回来**，界面上只剩一个空对话。
   * 现在只数「至少有一条消息的会话」。 */
  const nonEmptyAgentSessions = (s.agentSessions ?? []).filter((x) => (x.messages?.length ?? 0) > 0).length;
  /* 全字段 ?? [] 容错（与 agentSessions 同款）：pushOnce 空仓闸门让本函数新增了推送热路径
   * 上的调用方，AppState 各字段在真实运行时恒为数组，但部分行为锁测试的 store mock 只备齐
   * 其用到的字段——读数防御，不改变语义。 */
  return (
    (s.goals ?? []).length +
      (s.knowledge ?? []).length +
      (s.folders ?? []).length +
      (s.books ?? []).length +
      (s.sessions ?? []).length +
      (s.customPersonas ?? []).length +
      nonEmptyAgentSessions >
    0
  );
}

/* 拉取结果必须三态：ok / empty / error。
 * 旧实现把 401/503/网络失败折叠成与「云端没有数据」同一个 null——消费端据此
 * 判定「云端为空 → 把本地推上去」，一次 KV 抖动就能让登录后的同步用旧本地
 * 覆盖云端活动快照。 */
export type PullCloudResult =
  | { status: "ok"; data: Record<string, unknown>; updatedAt: string; uploadId?: string }
  | { status: "empty" }
  | { status: "error"; message: string };

export async function pullCloud(): Promise<PullCloudResult> {
  const owner = useAppStore.getState()._storeUserId;
  try {
    const res = await fetch("/api/sync", { cache: "no-store", signal: AbortSignal.timeout(30_000), headers: owner ? { "x-mentora-user-id": owner } : {} });
    if (!res.ok) return { status: "error", message: `云端请求失败（${res.status}）` };
    let j: { data: Record<string, unknown> | null; updatedAt?: string; uploadId?: string };
    if (res.headers.get("content-type")?.includes("application/x-gzip")) {
      const text = await gunzipBytes(new Uint8Array(await res.arrayBuffer()));
      j = JSON.parse(text);
    } else j = await res.json();
    return j.data ? { status: "ok", data: j.data, updatedAt: j.updatedAt ?? "", ...(j.uploadId ? { uploadId: j.uploadId } : {}) } : { status: "empty" };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "网络异常" };
  }
}

/** 推送本地数据到云端。带重试+退避；keepalive 用于关页/刷新前的兜底 flush（数据丢失根治的一环）。 */
/** 推送串行化（在途互斥）。
 *  入口有三处会同时发：2.5s 防抖自动推、关页 keepalive flush、开机/登录对齐。
 *  并发推送时旧快照可能后到成为云端 HEAD（服务端 last-write-wins 并自盖 updatedAt），
 *  其他设备按「云端更新」拉回旧数据。串行执行：后一个请求自己会重新读一次本地数据，
 *  所以排队不会丢最新改动，只是多一次请求。 */
/* 推送 fetch 的硬超时：此前三种 doFetch 变体都是无 signal 的裸 fetch。
 * 推送经 withPushLock 串行化，pushChain 在 fn() settle 前不 release——一次 TCP 半开/
 * 弱网停滞的请求永不 settle，release 就永不执行，后续所有 pushCloud（2.5s 防抖自动推、
 * pagehide/visibilitychange 的 keepalive flush）永久排队挂死，关页前的最新编辑发不出去，
 * 同步态也永远停在 saving。服务端 POST /api/sync 的 maxDuration=60，客户端取同量级上限：
 * 超过服务端时限的请求本来就不可能成功。 */
const SYNC_FETCH_TIMEOUT_MS = 60_000;
/* keepalive flush 只是关页兜底：页面已隐藏/正在卸载，不值得再占住串行队列 60s，
 * 10s 没响应就放弃（服务端每次覆盖前都归档了上一份快照，仍有回捞点）。 */
const SYNC_KEEPALIVE_TIMEOUT_MS = 10_000;
/* 一次 pushOnce（含 retries=2 的三次尝试）的总预算：单次 60s×3 会把队列占住三分钟，
 * 这里封顶 75s（一次满额尝试 + 一次短追加重试），队列等待时间因此有确定上界。 */
const SYNC_PUSH_BUDGET_MS = 75_000;

let pushChain: Promise<unknown> = Promise.resolve();
async function withPushLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = pushChain;
  let release!: () => void;
  pushChain = new Promise<void>((r) => (release = r));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

type PushOptions = { keepalive?: boolean; retries?: number; baseVersion?: string | null; realignAttempt?: boolean; allowDuringConflict?: boolean };

export async function pushCloud(opts: PushOptions = {}): Promise<boolean> {
  const owner = useAppStore.getState()._storeUserId;
  return withPushLock(() => owner === useAppStore.getState()._storeUserId ? pushOnce(opts) : Promise.resolve(false));
}

async function pushOnce(opts: PushOptions): Promise<boolean> {
  /* QA-00（P0）：冲突未处理时禁止任何自动/保活推送。
   * 否则失败方刷新前的 pagehide keepalive 会把它的本地快照覆盖到云端，把真实冲突降级成可自动覆盖。 */
  if (shouldBlockAutoPush(useSyncStatus.getState().status, opts)) return false;
  const owner = useAppStore.getState()._storeUserId;
  const owns = () => owner === useAppStore.getState()._storeUserId;
  const { keepalive = false, retries = keepalive ? 0 : 2, baseVersion = getSyncWatermark() } = opts;
  const sentEditMarker = readLocalEditMarker();
  const text = JSON.stringify({ data: localData(), baseVersion, uploadId: rememberUpload(sentEditMarker) });
  // 浏览器对 keepalive 请求体硬限 64KiB（按 UTF-8 字节计）：text.length 是 UTF-16 码元数，
  // 纯中文每字 3 字节，约 2.2 万字就撞 65536 字节上限——必须按字节估。否则这档体量被
  // 放行后 fetch 当场被浏览器 reject（keepalive 无重试）→ 误报 error，flush 保护静默失效。
  // 留 60_000 字节安全余量（<64KiB），跳过白发，交给常规 2.5s 防抖推送兜底。
  if (keepalive && new Blob([text]).size > 60_000) return false;
  setSyncStatus("saving");
  /* 本次 pushOnce 的总预算（含全部重试）：队列等待时间因此有确定上界，
   * 挂起请求最多占住 withPushLock 这么久，后续 2.5s 防抖推送与关页 flush 都能接着跑。 */
  const perAttempt = keepalive ? SYNC_KEEPALIVE_TIMEOUT_MS : SYNC_FETCH_TIMEOUT_MS;
  const deadline = Date.now() + (keepalive ? SYNC_KEEPALIVE_TIMEOUT_MS : SYNC_PUSH_BUDGET_MS);
  /* 剩余预算内取单次上限：最后一次尝试不会拿到超过 deadline 的等待窗口。 */
  const attemptInit = (init: RequestInit): RequestInit => {
    if (!owns()) throw new Error("同步账户已切换");
    return { ...init, headers: { ...init.headers, ...(owner ? { "x-mentora-user-id": owner } : {}) },
      signal: AbortSignal.timeout(Math.max(1, Math.min(perAttempt, deadline - Date.now()))) };
  };
  const doFetch = (): Promise<Response> => {
    if (text.length > GZIP_THRESHOLD) {
      // keepalive 与 gzip 异步压缩不兼容：flush 场景若超大则降级为不压缩直传（仍可能超 4.5MB,失败则报错提示导出）
      if (keepalive) {
        return fetch(
          "/api/sync",
          attemptInit({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: text,
            keepalive: true,
          })
        );
      }
      return gzipBytes(text).then((gz) =>
        fetch(
          "/api/sync",
          attemptInit({
            method: "POST",
            headers: { "Content-Type": "application/x-gzip" },
            body: gz.buffer as ArrayBuffer,
          })
        )
      );
    }
    return fetch(
      "/api/sync",
      attemptInit({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
        keepalive: keepalive || undefined,
      })
    );
  };

  let ok = false;
  let conflict = false;
  let conflictPayload: ConflictPayload | null = null;
  let serverTs = "";
  for (let attempt = 0; attempt <= retries && !ok; attempt++) {
    // 预算烧完就不再起新尝试：超时本身已经在 catch 里置 ok=false，这里只是不再追加等待
    if (Date.now() >= deadline) break;
    try {
      const res = await doFetch();
      if (!owns()) return false;
      ok = res.ok;
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as ConflictPayload | null;
        conflict = body?.conflict === true;
        conflictPayload = body;
      }
      // Authentication, conflicts and invalid payloads require action, not identical retries.
      if (!ok && res.status >= 400 && res.status < 500 && res.status !== 429) break;
      if (ok) {
        /* 用**服务端** updatedAt 记本地同步水位：客户端时钟快/慢都会让 bootSync 误判，
         * 刷新时就会把“还没带今日讲义”的云快照拉回来覆盖本地。 */
        const j = (await res.json().catch(() => null)) as { updatedAt?: string } | null;
        if (j && typeof j.updatedAt === "string") serverTs = j.updatedAt;
      }
    } catch {
      ok = false;
    }
    if (!ok && attempt < retries) {
      const wait = 800 * 2 ** attempt;
      // 退避后再试也超出预算：直接收尾，不把锁多占 0.8-1.6s
      if (Date.now() + wait >= deadline) break;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  /* 丢回执恢复：409 的 currentUploadId 命中本机回执时，对齐水位并重推一次。
   * 三条保护由 decideReceiptRealign 统一判定；重推期间的新编辑靠 sentEditMarker 比对保留 dirty。 */
  if (!ok && conflict && conflictPayload && !keepalive && !opts.realignAttempt) {
    const decision = decideReceiptRealign({
      conflict: conflictPayload,
      receipts: recentUploads(),
      accountId: owner ?? "",
      currentEdit: localEditVersion(readLocalEditMarker()),
    });
    if (decision.realign) {
      markSyncWatermark(decision.version, { clearDirty: false });
      if (decision.push && owns()) {
        return pushOnce({ ...opts, baseVersion: decision.version, retries: 0, realignAttempt: true });
      }
      if (owns()) setSyncStatus("saved");
      return true;
    }
  }
  if (ok) {
    if (!owns()) return false;
    try {
      localStorage.setItem(syncChoiceKey(), serverTs || new Date().toISOString());
      if (shouldClearDirty(sentEditMarker, readLocalEditMarker())) localStorage.removeItem(dirtyKey());
    } catch { /* 配额满忽略 */ }
    setSyncStatus("saved");
    return true;
  }
  if (owns()) setSyncStatus(conflict ? "conflict" : "error");
  return false;
}

/** 关页/切后台前把内存数据强制 flush 到云端,防"没推上去就关了"导致丢失 */
export function useFlushOnHide(enabled: boolean) {
  const owner = useAuthStore((s) => s.user?.userId ?? null);
  useEffect(() => {
    if (!enabled) return;
    /**
     * 复核 REVIEW-TENCENT §2-2：这个路径原本**完全绕过**首轮同步闸门，
     * 读取尚未成功时切后台/关页也会 push——等于把未知/空的 store 推上云端。
     * 现在只有「首轮同步明确 ready」之后才允许 flush。
     */
    let ready = false;
    let cancelled = false;
    setSyncStatus("idle");
    void (async () => {
      let result: "ready" | "unsafe" = "unsafe";
      try {
        result = await bootSync();
      } catch {
        result = "unsafe";
      }
      if (!cancelled && result === "ready") ready = true;
    })();
    const flush = () => {
      if (!ready || !readLocalEditMarker()) return;
      /* 空仓闸门（与 useAutoPush 同一处事故）：清空本机后的关页 flush 也不许把空快照
       * 推上云摧毁云端备份。keepalive 请求无重试，推空即成 HEAD，必须在入口拦下。 */
      if (!hasLocalData()) return;
      void pushCloud({ keepalive: true });
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, owner]);
}

/** 登录后的同步：全自动、无需用户点击——云端有数据就直接采用云端（云端为准），
 * 云端为空则把本地数据推上去。之后的本地改动由 useAutoPush 防抖自动推送。 */
export async function syncAfterLogin(): Promise<"pushed" | "pulled" | "none"> {
  const owner = useAppStore.getState()._storeUserId;
  /* 与 bootSync 同一条红线：登录后拉取窗口内的本地改动优先，绝不被云端快照覆盖 */
  /**
   * 复核 REVIEW-TENCENT §2-3：原实现在**检查 error 之前**就用「store 引用变化」
   * 决定直接推送——慢登录/水合期间引用必然变化，于是拉取失败也会推送旧/空快照。
   * 现在与 bootSync 走同一个纯函数决策，且用业务指纹判断是否真被编辑。
   */
  const fpBefore = businessFingerprint(useAppStore.getState());
  const cloud = await pullCloud();
  if (owner !== useAppStore.getState()._storeUserId) return "none";
  if (cloud.status === "error") { setSyncStatus("error"); return "none"; }
  if (cloud.status === "ok" && hasLocalData() && hasLegacyUnattributedWatermark()) { setSyncStatus("error"); return "none"; }
  const fpAfter = businessFingerprint(useAppStore.getState());
  const editedDuringPull = fpBefore !== fpAfter;
  const cloudData = cloud.status === "ok" ? cloud.data : null;
  const cloudUpdatedAt = cloud.status === "ok" ? cloud.updatedAt : "";
  const decision = decideSyncAction({
    cloud: { status: cloud.status, data: cloudData, updatedAt: cloudUpdatedAt },
    localHas: hasLocalData(),
    localTs: getSyncWatermarkTs(),
    cloudTs: Date.parse(cloudUpdatedAt) || 0,
    toleranceMs: SYNC_TOLERANCE_MS,
    editedDuringPull,
    hasUnsyncedEdits: !!readLocalEditMarker(),
    hasLocalOnlyEntries: hasFilesMissingFromCloud(localData(), cloudData),
    cloudAcknowledgedLocalUpload: acknowledgedUpload(cloud),
  });

  switch (decision.kind) {
    case "push": {
      const ok = await pushCloud({ baseVersion: cloudUpdatedAt || null });
      return ok ? "pushed" : "none";
    }
    case "pull": {
      if (!applyCloudSnapshot(cloudData)) return "none";
      /* 记同步水位：配额满时 setItem 抛 QuotaExceededError，不能让它冒泡到登录收尾
       * （会吞掉 pushed/pulled 成功 toast 并弹英文 DOM 错误）。 */
      markSyncWatermark(cloudUpdatedAt);
      return "pulled";
    }
    case "conflict": {
      setSyncStatus("conflict");
      return "none";
    }
    case "none":
    default:
      return "none";
  }
}

/** 云端快照是否"有实质内容"——全空快照(如历史事故推送的)不作为覆盖本地的依据 */
function cloudHasData(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false;
  const d = data as {
    goals?: unknown[];
    knowledge?: unknown[];
    books?: unknown[];
    sessions?: unknown[];
    customPersonas?: unknown[];
    agentSessions?: { messages?: unknown[] }[];
  };
  /* agentSessions 必须计入（与 hasLocalData 同口径）：否则「只有首页对话历史」的用户
   * 会被判成「云端空」→ 走「推送本地」分支，把云端真实历史覆盖成空。
   * 同样只数**非空**会话，空壳不算数据。 */
  const nonEmptyAgentSessions = (d.agentSessions ?? []).filter((x) => (x.messages?.length ?? 0) > 0).length;
  return (
    (d.goals?.length ?? 0) +
      (d.knowledge?.length ?? 0) +
      (d.books?.length ?? 0) +
      (d.sessions?.length ?? 0) +
      (d.customPersonas?.length ?? 0) +
      nonEmptyAgentSessions >
    0
  );
}

/** 客户端/服务端时钟允许的漂移：云快照必须比本地水位新出这个量才值得覆盖本地 */
const SYNC_TOLERANCE_MS = 3000;

/** 开机/刷新即与云端对齐：本地快照可能因配额装不下大知识库而为空，
 * 不能只靠"登录那一刻"拉云。云端比本地新就拉取,否则保留本地(含未推送编辑)。
 * 红线:云端是"空快照"而本地有数据时,绝不拉取——否则一条历史空备份会抹掉本地新数据。 */
/**
 * 首轮同步。返回 `"ready"` = 已与云端对齐、可安全自动推送；
 * `"unsafe"` = 拉取失败/冲突/未登录——**此时绝不能自动推送**。
 *
 * 复核 REVIEW-TENCENT §2-1：原实现 catch 掉一切错误后 return void，
 * 调用方无法区分「安全完成」与「拉取失败」，于是无条件放行推送。
 */
const bootSyncRuns = new Map<string, Promise<"ready" | "unsafe">>();
export async function retryCloudSync(): Promise<boolean> {
  const owner = useAppStore.getState()._storeUserId;
  setSyncStatus("saving");
  if (await bootSync() !== "ready" || owner !== useAppStore.getState()._storeUserId) {
    if (owner === useAppStore.getState()._storeUserId && useSyncStatus.getState().status !== "conflict") setSyncStatus("error");
    return false;
  }
  const ok = await pushCloud({ allowDuringConflict: true });
  if (ok && typeof window !== "undefined") window.dispatchEvent(new Event("mentora:sync-retry"));
  return ok;
}
export async function bootSync(): Promise<"ready" | "unsafe"> {
  const uid = useAuthStore.getState().user?.userId;
  if (!uid) return "unsafe";
  const existing = bootSyncRuns.get(uid);
  if (existing) return existing;
  const run = bootSyncForAccount();
  bootSyncRuns.set(uid, run);
  try { return await run; }
  finally { if (bootSyncRuns.get(uid) === run) bootSyncRuns.delete(uid); }
}

async function bootSyncForAccount(): Promise<"ready" | "unsafe"> {
  try {
    const uid = useAuthStore.getState().user?.userId ?? null;
    if (!uid) return "unsafe";
    // 仓还没切到当前账号时绝不 importData：否则数据先写进旧仓、再被整体替换
    if (useAppStore.getState()._storeUserId !== uid) return "unsafe";
    /* 用**业务指纹**判断拉取期间是否真的被编辑过——不能用 store 引用变化：
     * 页面水合必然换引用，那个信号恒为真（这正是数据被覆盖的根因）。 */
    const fpBefore = businessFingerprint(useAppStore.getState());
    const cloud = await pullCloud();
    if (useAuthStore.getState().user?.userId !== uid || useAppStore.getState()._storeUserId !== uid) return "unsafe";
    if (cloud.status === "error") { setSyncStatus("error"); return "unsafe"; }
    if (cloud.status === "ok" && hasLocalData() && hasLegacyUnattributedWatermark()) { setSyncStatus("error"); return "unsafe"; }
    const fpAfter = businessFingerprint(useAppStore.getState());
    const editedDuringPull = fpBefore !== fpAfter;
    const localHas = hasLocalData();
    /* 所有「该拉还是该推」的判断收敛到一个纯函数里（src/lib/sync-decision.ts），
     * 那边有 18 条行为测试覆盖失败/超时/空/冲突/编辑竞态等路径。 */
    const cloudData = cloud.status === "ok" ? cloud.data : null;
    const cloudUpdatedAt = cloud.status === "ok" ? cloud.updatedAt : "";
    const decision = decideSyncAction({
      cloud: { status: cloud.status, data: cloudData, updatedAt: cloudUpdatedAt },
      localHas,
      localTs: getSyncWatermarkTs(),
      cloudTs: Date.parse(cloudUpdatedAt) || 0,
      toleranceMs: SYNC_TOLERANCE_MS,
      editedDuringPull,
      hasUnsyncedEdits: !!readLocalEditMarker(),
      hasLocalOnlyEntries: hasFilesMissingFromCloud(localData(), cloudData),
      cloudAcknowledgedLocalUpload: acknowledgedUpload(cloud),
    });
    /* 统一按纯函数的决策执行（pull / push / none / conflict） */
    switch (decision.kind) {
      case "pull": {
        /* 结构不合法就保持本地不动，也不写水位（下次还在同一条路径上重试） */
        if (applyCloudSnapshot(cloudData)) {
          markSyncWatermark(cloudUpdatedAt);
          setSyncStatus("saved");
        } else { setSyncStatus("error"); return "unsafe"; }
        return "ready";
      }
      case "push": {
        const ok = await pushCloud({ baseVersion: cloudUpdatedAt || null });
        /* 推送失败说明云端状态仍未确认 → 不放行自动推送 */
        return ok ? "ready" : "unsafe";
      }
      case "conflict": {
        setSyncStatus("conflict");
        return "unsafe";
      }
      case "none":
      default:
        return "ready";
    }
  } catch {
    /* 开机同步失败不打断应用，本地数据照常可用——但**不放行自动推送** */
    return "unsafe";
  }
}

/** 登录状态下：数据变化后 2.5s 防抖自动推送 */
export function useAutoPush(enabled: boolean) {
  const owner = useAuthStore((s) => s.user?.userId ?? null);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /**
     * 「首轮同步完成前不自动推送」闸门。
     *
     * 真实事故（2026-11-13 腾讯测试环境实测抓到）：页面刚加载时，水合过程本身会触发
     * store 变更（切仓、会话初始化…），这个订阅就把**还没拉到云端的空 store** 在 2.5s 后
     * 推上去，覆盖云端真实数据。现场表现是「刚写的夹具/数据在刷新后消失」。
     *
     * bootSync / syncAfterLogin 内部虽然有「拉取期间本地变过就改推送」的判断，
     * 但它们管不到这条独立的防抖订阅。这里加一个明确的就绪信号：
     * 首轮同步（拉取或推送）落定后才允许自动推送。
     */
    let ready = false;
    let cancelled = false;
    const initialize = async () => {
      ready = false;
      let result: "ready" | "unsafe" = "unsafe";
      try {
        result = await bootSync();
      } catch {
        result = "unsafe";
      }
      /* 复核 REVIEW-TENCENT §2-1：**只有 bootSync 明确报告 ready 才放行**。
       * 原实现无论成败都 markReady，等于「拉取失败也能推送」——
       * 那正是空/旧快照覆盖云端的入口。 */
      if (!cancelled && result === "ready") ready = true;
    };
    void initialize();
    const retry = () => { void initialize().then(() => { if (!cancelled && ready && readLocalEditMarker()) return pushCloud(); }); };
    const resume = () => { void initialize(); };
    window.addEventListener("online", retry);
    window.addEventListener("mentora:sync-retry", resume);

    const unsub = useAppStore.subscribe((next, previous) => {
      if (applyingCloudSnapshot || next._storeUserId !== owner || previous._storeUserId !== owner) return;
      const changed = next.goals !== previous.goals || next.knowledge !== previous.knowledge ||
        next.folders !== previous.folders || next.books !== previous.books || next.sessions !== previous.sessions ||
        next.customPersonas !== previous.customPersonas || next.agentSessions !== previous.agentSessions ||
        next.settings !== previous.settings;
      if (!changed) return;
      markLocalEdit();
      if (!ready) return; // 首轮同步未落定：绝不用可能为空的 store 覆盖云端
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        /* 空仓闸门（QA 复盘：清空全部数据摧毁云端备份）：settings resetAll 清空本机仓后，
         * 本订阅监听到数组引用变化、2.5s 后会推空快照——空数组被服务端接受成为云端 HEAD，
         * 云端唯一备份被静默摧毁（「若刷新后本地变空，点『从云端恢复』」的兜底随之失效）。
         * 本机无实质数据时绝不自动推送；手动恢复（importData/从云端恢复）后数据回来，
         * 推送自然恢复。闸门只在这两个自动入口（本处与 useFlushOnHide 的 flush），
         * pushOnce 直连调用（bootSync push 分支等）由 decideSyncAction 的 localHas 前提保障。 */
        if (!hasLocalData()) return;
        void pushCloud();
      }, 2500);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("online", retry);
      window.removeEventListener("mentora:sync-retry", resume);
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, owner]);
}
