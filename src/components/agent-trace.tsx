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
import { useId, useState } from "react";
import { Check, ChevronDown, Circle, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatActivityState } from "@/lib/use-chat";

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
  /* 取消也按文件头契约「失败/取消：明确标红，不伪装成功」标红（透明度略降以与
   * failed 区分）；此前 cancelled 落进默认分支，与 pending 同灰色，展开视图里
   * 已取消的阶段和尚未开始的阶段无法区分。 */
  if (state === "cancelled") return <X className="size-3.5 shrink-0 text-bad/70" />;
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
  const panelId = useId();
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

  /* 折叠/展开共用同一个切换按钮：旧实现是两个互斥 return 分支，切换时把获得焦点
   * 的按钮从 DOM 卸载，键盘焦点掉到 body，得从页面顶部重新 Tab。按钮常驻且同一
   * 元素位（外层容器恒为 div，按钮始终是第一个子节点），焦点不丢；
   * aria-expanded/aria-controls 也与真实可见状态一致。 */
  return (
    <div className={cn("w-fit", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11px] text-ink-dim/80 transition hover:bg-black/[0.03] hover:text-ink-dim cursor-pointer"
      >
        {/* 取消不伪装成功：有取消阶段就不渲染绿勾（契约见文件头） */}
        {anyCancelled ? <Circle className="size-3 text-ink-dim/50" /> : <Check className="size-3 text-ok/80" />}
        <span className="tabular-nums">{summary}</span>
        <ChevronDown className={cn("size-3 shrink-0 opacity-60 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div
          id={panelId}
          aria-live="polite"
          className="mt-1.5 rounded-xl border border-border bg-surface-2/60 px-3 py-2"
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
                      p.state === "failed"
                        ? "text-bad"
                        : p.state === "cancelled"
                          ? "text-bad/80"
                          : p.state === "running"
                            ? "text-ink"
                            : "text-ink-dim"
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
        </div>
      )}
    </div>
  );
}

/** 便捷工厂：一个「思考」阶段（用于没有前置检索的场景） */
export function thinkingPhase(label = "正在思考"): TracePhase {
  return { label, state: "running" };
}

export function ChatActivity({
  activity,
  waitingLabel,
  writingLabel = "正在逐步回复",
}: {
  activity: ChatActivityState;
  waitingLabel: string;
  writingLabel?: string;
}) {
  if (!activity) return null;
  const label = {
    waiting: waitingLabel,
    searching: "正在联网查找资料",
    thinking: "正在组织回答",
    writing: writingLabel,
  }[activity];
  return <AgentTrace phases={[{ label, state: "running" }]} className="w-fit max-w-full" />;
}
