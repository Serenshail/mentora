"use client";

import { useEffect } from "react";

/* ============================================================
 * useVisualViewportInset — 移动键盘 inset 的唯一写入方
 * docs/PRD-2026-10-26-MOBILE-UI §4.3
 *
 * 监听 visualViewport 的 resize/scroll，把"键盘吃掉的高度"写入
 * CSS 变量 --keyboard-inset（挂在 documentElement 上，全站 fixed 层
 * 经 .above-mobile-nav 消费）。组件卸载时还原为 0px。
 *
 * 纪律：
 * - 不支持 visualViewport 的环境直接跳过，变量保持 0（优雅降级）；
 * - 多处挂载共享同一变量，最后一个卸载者负责清零（引用计数）；
 * - 只写 CSS 变量，不触发 React 重渲染（键盘频繁 resize 不能拖垮页面）。
 * ============================================================ */

let refCount = 0;

export function useVisualViewportInset(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return; // 老环境：变量恒 0，fixed 层退化为仅底栏+safe

    refCount += 1;
    const root = document.documentElement;
    const update = () => {
      // Pinch zoom is a reader action, not a keyboard resize.
      if (vv.scale > 1.01) return;
      /* 键盘弹出 = 布局视口高 - 可视视口高 - 可视视口相对布局视口的顶部偏移。
       * 取 max(0) 防止浏览器回弹时算出负数；桌面无差异，值恒 ≈0。 */
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
      root.style.setProperty("--visual-viewport-height", `${vv.height}px`);
      root.style.setProperty("--visual-viewport-top", `${vv.offsetTop}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      refCount -= 1;
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      /* 只有最后一个消费者卸载才清零，避免多组件竞态把别人的 inset 抹掉 */
      if (refCount <= 0) {
        refCount = 0;
        root.style.setProperty("--keyboard-inset", "0px");
        root.style.removeProperty("--visual-viewport-height");
        root.style.removeProperty("--visual-viewport-top");
      }
    };
  }, [enabled]);
}
