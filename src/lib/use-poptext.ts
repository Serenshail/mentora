"use client";

import { useEffect, useRef, useState } from "react";

/* PopText 资产按需加载（css + js + emoji base）——来自 D:\zcode\ui 自建 skill */
const POPTEXT_VERSION = "v11"; // 改这里强制刷新缓存

export function usePopText(text: string, delay = 0) {
  const elRef = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // css：等样式表真正加载完再打字（否则早期变形图层没有绝对定位，会飘）
      await new Promise<void>((resolve) => {
        const existing = document.querySelector('link[data-poptext-css]') as HTMLLinkElement | null;
        if (existing) {
          if (existing.sheet) resolve();
          else existing.addEventListener("load", () => resolve(), { once: true });
          return;
        }
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `/poptext/pop-text.css?v=${POPTEXT_VERSION}`;
        link.setAttribute("data-poptext-css", "1");
        link.onload = () => resolve();
        link.onerror = () => resolve();
        document.head.appendChild(link);
      });
      // 品牌字体就绪（避免打字中途字形跳变）
      try {
        await Promise.race([
          document.fonts.load('1em "Great Vibes"'),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      } catch { /* 字体加载失败也继续 */ }
      // js
      if (!(window as unknown as { PopText?: unknown }).PopText) {
        await new Promise<void>((resolve) => {
          const s = document.createElement("script");
          s.src = `/poptext/pop-text.js?v=${POPTEXT_VERSION}`;
          s.onload = () => resolve();
          s.onerror = () => resolve();
          document.body.appendChild(s);
        });
      }
      const PT = (
        window as unknown as {
          PopText?: {
            setEmojiBase: (b: string) => void;
            type: (el: HTMLElement, t: string, o?: object) => Promise<void>;
            arm: (el: HTMLElement) => void;
          };
        }
      ).PopText;
      if (cancelled || !PT || !elRef.current) return;
      PT.setEmojiBase("/poptext/emoji/");
      PT.arm(elRef.current); // 悬停变形：必须在 type 前挂上（skill 文档：pointerover 委托）
      await PT.type(elRef.current, text, { step: 95, startDelay: delay, cursor: true });
      if (!cancelled) setReady(true);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [text, delay]);

  return { elRef, ready };
}
