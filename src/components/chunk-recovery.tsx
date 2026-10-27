"use client";

import { useEffect } from "react";

/* 部署后旧标签页白屏自愈：页面 HTML 引用的 JS chunk 在新部署下 404，
 * hydration 永不发生 → 整页空白（用户感知"进不去还一直卡"）。
 * 监听资源加载失败，命中 _next/static 的脚本就强制刷新一次；
 * sessionStorage 防循环（刷新后仍失败说明不是 chunk 问题，不再刷）。 */
export function ChunkRecovery() {
  useEffect(() => {
    const key = "mentora-chunk-retry";
    const handler = (e: Event) => {
      const t = e.target as HTMLElement | null;
      const src = (t as HTMLScriptElement | null)?.src ?? "";
      if (!src || !src.includes("/_next/static/")) return;
      if (sessionStorage.getItem(key)) return; // 已重试过，不再循环
      sessionStorage.setItem(key, "1");
      location.reload();
    };
    window.addEventListener("error", handler, true); // 资源加载失败不冒泡，必须捕获阶段
    return () => window.removeEventListener("error", handler, true);
  }, []);
  return null;
}
