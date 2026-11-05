"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useAppStore, setStoreUser } from "@/lib/store";

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

/* 云端同步的可见状态：让"自动同步"从一句静态文案变成可感知的反馈（保存中/已同步/失败） */
export type SyncStatus = "idle" | "saving" | "saved" | "error";
export const useSyncStatus = create<{ status: SyncStatus }>(() => ({ status: "idle" }));
export const setSyncStatus = (status: SyncStatus) => useSyncStatus.setState({ status });

/* ---------------- 认证状态（全局单例：所有组件共享同一份） ---------------- */

let initialized = false;

interface AuthStore {
  user: AuthUser | null;
  checking: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (email: string, password: string, name: string, inviteCode: string, refCode?: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; avatar?: string | null }) => Promise<AuthUser>;
  redeem: (code: string) => Promise<Entitlement>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  checking: true,

  login: async (email, password) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "登录失败");
    set({ user: j.user });
    // 切换到该账号的专属仓（同步加载，内存状态随之替换为该账号的数据或空仓）
    setStoreUser(j.user.userId);
    return j.user as AuthUser;
  },

  register: async (email, password, name, inviteCode, refCode) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, inviteCode, refCode }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "注册失败");
    set({ user: j.user });
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
    set({ user: null });
    // 只切回匿名仓（内存状态同步替换），绝不 clear 用户仓——
    // 曾经的 clearLocalStore 先于切仓执行，会把空状态写进用户仓导致本地快照被毁
    setStoreUser(null);
    localStorage.removeItem(CHOICE_KEY);
    if (!ok) throw new Error(msg);
  },

  updateProfile: async (patch) => {
    const res = await fetch("/api/auth/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "保存失败");
    set({ user: j.user });
    return j.user as AuthUser;
  },

  /** 续费：成功后就地更新权益，横幅/会员页立刻反映新到期日 */
  redeem: async (code) => {
    const res = await fetch("/api/subscription/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "兑换失败");
    const entitlement = j.entitlement as Entitlement;
    const cur = useAuthStore.getState().user;
    if (cur) {
      useAuthStore.setState({
        user: { ...cur, entitlement, ...(entitlement.expiresAt ? { planExpiresAt: entitlement.expiresAt } : {}) },
      });
    }
    return entitlement;
  },
}));

