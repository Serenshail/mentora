"use client";

/* AgentTrace：智能体活动轨迹（参照 shadcn/ui AI Elements 的 Trace / Reasoning / Plan）
 *
 * 解决的问题：模型调用（尤其 RAG 改写+精排）在首 token 前有数秒空白，
 * 用户以为页面卡死。规则：
 *  - 进行中：逐阶段展开（检索笔记 → 思考回答），每阶段带状态图标；
 *  - 全部完成：折叠成一行「检索 0.3s · 思考 2.1s」，点击可展开；
 *  - 失败/取消：明确标红，不伪装成功。
 * 所有智能体活动统一用这一套渲染，不要各页面自己画。
 */
import { useState } from "react";
import { Check, ChevronDown, Circle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type TraceState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface TracePhase {
  label: string;
  state: TraceState;
  durationMs?: number;
  /** 补充说明，如「检索失败，改用通识回答」 */
  detail?: string;
}

function fmtMs(ms?: number): string {
  if (ms == null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function PhaseIcon({ state }: { state: TraceState }) {
  if (state === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />;
  if (state === "done") return <Check className="size-3.5 shrink-0 text-ok" />;
  if (state === "failed") return <X className="size-3.5 shrink-0 text-bad" />;
  return <Circle className="size-3.5 shrink-0 text-ink-dim/40" />;
}

export function AgentTrace({
  phases,
  className,
}: {
  phases: TracePhase[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (phases.length === 0) return null;

  const anyRunning = phases.some((p) => p.state === "running");
  const anyFailed = phases.some((p) => p.state === "failed");
  const anyCancelled = phases.some((p) => p.state === "cancelled");
  const expanded = anyRunning || anyFailed || open;

  const summary = phases
    .map((p) => {
      const label =
        p.state === "failed" ? `${p.label}（失败）`
        : p.state === "cancelled" ? `${p.label}（已取消）`
        : p.label;
      return p.durationMs != null ? `${label} ${fmtMs(p.durationMs)}` : label;
    })
    .join(" · ");

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] text-ink-dim/80 transition hover:bg-black/[0.03] hover:text-ink-dim cursor-pointer",
          className
        )}
      >
        {/* 取消不伪装成功：有取消阶段就不渲染绿勾（契约见文件头） */}
        {anyCancelled ? <Circle className="size-3 text-ink-dim/50" /> : <Check className="size-3 text-ok/80" />}
        <span className="tabular-nums">{summary}</span>
        <ChevronDown className="size-3 opacity-60" />
      </button>
    );
  }

  return (
    <div
      aria-live="polite"
      className={cn("rounded-xl border border-border bg-surface-2/60 px-3 py-2", className)}
    >
      <div className="relative space-y-1.5">
        {/* 左侧竖线：所有阶段共用一条轨迹（shadcn Trace 的统一视觉语汇） */}
        <span className="absolute bottom-1 left-[6.5px] top-1 w-px bg-border" aria-hidden />
        {phases.map((p, i) => (
          <div key={`${p.label}-${i}`} className="relative flex items-start gap-2 pl-0">
            <span className="relative z-[1] grid size-3.5 shrink-0 place-items-center rounded-full bg-surface-2">
              <PhaseIcon state={p.state} />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "flex items-baseline gap-1.5 text-[11.5px] leading-4",
                  p.state === "failed" ? "text-bad" : p.state === "running" ? "text-ink" : "text-ink-dim"
                )}
              >
                <span>{p.label}</span>
                {p.durationMs != null && (
                  <span className="tabular-nums text-[10.5px] text-ink-dim/60">{fmtMs(p.durationMs)}</span>
                )}
              </p>
              {p.detail && <p className="mt-0.5 text-[10.5px] leading-4 text-ink-dim/70">{p.detail}</p>}
            </div>
          </div>
        ))}
      </div>
      {!anyRunning && !anyFailed && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-1 cursor-pointer text-[10.5px] text-ink-dim/60 hover:text-ink-dim"
        >
          收起
        </button>
      )}
    </div>
  );
}

/** 便捷工厂：一个「思考」阶段（用于没有前置检索的场景） */
export function thinkingPhase(label = "正在思考"): TracePhase {
  return { label, state: "running" };
}
