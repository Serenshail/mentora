"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { BookOpen, X } from "lucide-react";
import { Button, FOCUSABLE } from "@/components/ui";
import { cn } from "@/lib/utils";

const STEPS = [
  { target: "composer", route: "/", title: "从这里说出你的需要", description: "直接提问，或告诉 AI 你的目标、基础和时间。想整理笔记、调整计划，或搭建自己的学习页面，也可以从这里开始。" },
  { target: "new-chat", route: "/", title: "换个话题，开启新对话", description: "点击这里开始独立的对话。已有对话会保留在工作台中，方便你随时回来继续。" },
  { target: "nav-learn", route: "/", title: "学习功能都在这里", description: "从这个入口进入学习工作台，制定和继续学习计划，或与读书伙伴一起阅读。" },
  { target: "coach-tab", route: "/learn", title: "学习教练：安排与推进计划", description: "在这里选择学习方向、查看已有计划。进入具体计划后，按天学习、练习并检验理解，再根据进展调整节奏。" },
  { target: "reading-tab", route: "/learn?tab=read", title: "读书伙伴：围绕一本书学习", description: "切到这里选择要读的书、确认书籍信息，再开始共读。也可以提供自己的材料；书籍不明确时，先核实再继续。" },
  { target: "notes-entry", route: "/learn", title: "笔记库：留下并连接知识", description: "从这里打开笔记库，编辑和整理学过的内容。用 [[笔记标题]] 建立链接，通过反向链接与图谱回看知识之间的关系。" },
  { target: "nav-life", route: "/life", title: "成长记录：回看自己的进展", description: "这个入口汇总学习进度、复习和足迹，方便你回顾已经做过的事，并继续下一步。" },
  { target: "nav-council", route: "/council", title: "人生伙伴：一起梳理选择", description: "遇到方向和取舍的问题，从这里选择人物或发起圆桌讨论，帮助自己看清目标和限制。" },
  { target: "guide-entry", route: "/council", title: "需要时，随时重看引导", description: "电脑左下角的「使用指南」就在反馈上方；手机从底部「更多」进入。你可以随时跳过，之后再回来查看。" },
] as const;

type Rect = { left: number; top: number; width: number; height: number };
type Geometry = { step: number; rect: Rect; panel: { left: number; top: number; maxHeight: number }; target: string };
type Close = (status: "skipped" | "completed") => void;

export function GuideLauncher({ collapsed = false, onClick }: { collapsed?: boolean; onClick: () => void }) {
  return <button type="button" data-guide="guide-entry" onClick={onClick} aria-label="使用指南" title="使用指南" className={cn("flex min-h-11 w-full cursor-pointer items-center rounded-lg text-[13px] font-medium text-ink-dim transition hover:bg-black/[0.035] hover:text-ink", collapsed ? "justify-center px-2" : "gap-2.5 px-3.5 py-2.5")}><BookOpen className="size-[18px] shrink-0" strokeWidth={1.75} />{!collapsed && <span>使用指南</span>}</button>;
}

// Prefer a side with enough room; clamp to the visible viewport after zoom/keyboard changes.
function placePanel(rect: Rect, width: number, height: number, viewport: Rect) {
  const gap = 16, edge = 12;
  const right = rect.left + rect.width, bottom = rect.top + rect.height;
  const maxX = viewport.left + viewport.width - edge - width;
  const below = viewport.top + viewport.height - edge - bottom - gap;
  const above = rect.top - viewport.top - edge - gap;
  let left = rect.left, top = bottom + gap, maxHeight = viewport.height - edge * 2;
  if (rect.width < 300 && right + gap + width <= viewport.left + viewport.width - edge) {
    left = right + gap; top = rect.top;
  } else if (bottom + gap + height <= viewport.top + viewport.height - edge) {
    top = bottom + gap; maxHeight = below;
  } else if (rect.top - gap - height >= viewport.top + edge) {
    top = rect.top - gap - height; maxHeight = above;
  } else if (rect.left - gap - width >= viewport.left + edge) {
    left = rect.left - gap - width; top = rect.top;
  } else if (above > below) {
    maxHeight = Math.max(1, above); top = rect.top - gap - Math.min(height, maxHeight);
  } else {
    maxHeight = Math.max(1, below); top = bottom + gap;
  }
  const maxY = viewport.top + viewport.height - edge - Math.min(height, maxHeight);
  return { left: Math.max(viewport.left + edge, Math.min(left, maxX)), top: Math.max(viewport.top + edge, Math.min(top, maxY)), maxHeight };
}

