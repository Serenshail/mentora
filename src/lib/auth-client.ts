"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
}

const CHOICE_KEY = "mentora-sync-choice";

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        const j = await res.json();
        setUser(j.user ?? null);
      } catch {
        setUser(null);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "登录失败");
    setUser(j.user);
    return j.user as AuthUser;
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "注册失败");
    setUser(j.user);
    return j.user as AuthUser;
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    localStorage.removeItem(CHOICE_KEY);
  }, []);

  return { user, checking, login, register, logout };
}

/* ---------------- 云端同步 ---------------- */

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
  const j = await res.json();
  return j.data ? { data: j.data, updatedAt: j.updatedAt } : null;
}

export async function pushCloud(): Promise<boolean> {
  const res = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: localData() }),
  });
  if (res.ok) {
    localStorage.setItem(CHOICE_KEY, new Date().toISOString());
    return true;
  }
  return false;
}

/** 登录后的同步决策：云端有数据时让用户二选一（避免静默覆盖丢数据） */
export async function syncAfterLogin(
  ask: (cloudUpdatedAt: string) => Promise<"cloud" | "local">
): Promise<"cloud" | "local" | "pushed" | "pulled" | "none"> {
  const cloud = await pullCloud();
  if (!cloud) {
    // 云端为空：本地有数据就推上去
    if (hasLocalData()) {
      const ok = await pushCloud();
      return ok ? "pushed" : "none";
    }
    return "none";
  }
  const choice = await ask(cloud.updatedAt);
  localStorage.setItem(CHOICE_KEY, new Date().toISOString());
  if (choice === "cloud") {
    useAppStore.getState().importData(cloud.data);
    return "pulled";
  }
  const ok = await pushCloud();
  return ok ? "pushed" : "none";
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