/** 挂载时校验会话；全局只发一次请求，登录后所有页面同步看到 */
export function useAuth() {
  const store = useAuthStore();
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    void (async () => {
      try {
        // 5s 超时：认证探测挂起时不能把 checking 永远卡在 true（页面会被永久锁在加载态）
        const res = await fetch("/api/auth/me", {
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        const j = await res.json();
        const user = j.user ?? null;
        useAuthStore.setState({ user });
        // 与当前仓不一致时切仓（setStoreUser 同步加载，无竞态、无破坏性清空）
        const target = user?.userId ?? null;
        if (useAppStore.getState()._storeUserId !== target) {
          setStoreUser(target);
        }
        // 刷新/新开页面即与云端对齐,不必重新登录才恢复数据
        if (user) void bootSync();
      } catch {
        useAuthStore.setState({ user: null });
        setStoreUser(null);
      } finally {
        useAuthStore.setState({ checking: false });
      }
    })();
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
    books: s.books,
    sessions: s.sessions,
    customPersonas: s.customPersonas,
    settings: { ...s.settings, apiKey: "" },
  };
}

function hasLocalData() {
  const s = useAppStore.getState();
  // customPersonas 与 cloudHasData 同口径：只有自定义智能体的用户登录后也能触发上传/回推
  return (
    s.goals.length + s.knowledge.length + s.books.length + s.sessions.length + s.customPersonas.length >
    0
  );
}

/* 拉取结果必须三态：ok / empty / error。
 * 旧实现把 401/503/网络失败折叠成与「云端没有数据」同一个 null——消费端据此
 * 判定「云端为空 → 把本地推上去」，一次 KV 抖动就能让登录后的同步用旧本地
 * 覆盖云端活动快照。 */
export type PullCloudResult =
  | { status: "ok"; data: Record<string, unknown>; updatedAt: string }
  | { status: "empty" }
  | { status: "error"; message: string };

export async function pullCloud(): Promise<PullCloudResult> {
  try {
    const res = await fetch("/api/sync", { cache: "no-store" });
    if (!res.ok) return { status: "error", message: `云端请求失败（${res.status}）` };
    if (res.headers.get("content-type") === "application/x-gzip") {
      const text = await gunzipBytes(new Uint8Array(await res.arrayBuffer()));
      const j = JSON.parse(text) as { data: Record<string, unknown> | null; updatedAt?: string };
      return j.data
        ? { status: "ok", data: j.data, updatedAt: j.updatedAt ?? "" }
        : { status: "empty" };
    }
    const j = await res.json();
    return j.data ? { status: "ok", data: j.data, updatedAt: j.updatedAt ?? "" } : { status: "empty" };
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

export async function pushCloud(opts: { keepalive?: boolean; retries?: number } = {}): Promise<boolean> {
  return withPushLock(() => pushOnce(opts));
}

async function pushOnce(opts: { keepalive?: boolean; retries?: number } = {}): Promise<boolean> {
  const { keepalive = false, retries = keepalive ? 0 : 2 } = opts;
  const text = JSON.stringify({ data: localData() });
  // 浏览器对 keepalive 请求体硬限 64KiB：真实体量的库关页 flush 必然被浏览器拒发，
  // 白发一次还把同步态打成 error——直接跳过，交给常规 2.5s 防抖推送兜底
  if (keepalive && text.length > 60_000) return false;
  setSyncStatus("saving");
  const doFetch = (): Promise<Response> => {
    if (text.length > GZIP_THRESHOLD) {
      // keepalive 与 gzip 异步压缩不兼容：flush 场景若超大则降级为不压缩直传（仍可能超 4.5MB,失败则报错提示导出）
      if (keepalive) {
        return fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: text,
          keepalive: true,
        });
      }
      return gzipBytes(text).then((gz) =>
        fetch("/api/sync", {
          method: "POST",
          headers: { "Content-Type": "application/x-gzip" },
          body: gz.buffer as ArrayBuffer,
        })
      );
    }
    return fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
      keepalive: keepalive || undefined,
    });
  };

  let ok = false;
  let serverTs = "";
  for (let attempt = 0; attempt <= retries && !ok; attempt++) {
    try {
      const res = await doFetch();
      ok = res.ok;
      if (ok) {
        /* 用**服务端** updatedAt 记本地同步水位：客户端时钟快/慢都会让 bootSync 误判，
         * 刷新时就会把“还没带今日讲义”的云快照拉回来覆盖本地。 */
        const j = (await res.json().catch(() => null)) as { updatedAt?: string } | null;
        if (j && typeof j.updatedAt === "string") serverTs = j.updatedAt;
      }
    } catch {
      ok = false;
    }
    if (!ok && attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  if (ok) {
    try {
      localStorage.setItem(CHOICE_KEY, serverTs || new Date().toISOString());
    } catch { /* 配额满忽略 */ }
    setSyncStatus("saved");
    return true;
  }
  setSyncStatus("error");
  return false;
}

/** 关页/切后台前把内存数据强制 flush 到云端,防"没推上去就关了"导致丢失 */
export function useFlushOnHide(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      void pushCloud({ keepalive: true });
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled]);
}

/** 登录后的同步：全自动、无需用户点击——云端有数据就直接采用云端（云端为准），
 * 云端为空则把本地数据推上去。之后的本地改动由 useAutoPush 防抖自动推送。 */
export async function syncAfterLogin(): Promise<"pushed" | "pulled" | "none"> {
  /* 与 bootSync 同一条红线：登录后拉取窗口内的本地改动优先，绝不被云端快照覆盖 */
  const stateBeforePull = useAppStore.getState();
  const cloud = await pullCloud();
  if (useAppStore.getState() !== stateBeforePull) {
    return (await pushCloud()) ? "pushed" : "none";
  }
  // 串号防护已由 setStoreUser 的同步切仓保证：内存状态始终属于 _storeUserId 对应的仓，
  // 不再使用破坏性的 clearLocalStore（曾把用户本地快照写空）。
  /* 拉取失败 ≠ 云端为空：失败时保持本地不动、绝不反推，否则一次 KV 抖动
   * 就会拿旧本地快照覆盖云端（活动快照翻转，只剩 archive 可回捞）。 */
  if (cloud.status === "error") return "none";
  if (cloud.status === "empty") {
    // 云端为空：本地有**实质数据**才推——空内存推上去会存下"空快照",
    // 之后任何设备的 bootSync 都可能被它覆盖(历史事故根源)
    if (hasLocalData()) {
      const ok = await pushCloud();
      return ok ? "pushed" : "none";
    }
    return "none";
  }
  // 云端为准：直接采用，不弹窗打断
  if (!useAppStore.getState().importData(cloud.data)) return "none";
  localStorage.setItem(CHOICE_KEY, cloud.updatedAt || new Date().toISOString());
  return "pulled";
}

