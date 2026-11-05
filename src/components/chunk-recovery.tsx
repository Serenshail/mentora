"use client";

import { useEffect } from "react";

/* 部署后旧标签页白屏自愈：页面 HTML 引用的 JS chunk 在新部署下 404，
 * hydration 永不发生 → 整页空白（用户感知"进不去还一直卡"）。
 * 监听资源加载失败，命中 _next/static 的脚本就强制刷新一次；
 * sessionStorage 记时间戳防循环（TTL 内不重复刷，此后允许再自愈一次——
 * 旧实现整个会话永不复位，同会话第二次 chunk 404 就没人管了）。 */
export function ChunkRecovery() {
  useEffect(() => {
    const key = "mentora-chunk-retry";
    const TTL_MS = 2 * 60 * 1000;
    const handler = (e: Event) => {
      const t = e.target as HTMLElement | null;
      const src = (t as HTMLScriptElement | null)?.src ?? "";
      if (!src || !src.includes("/_next/static/")) return;
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (last && Date.now() - last < TTL_MS) return;
      sessionStorage.setItem(key, String(Date.now()));
      location.reload();
    };
    window.addEventListener("error", handler, true); // 资源加载失败不冒泡，必须捕获阶段
    return () => window.removeEventListener("error", handler, true);
  }, []);
  return null;
}
