"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useAppStore, setStoreUser } from "@/lib/store";

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
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
  register: (email: string, password: string, name: string, inviteCode: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  updateProfile: (patch: { name?: string; avatar?: string | null }) => Promise<AuthUser>;
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

  register: async (email, password, name, inviteCode) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, inviteCode }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "注册失败");
    set({ user: j.user });
    setStoreUser(j.user.userId);
    return j.user as AuthUser;
  },

  logout: async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    set({ user: null });
    // 只切回匿名仓（内存状态同步替换），绝不 clear 用户仓——
    // 曾经的 clearLocalStore 先于切仓执行，会把空状态写进用户仓导致本地快照被毁
    setStoreUser(null);
    localStorage.removeItem(CHOICE_KEY);
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
}));

/** 挂载时校验会话；全局只发一次请求，登录后所有页面同步看到 */
export function useAuth() {
  const store = useAuthStore();
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
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
  return s.goals.length + s.knowledge.length + s.books.length + s.sessions.length > 0;
}

export async function pullCloud(): Promise<{ data: Record<string, unknown>; updatedAt: string } | null> {
  const res = await fetch("/api/sync", { cache: "no-store" });
  if (!res.ok) return null;
  if (res.headers.get("content-type") === "application/x-gzip") {
    const text = await gunzipBytes(new Uint8Array(await res.arrayBuffer()));
    const j = JSON.parse(text) as { data: Record<string, unknown> | null; updatedAt?: string };
    return j.data ? { data: j.data, updatedAt: j.updatedAt ?? "" } : null;
  }
  const j = await res.json();
  return j.data ? { data: j.data, updatedAt: j.updatedAt } : null;
}

/** 推送本地数据到云端。带重试+退避；keepalive 用于关页/刷新前的兜底 flush（数据丢失根治的一环）。 */
export async function pushCloud(opts: { keepalive?: boolean; retries?: number } = {}): Promise<boolean> {
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
  for (let attempt = 0; attempt <= retries && !ok; attempt++) {
    try {
      const res = await doFetch();
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok && attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  if (ok) {
    try {
      localStorage.setItem(CHOICE_KEY, new Date().toISOString());
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
  const cloud = await pullCloud();
  // 串号防护已由 setStoreUser 的同步切仓保证：内存状态始终属于 _storeUserId 对应的仓，
  // 不再使用破坏性的 clearLocalStore（曾把用户本地快照写空）。
  if (!cloud) {
    // 云端为空：本地有**实质数据**才推——空内存推上去会存下"空快照",
    // 之后任何设备的 bootSync 都可能被它覆盖(历史事故根源)
    if (hasLocalData()) {
      const ok = await pushCloud();
      return ok ? "pushed" : "none";
    }
    return "none";
  }
  // 云端为准：直接采用，不弹窗打断
  useAppStore.getState().importData(cloud.data);
  localStorage.setItem(CHOICE_KEY, new Date().toISOString());
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

/** 开机/刷新即与云端对齐：本地快照可能因配额装不下大知识库而为空，
 * 不能只靠"登录那一刻"拉云。云端比本地新就拉取,否则保留本地(含未推送编辑)。
 * 红线:云端是"空快照"而本地有数据时,绝不拉取——否则一条历史空备份会抹掉本地新数据。 */
export async function bootSync(): Promise<void> {
  try {
    const cloud = await pullCloud();
    if (!cloud) return;
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
    // 否则仅在云端比本地新时拉取,避免覆盖本地未推送的编辑。
    if (!localHas || cloudTs > localTs) {
      useAppStore.getState().importData(cloud.data);
      localStorage.setItem(CHOICE_KEY, cloud.updatedAt);
      setSyncStatus("saved");
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
