"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Empty, Input, PageHeader, ProgressRing, StatusDot } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { DOMAIN_LABELS, type DomainKind } from "@/lib/types";
import { Compass, GraduationCap, Plus, Trash2 } from "lucide-react";
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
  const [alsoNotes, setAlsoNotes] = useState(true); // 删计划类笔记(总纲要/阶段/目录)
  const [alsoKnowledge, setAlsoKnowledge] = useState(false); // 连知识点(含复习队列)一起删,默认保护

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

      {/* 方向迷茫：第一性原理引导对话 */}
      <DirectionGuideCard />

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
            <div className="mt-3 space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-surface-2/50 p-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={alsoNotes}
                  onChange={(e) => setAlsoNotes(e.target.checked)}
                  className="mt-0.5 size-4 accent-[#5b54e6]"
                />
                <span className="text-ink-dim">
                  同时删除该科目的计划类笔记（总纲要 / 阶段计划 / 目录）。
                  <span className="block text-xs text-ink-dim/70">不勾选则只删目标，笔记全保留。</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.06] p-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={alsoKnowledge}
                  onChange={(e) => setAlsoKnowledge(e.target.checked)}
                  className="mt-0.5 size-4 accent-[#b45309]"
                />
                <span className="text-ink-dim">
                  连知识点笔记一起删（含复习队列里的待复习项）。
                  <span className="block text-xs text-ink-dim/70">这是你的学习成果，默认保留；确认不再需要再勾。</span>
                </span>
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmId(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (alsoNotes) useAppStore.getState().removeGoalAndNotes(confirmId, alsoKnowledge);
                  else removeGoal(confirmId);
                  setConfirmId(null);
                  setAlsoNotes(true);
                  setAlsoKnowledge(false);
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

/* ================= 方向迷茫：第一性原理引导（一次一问，最多 4 轮） ================= */
function DirectionGuideCard() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    boxRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    const next = [...turns, { role: "user" as const, content: text }];
    setTurns(next);
    setBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "direction-guide",
        args: { ctx: "" },
        messages: next.map((t) => ({ role: t.role, content: t.content })),
        temperature: 0.6,
        onDelta: () => {},
      });
      setTurns([...next, { role: "assistant", content: full || "（没收到回复，再试一次）" }]);
    } catch {
      setTurns([...next, { role: "assistant", content: "网络出问题了，稍后再聊。" }]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Card className="mb-4 border-dashed">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">不知道学什么？</p>
            <p className="mt-1 text-xs text-ink-dim">
              不看热门榜。从你自己的事实出发，把方向聊出来（约 4 轮对话）。
            </p>
          </div>
          <Button variant="outline" onClick={() => setOpen(true)}>
            <Compass className="size-4" /> 聊出方向
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">把方向聊出来</p>
        <button
          onClick={() => { setOpen(false); setTurns([]); }}
          className="cursor-pointer text-xs text-ink-dim hover:text-ink"
        >
          收起
        </button>
      </div>
      <div ref={boxRef} className="mt-3 max-h-72 space-y-2.5 overflow-y-auto pr-1">
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
            <div
              className={
                t.role === "user"
                  ? "max-w-[85%] rounded-2xl rounded-br-md bg-[#1a1a1a] px-3 py-2 text-[12.5px] text-white"
                  : "max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink"
              }
            >
              {t.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] text-ink-dim">
            想一下…
          </div>
        )}
        {turns.length === 0 && !busy && (
          <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-dim">
            先从一个小事实开始：抛开"应该学什么"，最近哪件事让你做起来忘记时间？或者哪个问题让你反复烦躁、想解决它？
          </p>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="想到什么说什么…"
        />
        <Button onClick={send} loading={busy} className="shrink-0">
          发送
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-ink-dim/70">
        聊出方向后，把方向填进下面的"想学点什么"，教练接着排计划。
      </p>
    </Card>
  );
}
