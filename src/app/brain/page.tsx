"use client";

import { useState } from "react";
import {
  Badge, Button, Card, Empty, Input, Modal, PageHeader, ProgressRing,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppStore, useDueReviews } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { REVIEW_GRADE, REVIEW_PROMPT } from "@/lib/ai/prompts";
import { extractJson, reviewGradeSchema } from "@/lib/ai/client";
import { cn, formatDate, REVIEW_INTERVALS, streakFrom, todayISO } from "@/lib/utils";
import { toast } from "sonner";
import { Brain, Flame, Plus, RefreshCcw, Search, Trash2, Zap } from "lucide-react";

export default function BrainPage() {
  const hydrated = useHydrated();
  const knowledge = useAppStore((s) => s.knowledge);
  const goals = useAppStore((s) => s.goals);
  const books = useAppStore((s) => s.books);
  const removeKnowledge = useAppStore((s) => s.removeKnowledge);
  const addKnowledge = useAppStore((s) => s.addKnowledge);

  const due = useDueReviews();
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<string>("all");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");

  // 复习会话状态
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"ask" | "answer" | "graded">("ask");
  const [verdict, setVerdict] = useState<{ verdict: string; feedback: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const domains = Array.from(new Set(knowledge.map((k) => k.domain)));
  const filtered = knowledge.filter(
    (k) =>
      (domain === "all" || k.domain === domain) &&
      (!query.trim() || k.text.includes(query.trim()))
  );
  const streak = streakFrom(knowledge.map((k) => k.masteredAt));
  const weekCount = knowledge.filter((k) => daysAgo(k.masteredAt) < 7).length;

  /* ---- 复习流程 ---- */
  const startReview = async () => {
    if (due.length === 0) return;
    setReviewQueue(due.map((k) => k.id));
    setReviewOpen(true);
    await askNext(due.map((k) => k.id));
  };

  const askNext = async (queue: string[]) => {
    const store = useAppStore.getState();
    const nextId = queue[0];
    if (!nextId) {
      setReviewOpen(false);
      toast.success("今日复习完成！记忆曲线又稳了一格。");
      return;
    }
    const item = store.knowledge.find((k) => k.id === nextId);
    if (!item) {
      setReviewQueue((q) => q.slice(1));
      return;
    }
    setPhase("ask");
    setQuestion("");
    setAnswer("");
    setVerdict(null);
    setBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      await streamChat({
        task: "review-ask",
        system: REVIEW_PROMPT(
          JSON.stringify(
            store.knowledge
              .filter((k) => queue.includes(k.id))
              .map((k) => ({ text: k.text, domain: k.domain }))
          )
        ),
        messages: [{ role: "user", content: "出题。" }],
        onDelta: (d) => setQuestion((p) => p + d),
      });
      setPhase("answer");
    } catch {
      toast.error("复习出题失败，稍后再试");
      setReviewOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const submitAnswer = async () => {
    const id = reviewQueue[0];
    const item = useAppStore.getState().knowledge.find((k) => k.id === id);
    if (!item || !answer.trim()) {
      toast.error("写点什么再提交");
      return;
    }
    setBusy(true);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const full = await streamChat({
        system: REVIEW_GRADE(item.text),
        task: "review-grade",
        messages: [{ role: "user", content: answer }],
        temperature: 0.2,
        onDelta: () => {},
      });
      const g = reviewGradeSchema.parse(extractJson(full));
      setVerdict(g);
      setPhase("graded");
      useAppStore.getState().recordReview(id, g.verdict === "pass");
    } catch {
      toast.error("评分失败，视为通过以继续");
      useAppStore.getState().recordReview(id, true);
      setVerdict({ verdict: "pass", feedback: "（系统离线，默认通过）" });
      setPhase("graded");
    } finally {
      setBusy(false);
    }
  };

  const nextInQueue = () => {
    const rest = reviewQueue.slice(1);
    setReviewQueue(rest);
    void askNext(rest);
  };

  if (!hydrated) return <div className="h-40 animate-pulse rounded-2xl bg-surface/60" />;

  return (
    <div>
      <PageHeader
        icon={<Brain className="size-5" />}
        title="第二大脑"
        desc="每个通过验收的知识点都会沉淀在这里，并按 1/3/7/15 天间隔重复提醒你复习。"
        right={
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> 手动记一条
          </Button>
        }
      />

      {/* 统计卡 */}
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={<Brain className="size-4" />} label="知识总量" value={knowledge.length} unit="条" />
        <StatCard icon={<Zap className="size-4" />} label="本周新增" value={weekCount} unit="条" />
        <StatCard icon={<Flame className="size-4" />} label="连续学习" value={streak} unit="天" />
        <button onClick={startReview} disabled={due.length === 0} className="text-left cursor-pointer disabled:cursor-default">
          <Card className={cn("transition", due.length > 0 && "border-accent/50 hover:bg-surface-2")}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-ink-dim">今日待复习</p>
                <p className={cn("mt-1 text-2xl font-extrabold", due.length > 0 ? "text-[#b7adff]" : "text-ink-dim")}>
                  {due.length} <span className="text-sm font-normal">条</span>
                </p>
              </div>
              <ProgressRing value={knowledge.length ? 1 - due.length / Math.max(1, knowledge.length) : 0} size={44} label="刷" />
            </div>
          </Card>
        </button>
      </div>

      {/* 复习入口 */}
      {due.length > 0 && (
        <Card className="mb-8 flex items-center justify-between border-accent/40 bg-accent/5">
          <div>
            <p className="font-bold text-white">🔔 有 {due.length} 个知识点到了复习日</p>
            <p className="mt-1 text-xs text-ink-dim">
              遗忘曲线不等人。花 5 分钟把它们钉进长期记忆。
            </p>
          </div>
          <Button onClick={startReview}>
            <RefreshCcw className="size-4" /> 开始复习
          </Button>
        </Card>
      )}

      {/* 筛选 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-52">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-dim" />
          <Input
            className="pl-9"
            placeholder="搜索知识点…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          onClick={() => setDomain("all")}
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs cursor-pointer transition",
            domain === "all" ? "border-accent/50 bg-accent/15 text-white" : "border-border text-ink-dim hover:text-ink"
          )}
        >
          全部
        </button>
        {domains.map((d) => (
          <button
            key={d}
            onClick={() => setDomain(d)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs cursor-pointer transition",
              domain === d ? "border-accent/50 bg-accent/15 text-white" : "border-border text-ink-dim hover:text-ink"
            )}
          >
            {d}
          </button>
        ))}
      </div>

      {/* 知识列表 */}
      {filtered.length === 0 ? (
        <Empty
          icon={<Brain className="size-7" />}
          title={knowledge.length === 0 ? "第二大脑还是空的" : "没有匹配的知识点"}
          desc={
            knowledge.length === 0
              ? "在「学习教练」通过验收，或在「读书伙伴」提炼洞见，知识点会自动流进这里。"
              : "换个关键词或筛选条件试试。"
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((k) => (
            <Card key={k.id} className="group">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm leading-relaxed text-ink">{k.text}</p>
                <button
                  onClick={() => removeKnowledge(k.id)}
                  className="rounded-lg p-1 text-ink-dim/60 transition hover:text-bad cursor-pointer"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="accent">{k.domain}</Badge>
                <Badge tone="dim">
                  {k.source === "learn" ? "🎯 学习" : k.source === "read" ? "📖 阅读" : "🧭 伙伴"}
                  · {k.sourceTitle}
                </Badge>
                <span className="text-ink-dim/70">{formatDate(k.masteredAt)} 掌握</span>
                {k.nextReviewAt ? (
                  <Badge tone={k.nextReviewAt <= todayISO() ? "warn" : "default"}>
                    复习：{formatDate(k.nextReviewAt)}
                  </Badge>
                ) : (
                  <Badge tone="ok">记忆已固化</Badge>
                )}
                <span className="ml-auto flex items-center gap-1" title="复习轮次">
                  {REVIEW_INTERVALS.map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        "inline-block size-1.5 rounded-full",
                        i < k.reviewStage ? "bg-ok" : "bg-white/15"
                      )}
                    />
                  ))}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 复习弹窗 */}
      <Modal open={reviewOpen} onClose={() => setReviewOpen(false)} title="间隔复习" wide>
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-ink-dim">
            <span>
              剩余 {reviewQueue.length} / {due.length}
            </span>
            <span>1 → 3 → 7 → 15 天</span>
          </div>
          {phase === "ask" && (
            <div className="py-8 text-center text-sm text-ink-dim">
              <RefreshCcw className="mx-auto mb-3 size-6 animate-spin text-[#b7adff]" />
              正在出题…
            </div>
          )}
          {(phase === "answer" || phase === "graded") && (
            <>
              <Card className="border-accent/40">
                <Markdown text={question} />
              </Card>
              <textarea
                className="w-full rounded-xl border border-border bg-surface-2/80 px-3.5 py-2.5 text-sm outline-none focus:border-accent/70"
                rows={4}
                placeholder="不看笔记，凭回忆写下答案…"
                value={answer}
                disabled={phase === "graded"}
                onChange={(e) => setAnswer(e.target.value)}
              />
              {phase === "graded" && verdict && (
                <Card className={cn("animate-rise", verdict.verdict === "pass" ? "border-ok/50" : "border-bad/50")}>
                  <Badge tone={verdict.verdict === "pass" ? "ok" : "bad"}>
                    {verdict.verdict === "pass" ? "回忆成功" : "有遗忘"}
                  </Badge>
                  <p className="mt-2 text-sm text-ink-dim">{verdict.feedback}</p>
                </Card>
              )}
              <div className="flex justify-end gap-2">
                {phase === "answer" && (
                  <Button onClick={submitAnswer} loading={busy}>
                    提交回忆
                  </Button>
                )}
                {phase === "graded" && (
                  <Button onClick={nextInQueue}>
                    下一个 <RefreshCcw className="size-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* 手动添加 */}
      <Modal open={adding} onClose={() => setAdding(false)} title="记一条知识">
        <Input
          placeholder="知识点内容…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
        />
        <div className="mt-4 flex justify-end">
          <Button
            onClick={() => {
              if (!newText.trim()) return;
              addKnowledge([{ text: newText.trim(), domain: "手动" }], "council", "手动记录");
              setNewText("");
              setAdding(false);
              toast.success("已存入第二大脑");
            }}
          >
            保存
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function daysAgo(iso: string) {
  return Math.round((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400000);
}

function StatCard({
  icon,
  label,
  value,
  unit,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  unit: string;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2 text-ink-dim">
        {icon}
        <p className="text-xs">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-extrabold text-white">
        {value} <span className="text-sm font-normal text-ink-dim">{unit}</span>
      </p>
    </Card>
  );
}
