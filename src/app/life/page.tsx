"use client";

/* 学习人生页（借鉴 alice.fans 的"她的生活"）：把学习记录变成可回看的人生流——
 * 朋友圈式时间线（验收通过/跳过/圆桌/掌握里程碑）+ AI 教练定期发帖 + 里程碑相册格。
 * 纯前端聚合现有数据，零新存储；AI 教练帖按需生成（每次进页可刷新一条）。 */

import { useMemo, useState } from "react";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { extractJson } from "@/lib/ai/client";
import { cn } from "@/lib/utils";

interface LifeEvent {
  at: string; // ISO
  kind: "pass" | "skip" | "mastered" | "council" | "book";
  title: string;
  detail?: string;
}

export default function LifePage() {
  const hydrated = useHydrated();
  const goals = useAppStore((s) => s.goals);
  const knowledge = useAppStore((s) => s.knowledge);
  const sessions = useAppStore((s) => s.sessions);
  const userName = useAppStore((s) => s.settings.userName);
  const [post, setPost] = useState<string>("");
  const [postBusy, setPostBusy] = useState(false);

  const events = useMemo<LifeEvent[]>(() => {
    const out: LifeEvent[] = [];
    for (const g of goals) {
      for (const q of g.quizLog ?? []) {
        const day = g.plan?.days[q.dayId];
        out.push({
          at: new Date(q.date).toISOString(),
          kind: q.forced ? "skip" : q.passed ? "pass" : "skip",
          title: q.forced ? `跳过了「${day?.title ?? q.dayId}」` : q.passed ? `通过了「${day?.title ?? q.dayId}」的验收` : `「${day?.title ?? q.dayId}」验收未通过`,
          detail: g.topic,
        });
      }
    }
    for (const k of knowledge) {
      if (k.masteredAt) {
        out.push({ at: new Date(k.masteredAt).toISOString(), kind: "mastered", title: `掌握了「${k.title}」`, detail: k.domain });
      }
    }
    for (const s of sessions) {
      if (s.createdAt) out.push({ at: new Date(s.createdAt).toISOString(), kind: "council", title: `圆桌：${s.title}`, detail: "人生伙伴" });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [goals, knowledge, sessions]);

  const streak = useMemo(() => {
    const days = new Set(events.map((e) => e.at.slice(0, 10)));
    let n = 0;
    const d = new Date();
    for (;;) {
      const key = d.toISOString().slice(0, 10);
      if (days.has(key)) { n++; d.setDate(d.getDate() - 1); }
      else if (n === 0 && key === new Date().toISOString().slice(0, 10)) { d.setDate(d.getDate() - 1); }
      else break;
    }
    return n;
  }, [events]);

  const genPost = async () => {
    if (postBusy) return;
    setPostBusy(true);
    try {
      const recent = events.slice(0, 12).map((e) => ({ date: e.at.slice(5, 10), what: e.title }));
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        task: "life-post",
        args: { events: JSON.stringify(recent), streak },
        messages: [{ role: "user", content: "发一条。" }],
        temperature: 0.7,
        onDelta: () => {},
      });
      setPost(full.trim());
    } catch {
      setPost("今天教练没上线，先自己记录一段。");
    } finally {
      setPostBusy(false);
    }
  };

  const KIND_META: Record<LifeEvent["kind"], { label: string; cls: string }> = {
    pass: { label: "验收通过", cls: "text-ok" },
    skip: { label: "跳过", cls: "text-warn" },
    mastered: { label: "新掌握", cls: "text-accent" },
    council: { label: "圆桌", cls: "text-info" },
    book: { label: "读书", cls: "text-primary" },
  };

  if (!hydrated) return <div className="h-64 animate-pulse rounded-2xl bg-surface/60" />;

  return (
    <div>
      <PageHeader title="学习人生" desc={`${userName || "你"} 的学习足迹——不只是记录，是回看自己怎么走过来的。`} />

      {/* AI 教练的朋友圈动态 */}
      <Card className="mb-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-[#1d1d1f] text-[13px] font-bold text-white">M</div>
            <div>
              <p className="text-[13px] font-bold text-ink">Mentora 教练</p>
              <p className="text-[11px] text-ink-dim/70">你的学习教练 · 每次进来会更新动态</p>
            </div>
          </div>
          <Button variant="outline" size="sm" loading={postBusy} onClick={genPost}>
            {post ? "换一条" : "看教练怎么说"}
          </Button>
        </div>
        <div className="mt-3 whitespace-pre-wrap rounded-xl bg-surface-2/70 p-3.5 text-[13px] leading-relaxed text-ink">
          {post || "点「看教练怎么说」，教练会根据你最近 7 天的真实学习事件，发一条朋友圈式的动态。不编造、不空夸。"}
        </div>
        <p className="mt-2 text-[11px] text-ink-dim/60">连续学习 {streak} 天</p>
      </Card>

      {/* 里程碑相册格（最近 8 个验收通过） */}
      <Card className="mb-5">
        <p className="mb-3 text-sm font-bold text-ink">里程碑</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-8">
          {events.filter((e) => e.kind === "pass").slice(0, 8).map((e, i) => (
            <div
              key={i}
              title={`${e.title}（${e.at.slice(0, 10)}）`}
              className="flex aspect-square flex-col items-center justify-center rounded-xl border border-ok/25 bg-ok/[0.06] p-1 text-center"
            >
              <span className="line-clamp-2 text-[10px] leading-tight text-ok">{e.detail}</span>
              <span className="mt-0.5 text-[9px] text-ink-dim/60">{e.at.slice(5, 10)}</span>
            </div>
          ))}
          {events.filter((e) => e.kind === "pass").length === 0 && (
            <p className="col-span-full py-6 text-center text-xs text-ink-dim">还没有里程碑。第一次验收通过会出现在这里。</p>
          )}
        </div>
      </Card>

      {/* 时间线 */}
      <Card>
        <p className="mb-3 text-sm font-bold text-ink">足迹</p>
        <div className="space-y-0">
          {events.slice(0, 40).map((e, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", e.kind === "pass" ? "bg-ok" : e.kind === "mastered" ? "bg-accent" : e.kind === "council" ? "bg-info" : "bg-ink-dim/30")} />
                {i < Math.min(events.length, 40) - 1 && <span className="w-px flex-1 bg-border" />}
              </div>
              <div className="pb-4">
                <p className="text-[13px] text-ink">
                  <span className={cn("mr-2 text-[11px] font-semibold", KIND_META[e.kind].cls)}>{KIND_META[e.kind].label}</span>
                  {e.title}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-dim/60">{e.at.slice(0, 10)}{e.detail ? ` · ${e.detail}` : ""}</p>
              </div>
            </div>
          ))}
          {events.length === 0 && (
            <p className="py-10 text-center text-sm text-ink-dim">还没有足迹。去学习教练开始第一个目标。</p>
          )}
        </div>
      </Card>
    </div>
  );
}