function SpotlightTour({ close }: { close: Close }) {
  const [step, setStep] = useState(0);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [missingStep, setMissingStep] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  const router = useRouter();
  const pathname = usePathname();
  const current = STEPS[step];
  useEffect(() => { closeRef.current = close; }, [close]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) panelRef.current?.focus({ preventScroll: true });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); closeRef.current("skipped");
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      const items = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(el => el.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (!first || !panel?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", containFocus);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (window.location.pathname + window.location.search !== current.route) router.replace(current.route, { scroll: false });
    let frame = 0, polling: ReturnType<typeof setTimeout> | undefined;
    let observed: HTMLElement | null = null;
    let settleUntil = 0;
    const deadline = Date.now() + 5000;
    const observer = new ResizeObserver(() => schedule());
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const measure = () => {
      frame = 0;
      clearTimeout(polling);
      // A mobile entry is in the More drawer, which is intentionally closed during the tour.
      const selector = current.target === "guide-entry" && window.innerWidth < 768 ? "more" : current.target;
      const target = Array.from(document.querySelectorAll<HTMLElement>(`[data-guide="${selector}"]`)).find(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
      });
      if (!target || window.location.pathname + window.location.search !== current.route) {
        setGeometry(old => old === null ? old : null);
        if (Date.now() < deadline) polling = setTimeout(schedule, 100);
        else setMissingStep(step);
        return;
      }
      if (target !== observed) {
        if (observed) observer.unobserve(observed);
        observed = target; observer.observe(target);
        // The page entrance uses a transform, which ResizeObserver cannot detect.
        settleUntil = Date.now() + 700;
        target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      }
      const view = window.visualViewport;
      const viewport = { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0, width: view?.width ?? innerWidth, height: view?.height ?? innerHeight };
      const raw = target.getBoundingClientRect(), padding = 6;
      const left = Math.max(viewport.left + 4, raw.left - padding), top = Math.max(viewport.top + 4, raw.top - padding);
      const rect = { left, top, width: Math.max(0, Math.min(raw.right + padding, viewport.left + viewport.width - 4) - left), height: Math.max(0, Math.min(raw.bottom + padding, viewport.top + viewport.height - 4) - top) };
      // Never present an off-screen or detached target as a successful highlight.
      if (rect.width < 1 || rect.height < 1) { setGeometry(null); return; }
      const panel = panelRef.current;
      const position = placePanel(rect, panel?.getBoundingClientRect().width ?? Math.min(360, viewport.width - 24), panel ? panel.scrollHeight + 2 : 240, viewport);
      const next = { step, rect, panel: position, target: selector };
      setGeometry(old => JSON.stringify(old) === JSON.stringify(next) ? old : next);
      if (Date.now() < settleUntil) schedule();
    };
    if (panelRef.current) observer.observe(panelRef.current);
    schedule();
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    // React route content can mount after the URL changes, or replace a skeleton.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.querySelector("main") ?? document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame); clearTimeout(polling); observer.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [step, current, pathname, router, retry]);

  const active = geometry?.step === step ? geometry : null;
  const missing = missingStep === step && !active;
  const advance = (value: number) => { setGeometry(null); setMissingStep(null); setStep(value); panelRef.current?.focus({ preventScroll: true }); };
  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="guide-title" aria-describedby="guide-description" className="fixed inset-0 overflow-hidden" style={{ zIndex: 90 }} data-testid="guide-tour">
      {active ? <div data-testid="guide-spotlight" data-guide-target={active.target} aria-hidden="true" className="pointer-events-none fixed rounded-xl border-2 border-accent" style={{ ...active.rect, boxShadow: "0 0 0 9999px rgba(15, 18, 28, 0.55)" }} /> : <div aria-hidden="true" className="absolute inset-0" style={{ background: "rgba(15, 18, 28, 0.55)" }} />}
      <div ref={panelRef} tabIndex={-1} data-testid="guide-tooltip" className="fixed overflow-y-auto rounded-2xl border border-border bg-white p-5 text-ink shadow-2xl outline-none" style={{ left: active?.panel.left ?? 12, top: active?.panel.top ?? 12, width: "min(360px, calc(100vw - 24px))", maxHeight: active?.panel.maxHeight ?? "calc(100dvh - 24px)" }}>
        <div className="mb-3 flex items-center justify-between gap-4"><p className="text-xs font-medium text-accent">使用指南 · {step + 1} / {STEPS.length}</p><button type="button" aria-label="关闭引导" onClick={() => close("skipped")} className="-mr-2 -mt-2 grid size-10 shrink-0 cursor-pointer place-items-center rounded-lg text-ink-dim hover:bg-surface-2"><X className="size-4" /></button></div>
        <div aria-live="polite" aria-atomic="true"><h2 id="guide-title" className="mb-2 text-base font-semibold leading-6">{current.title}</h2><p id="guide-description" className="text-sm leading-6 text-ink-dim">{active ? current.description : missing ? "暂时找不到这个位置。你可以重试，或跳过这一步，继续查看其他功能。" : "正在进入对应页面，定位要介绍的位置…"}</p></div>
        {missing && <button type="button" onClick={() => { setMissingStep(null); setRetry(value => value + 1); }} className="mt-2 min-h-10 cursor-pointer text-sm font-medium text-accent">重新定位</button>}
        <div className="mt-4 flex items-center justify-between gap-1 border-t border-border pt-3"><button type="button" onClick={() => close("skipped")} className="min-h-11 cursor-pointer rounded-lg pr-2 text-xs text-ink-dim hover:text-ink">跳过引导</button><div className="flex items-center gap-1">{step > 0 && <Button variant="ghost" onClick={() => advance(step - 1)} className="min-h-11 px-2 text-xs">上一步</Button>}<Button disabled={!active && !missing} className="min-h-11 px-3 text-xs" onClick={() => step === STEPS.length - 1 ? close(missing ? "skipped" : "completed") : advance(step + 1)}>{step === STEPS.length - 1 ? "完成引导" : missing ? "跳过此步" : "下一步"}</Button></div></div>
      </div>
    </div>, document.body,
  );
}

export function OnboardingModal({ userId, open, autoStart, onClose }: { userId: string; open: boolean; autoStart: boolean; onClose: () => void }) {
  const [automatic, setAutomatic] = useState(false);
  const dismissed = useRef(false);
  const key = `mentora-guide-v2:${userId}`;
  useEffect(() => {
    if (!autoStart) return;
    const timer = setTimeout(() => {
      if (dismissed.current) return;
      try { if (localStorage.getItem(key)) return; } catch { /* Keep the manual entry available when storage is blocked. */ }
      if (!document.querySelector('[aria-modal="true"]')) setAutomatic(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [autoStart, key]);
  const close: Close = status => {
    dismissed.current = true;
    try { localStorage.setItem(key, status); } catch { /* The dismissed ref still prevents reopening in this mounted session. */ }
    setAutomatic(false); onClose();
  };
  return open || automatic ? <SpotlightTour close={close} /> : null;
}
