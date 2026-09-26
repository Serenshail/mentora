"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Empty, Input, PageHeader, ProgressRing, StatusDot } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { DOMAIN_LABELS, type DomainKind } from "@/lib/types";
import { GraduationCap, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

function goalProgress(goals: ReturnType<typeof useAppStore.getState>["goals"][number]) {
  if (!goals.plan) return { done: 0, total: 0, ratio: 0 };
  const days = Object.values(goals.plan.days);
  const done = days.filter((d) => d.status === "passed" || d.status === "skipped").length;
  return { done, total: days.length, ratio: days.length ? done / days.length : 0 };
}

const DOMAIN_TONE: Record<DomainKind, "accent" | "ok" | "warn" | "default" | "dim"> = {
  coding: "accent",
  language: "ok",
  humanities: "warn",
  exam: "default",
  career: "ok",
  other: "dim",
};

export default function LearnPage() {
  const hydrated = useHydrated();
  const router = useRouter();
  const goals = useAppStore((s) => s.goals);
  const removeGoal = useAppStore((s) => s.removeGoal);
  const [topic, setTopic] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [alsoNotes, setAlsoNotes] = useState(true);

  const start = () => {
    const t = topic.trim() || "Python";
    router.push(`/learn/new?topic=${encodeURIComponent(t)}`);
  };

  return (
    <div>
      <PageHeader
        icon={<GraduationCap className="size-5" />}
        title="学习教练"
        desc="先聊几句摸清你的底细，再排计划。每天一课，验收不过不放行。"
      />

      {/* 新目标入口 */}
      <Card className="mb-8">
        <p className="mb-3 text-sm font-semibold text-ink">想学点什么？</p>
        <div className="flex gap-2">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
            placeholder="比如：Python、雅思、政治学、钢琴……"
          />
          <Button onClick={start} className="shrink-0">
            <Plus className="size-4" /> 开始引导
          </Button>
        </div>
        <p className="mt-3 text-xs text-ink-dim">
          教练会先了解你——目的、基础、习惯。问完就开工。
        </p>
      </Card>

      {/* 目标列表 */}
      {!hydrated ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-surface/60" />
          ))}
        </div>
      ) : goals.length === 0 ? (
        <Empty
          icon={<GraduationCap className="size-7" />}
          title="从一门想学的东西开始"
          desc="说出它，教练来安排剩下的。"
        />
      ) : (
        <div className="space-y-4">
          {goals.map((g) => {
            const prog = goalProgress(g);
            return (
              <Card
                key={g.id}
                className={cn(
                  "group card-lift relative cursor-pointer transition-all hover:border-accent/50 hover:bg-surface-2/70"
                )}
                onClick={() =>
                  router.push(g.status === "draft" ? `/learn/new?goal=${g.id}` : `/learn/${g.id}`)
                }
              >
                <div className="flex items-center gap-5">
                  <ProgressRing
                    value={prog.ratio}
                    label={`${prog.total ? Math.round(prog.ratio * 100) : 0}%`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-ink">{g.topic}</h3>
                      <Badge tone={DOMAIN_TONE[g.domainKind]}>{DOMAIN_LABELS[g.domainKind]}</Badge>
                      {g.status === "draft" && <Badge tone="warn">引导中 · 点击继续</Badge>}
                      {g.status === "done" && <Badge tone="ok">已完成</Badge>}
                      {g.status === "paused" && <Badge tone="dim">已暂停</Badge>}
                    </div>
                    <p className="mt-1 truncate text-sm text-ink-dim">
                      {g.direction || "（还在引导对话中，方向未定）"}
                    </p>
                    <p className="mt-2 text-xs text-ink-dim/80">
                      {prog.done}/{prog.total} 天完成 · 每周 {g.weeklyHours} 小时
                      {g.deadline ? ` · 截止 ${g.deadline}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {g.status === "active" && (
                      <Badge tone="accent">
                        <StatusDot status="active" /> 进行中
                      </Badge>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmId(g.id);
                      }}
                      className="rounded-lg p-2 text-ink-dim/60 transition hover:bg-bad/10 hover:text-bad cursor-pointer"
                      aria-label="删除目标"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {confirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px] p-4" onClick={() => setConfirmId(null)}>
          <Card className="max-w-sm animate-rise" onClick={(e) => e.stopPropagation()}>
            <p className="font-bold text-ink">删除这个学习目标？</p>
            <p className="mt-2 text-sm text-ink-dim">计划与验收记录会一并删除。</p>
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-surface-2/50 p-2.5 text-sm">
              <input
                type="checkbox"
                checked={alsoNotes}
                onChange={(e) => setAlsoNotes(e.target.checked)}
                className="mt-0.5 size-4 accent-[#5b54e6]"
              />
              <span className="text-ink-dim">
                同时删除该科目在第二大脑的全部笔记（总纲要 / 阶段计划 / 知识点 / 目录）。
                <span className="block text-xs text-ink-dim/70">不勾选则保留笔记，只删目标。</span>
              </span>
            </label>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmId(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (alsoNotes) useAppStore.getState().removeGoalAndNotes(confirmId);
                  else removeGoal(confirmId);
                  setConfirmId(null);
                  setAlsoNotes(true);
                }}
              >
                删除
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
