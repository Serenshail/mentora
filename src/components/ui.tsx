"use client";

import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

/* ---------- Button ---------- */
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
      "bg-gradient-to-r from-[#7c6cff] to-[#5b8cff] text-white hover:brightness-110 shadow-[0_6px_24px_-6px_rgba(124,108,255,0.55)] font-semibold",
    ghost: "text-ink-dim hover:text-ink hover:bg-white/[0.06]",
    outline:
      "border border-border bg-surface/50 text-ink hover:border-accent/50 hover:bg-surface-2",
    danger: "bg-bad/10 text-bad border border-bad/35 hover:bg-bad/20 font-medium",
    ok: "bg-ok/10 text-ok border border-ok/35 hover:bg-ok/20 font-medium",
  };
  const sizes = {
    sm: "h-8 px-3 text-[13px] rounded-[10px]",
    md: "h-10 px-4.5 text-sm rounded-xl",
    lg: "h-12 px-6 text-[15px] rounded-2xl",
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

/* ---------- Card ---------- */
export function Card({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[18px] border border-white/[0.07] bg-surface/80 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_8px_24px_-12px_rgba(0,0,0,0.5)] p-5",
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
    default: "bg-white/8 text-ink border-white/10",
    ok: "bg-ok/12 text-ok border-ok/30",
    warn: "bg-warn/12 text-warn border-warn/30",
    bad: "bg-bad/12 text-bad border-bad/30",
    accent: "bg-accent/15 text-[#b7adff] border-accent/30",
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
        "h-10 w-full rounded-xl border border-white/[0.08] bg-black/25 px-3.5 text-sm text-ink placeholder:text-ink-dim/50 outline-none transition focus:border-accent/60 focus:ring-[3px] focus:ring-accent/15",
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
        "w-full rounded-xl border border-white/[0.08] bg-black/25 px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-dim/50 outline-none transition focus:border-accent/60 focus:ring-[3px] focus:ring-accent/15 resize-none",
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
          <div className="mt-1 flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent-2/10 text-[#b7adff] border border-accent/20">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-[26px] leading-tight font-bold text-white tracking-[-0.03em]">{title}</h1>
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
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#232838" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#pg)"
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
        <defs>
          <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7c6cff" />
            <stop offset="100%" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
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
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-14 px-6 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-surface-2 text-ink-dim">
        {icon}
      </div>
      <p className="font-semibold text-ink">{title}</p>
      {desc && <p className="mt-1.5 max-w-md text-sm text-ink-dim">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ---------- Modal ---------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "animate-rise w-full rounded-2xl border border-border bg-surface p-6 shadow-2xl max-h-[88vh] overflow-y-auto",
          wide ? "max-w-3xl" : "max-w-lg"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-dim hover:bg-white/5 hover:text-ink cursor-pointer"
          >
            ✕
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
    active: "bg-accent-2 shadow-[0_0_8px_rgba(34,211,238,0.8)]",
    passed: "bg-ok",
    skipped: "bg-warn",
    locked: "bg-white/20",
    done: "bg-ok",
    todo: "bg-white/20",
  };
  return <span className={cn("inline-block size-2 rounded-full", map[status] ?? "bg-white/20")} />;
}
