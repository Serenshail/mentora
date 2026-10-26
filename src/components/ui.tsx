"use client";

import { cn } from "@/lib/utils";
import { Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

/* ---------- Button ----------
 * 主按钮 = 墨色（Vercel/Linear 式），强调色只留给聚焦与激活态 */
type BtnVariant = "primary" | "ghost" | "outline" | "danger" | "ok";

export function Button({
  className,
  variant = "primary",
  size = "md",
  loading,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const variants: Record<BtnVariant, string> = {
    primary:
      "bg-[#1d1d1f] text-white hover:bg-[#333336] shadow-[0_1px_2px_rgba(0,0,0,0.14)] font-medium",
    ghost: "text-ink-dim hover:text-ink hover:bg-black/[0.045]",
    outline:
      "border border-border bg-white text-ink hover:bg-[#fafafa] hover:border-[#d4d4d8] shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
    danger: "bg-bad/[0.07] text-bad border border-bad/25 hover:bg-bad/[0.12] font-medium",
    ok: "bg-ok/[0.08] text-ok border border-ok/25 hover:bg-ok/[0.13] font-medium",
  };
  const sizes = {
    sm: "h-8 px-3 text-[13px] rounded-[9px]",
    md: "h-10 px-4.5 text-sm rounded-[10px]",
    lg: "h-12 px-6 text-[15px] rounded-xl",
  };
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 tracking-[-0.01em] transition-all duration-150 active:scale-[0.98] disabled:opacity-45 disabled:pointer-events-none cursor-pointer",
        variants[variant],
        sizes[size],
        className
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

/* ---------- Card ----------
 * 纯白卡片浮于微灰纸面：1px 发丝边 + 若有似无的投影 */
export function Card({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-surface shadow-card p-5",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/* ---------- Badge ---------- */
export function Badge({
  className,
  tone = "default",
  children,
}: {
  className?: string;
  tone?: "default" | "ok" | "warn" | "bad" | "accent" | "dim";
  children: ReactNode;
}) {
  const tones = {
    default: "bg-black/[0.045] text-ink border-black/[0.06]",
    ok: "bg-ok/[0.08] text-ok border-ok/25",
    warn: "bg-warn/[0.08] text-warn border-warn/25",
    bad: "bg-bad/[0.07] text-bad border-bad/25",
    accent: "bg-accent/[0.08] text-accent border-accent/20",
    dim: "bg-transparent text-ink-dim border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* ---------- Input / Textarea ---------- */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-[10px] border border-border bg-white px-3.5 text-sm text-ink placeholder:text-ink-dim/60 outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12]",
        className
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-[10px] border border-border bg-white px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-dim/60 outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12] resize-none",
        className
      )}
      {...props}
    />
  );
}

/* ---------- PageHeader ---------- */
export function PageHeader({
  title,
  desc,
  right,
  icon,
}: {
  title: string;
  desc?: string;
  right?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-8">
      <div className="flex items-start gap-3.5">
        {icon && (
          <div className="mt-0.5 flex size-11 items-center justify-center rounded-xl border border-border bg-white text-accent shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-[26px] leading-tight font-bold text-ink tracking-[-0.03em]">{title}</h1>
          {desc && <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-dim max-w-2xl">{desc}</p>}
        </div>
      </div>
      {right}
    </div>
  );
}

/* ---------- ProgressRing ---------- */
export function ProgressRing({
  value,
  size = 56,
  stroke = 5,
  label,
}: {
  value: number; // 0-1
  size?: number;
  stroke?: number;
  label?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, value)));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#ececee" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--color-accent)"
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <span className="absolute text-[11px] font-semibold text-ink">{label}</span>
    </div>
  );
}

/* ---------- Empty ---------- */
export function Empty({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#d8d8dc] bg-white/60 py-14 px-6 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-ink-dim">
        {icon}
      </div>
      <p className="font-semibold text-ink">{title}</p>
      {desc && <p className="mt-1.5 max-w-md text-sm text-ink-dim">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ---------- Modal ----------
 * v17 无障碍补齐：role=dialog + aria-modal + 焦点陷阱（Tab 环回）+ Esc 关闭
 * + 打开时锁滚动 + 关闭后焦点归还触发元素。此前只有 backdrop 点击可关，
 * 键盘/读屏用户开了门出不去。 */
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  /* open=false 时整块卸载：内层 state 自然重置，重开必有 materialize 入场（且无同步 setState） */
  if (!props.open) return null;
  return <ModalDialog {...props} />;
}

function ModalDialog({
  onClose,
  title,
  children,
  wide,
}: {
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const [shown, setShown] = useState(false);

  // 下一拍再开：让 materialize 从当前值过渡（rAF 回调里 setState 合规）
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  /* 焦点陷阱只挂载/卸载各一次（依赖 []）。此前依赖 onClose——调用方都传内联箭头，
   * 父组件每渲染一次（弹窗里打一个字）effect 就重跑：cleanup 把焦点还给旧元素、
   * setTimeout(0) 又抢到右上角关闭按钮 → 输入框打一个字就丢焦点（2026-10-24 修复） */
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const t = setTimeout(() => {
      const items = focusables();
      (items[0] ?? boxRef.current)?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 backdrop-blur-[2px] p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className={cn(
          /* 手机 = bottom sheet（PRD §5.10）：贴底、圆角只在顶部、高度基于 dvh+安全区；
           * ≥sm 保持居中弹窗不变。max-h 同时考虑键盘（--keyboard-inset 由 JS 写入）。 */
          "materialize max-h-[100dvh] w-full overflow-y-auto rounded-t-2xl border border-border bg-white p-4 shadow-overlay outline-none",
          "sm:max-h-[88vh] sm:rounded-2xl md:p-6",
          shown && "open",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg"
        )}
        style={{ paddingBottom: "calc(var(--safe-bottom) + 16px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* sheet 顶部把手：仅在手机显示，承载"这是可关闭的底部弹层"语义 */}
        <div className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-faint sm:hidden" />
        <div className="mb-4 flex items-center justify-between">
          <h3 id={labelId} className="text-lg font-bold text-ink tracking-[-0.02em]">{title}</h3>
          <button
            onClick={onClose}
            className="tap-target -mr-2 -mt-1 grid place-items-center rounded-lg text-ink-dim hover:bg-black/[0.045] hover:text-ink cursor-pointer transition"
            aria-label="关闭"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- 状态点 ---------- */
export function StatusDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-accent",
    passed: "bg-ok",
    skipped: "bg-warn",
    locked: "bg-black/15",
    done: "bg-ok",
    todo: "bg-black/15",
  };
  return <span className={cn("inline-block size-2 rounded-full", map[status] ?? "bg-black/15")} />;
}