/** 云端快照是否"有实质内容"——全空快照(如历史事故推送的)不作为覆盖本地的依据 */
function cloudHasData(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) return false;
  const d = data as { goals?: unknown[]; knowledge?: unknown[]; books?: unknown[]; sessions?: unknown[]; customPersonas?: unknown[] };
  return (
    (d.goals?.length ?? 0) +
      (d.knowledge?.length ?? 0) +
      (d.books?.length ?? 0) +
      (d.sessions?.length ?? 0) +
      (d.customPersonas?.length ?? 0) >
    0
  );
}

/** 客户端/服务端时钟允许的漂移：云快照必须比本地水位新出这个量才值得覆盖本地 */
const SYNC_TOLERANCE_MS = 3000;

/** 开机/刷新即与云端对齐：本地快照可能因配额装不下大知识库而为空，
 * 不能只靠"登录那一刻"拉云。云端比本地新就拉取,否则保留本地(含未推送编辑)。
 * 红线:云端是"空快照"而本地有数据时,绝不拉取——否则一条历史空备份会抹掉本地新数据。 */
export async function bootSync(): Promise<void> {
  try {
    const uid = useAuthStore.getState().user?.userId ?? null;
    if (!uid) return;
    // 仓还没切到当前账号时绝不 importData：否则数据先写进旧仓、再被整体替换
    if (useAppStore.getState()._storeUserId !== uid) return;
    /* 拉取在途 0.5-2s 里页面已经可交互：用户此刻的输入还没进 2.5s 防抖推送，
     * 水位比较（CHOICE_KEY）根本看不见它——旧实现会拿云端快照把刚输入的内容抹掉，
     * zustand persist 再覆写本地仓。zustand 每次 set 都会换掉 state 对象引用，
     * 所以引用变化就是"拉取期间有人改过本地"，此时改为推送本地而不是采用云端。 */
    const stateBeforePull = useAppStore.getState();
    const cloud = await pullCloud();
    // 拉取失败不是「云端为空」：保持本地不动，也绝不反推覆盖云端
    if (cloud.status !== "ok") return;
    if (useAppStore.getState() !== stateBeforePull) {
      void pushCloud();
      return;
    }
    const localHas = hasLocalData();
    const cloudOk = cloudHasData(cloud.data);
    // 云端空 & 本地有 → 不覆盖,反手把本地推上去(修复历史空快照)
    if (!cloudOk && localHas) {
      void pushCloud();
      return;
    }
    // 云端空 & 本地空 → 无事可做
    if (!cloudOk) return;
    const localTs = Date.parse(localStorage.getItem(CHOICE_KEY) ?? "") || 0;
    const cloudTs = Date.parse(cloud.updatedAt) || 0;
    // 本地为空(大知识库装不下 localStorage,刷新后本地快照是空的)时,只要云端有数据就恢复;
    // 否则仅在云端**明显**比本地新时拉取(容忍几秒时钟漂移),避免覆盖本地未推送的编辑。
    if (!localHas || cloudTs > localTs + SYNC_TOLERANCE_MS) {
      // 结构不合法就保持本地不动，也不写水位（下次还在同一条路径上重试）
      if (useAppStore.getState().importData(cloud.data)) {
        localStorage.setItem(CHOICE_KEY, cloud.updatedAt);
        setSyncStatus("saved");
      }
    }
  } catch {
    /* 开机同步失败不打断应用,本地数据照常可用 */
  }
}

/** 登录状态下：数据变化后 2.5s 防抖自动推送 */
export function useAutoPush(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useAppStore.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void pushCloud();
      }, 2500);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);
}
