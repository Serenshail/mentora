"use client";

import { useEffect, useRef, useState } from "react";

/* PopText 资产按需加载（css + js + emoji base）——来自 D:\zcode\ui 自建 skill */
const POPTEXT_VERSION = "v12"; // 改这里强制刷新缓存
/* 复用已有 link 时的收口上限：既无 load 也无 error（失败残留/弱网卡死）也必须 resolve */
const CSS_TIMEOUT_MS = 8000;

/** 确保 pop-text.css 就绪；resolve false 表示失败，调用方据此走纯文本兜底。
 *  load / error / 超时三选一先到先收口——复用一条「早先失败、已错过 error」的残留
 *  link 时也必然有结果，await 不会永久挂起（否则 failed 兜底永不置位）。 */
export function ensurePopTextCss(doc: Document = document): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const existing = doc.querySelector('link[data-poptext-css]') as HTMLLinkElement | null;
    /* 本次真正等待的那条 link（复用的或新建的），超时/失败时据它决定是否摘除 */
    let pending: HTMLLinkElement | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      /* 超时前再确认一次：弱网下 sheet 可能刚好就绪；仍无 sheet 则视为失败，
       * 并摘掉这条 link，避免它作为失败残留被后续实例反复复用。 */
      const ok = !!pending?.sheet;
      if (!ok) pending?.remove();
      finish(ok);
    }, CSS_TIMEOUT_MS);

    if (existing) {
      pending = existing;
      if (existing.sheet) { finish(true); return; }
      existing.addEventListener("load", () => finish(true), { once: true });
      existing.addEventListener("error", () => {
        /* 复用中的 link 也报错：同样摘除，别让它继续当残留坑下一个实例 */
        existing.remove();
        finish(false);
      }, { once: true });
      return;
    }
    const link = doc.createElement("link");
    pending = link;
    link.rel = "stylesheet";
    link.href = `/poptext/pop-text.css?v=${POPTEXT_VERSION}`;
    link.setAttribute("data-poptext-css", "1");
    link.onload = () => finish(true);
    /* 失败即摘除：否则这条 link 会作为「已错过 error 的残留」被后续实例复用，
     * 复用方只能干等到超时（下次挂载重新建 link，可再试一次）。 */
    link.onerror = () => {
      link.remove();
      finish(false);
    };
    doc.head.appendChild(link);
  });
}

export function usePopText(text: string, delay = 0) {
  const elRef = useRef<HTMLHeadingElement>(null);
  const [ready, setReady] = useState(false);
  /* 资产加载失败：调用方据此渲染纯文本兜底（品牌 h1 无文本子节点，否则首屏永久空白） */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let loadFailed = false;
      // css：等样式表真正加载完再打字（否则早期变形图层没有绝对定位，会飘）
      const cssOk = await ensurePopTextCss(document);
      if (!cssOk) loadFailed = true;
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
          s.onerror = () => { loadFailed = true; resolve(); };
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
      if (cancelled) return;
      // 缺 PT（css/js 加载失败）：不再静默退出，报失败让调用方走纯文本兜底
      if (loadFailed || !PT || !elRef.current) {
        setFailed(true);
        return;
      }
      PT.setEmojiBase("/poptext/emoji/");
      PT.arm(elRef.current); // 悬停变形：必须在 type 前挂上（skill 文档：pointerover 委托）
      await PT.type(elRef.current, text, { step: 95, startDelay: delay, cursor: true });
      if (!cancelled) setReady(true);
    };
    // PT.type 可能 reject：catch 收口，不留 unhandled rejection
    void load().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [text, delay]);

  return { elRef, ready, failed };
}
