"use client";

import { useEffect, useState } from "react";

/** Mainframe 规格打字机：startDelay 后逐字显示，完成时 done=true */
export function useTypewriter(text: string, speed = 38, startDelay = 600) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let i = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    // v17：重置挪到 rAF（effect 同步 setState 是 lint 红线）；对使用者仅一帧差异，打字起始观感不变
    const raf = requestAnimationFrame(() => {
      setDisplayed("");
      setDone(false);
    });
    const timer = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setDisplayed(text.slice(0, i));
        if (i >= text.length) {
          if (interval) clearInterval(interval);
          setDone(true);
        }
      }, speed);
    }, startDelay);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }, [text, speed, startDelay]);

  return { displayed, done };
}
