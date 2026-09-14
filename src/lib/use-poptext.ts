"use client";

import { useEffect, useRef, useState } from "react";

/* PopText 资产按需加载（css + js + emoji base）——来自 D:\zcode\ui 自建 skill */
export function usePopText(text: string, delay = 0) {
  const elRef = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // css
      if (!document.querySelector('link[data-poptext-css]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/poptext/pop-text.css";
        link.setAttribute("data-poptext-css", "1");
        document.head.appendChild(link);
      }
      // js
      if (!(window as unknown as { PopText?: unknown }).PopText) {
        await new Promise<void>((resolve) => {
          const s = document.createElement("script");
          s.src = "/poptext/pop-text.js";
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
