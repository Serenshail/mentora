"use client";

import { useState } from "react";
import {
  Badge, Button, Card, Input, Modal, PageHeader, ProgressRing, Textarea,
} from "@/components/ui";
import { GraphView } from "@/components/brain/graph-view";
import { ObsidianImport } from "@/components/brain/obsidian-import";
import { NoteWorkspace } from "@/components/brain/note-workspace";
import { Markdown } from "@/components/markdown";
import { useAppStore, useDueReviews } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { REVIEW_GRADE, REVIEW_PROMPT } from "@/lib/ai/prompts";
import { extractJson, reviewGradeSchema } from "@/lib/ai/client";
import { cn, streakFrom } from "@/lib/utils";
import { toast } from "sonner";
import {
  Brain, Flame, Link2, Plus, RefreshCcw, Zap,
} from "lucide-react";

type Tab = "notes" | "graph";

export default function BrainPage() {
  const hydrated = useHydrated();
  const knowledge = useAppStore((s) => s.knowledge);
  const addKnowledge = useAppStore((s) => s.addKnowledge);

  const due = useDueReviews();
  const [tab, setTab] = useState<Tab>("notes");
  const [openId, setOpenId] = useState<string | null>(null);
  const [wsMode, setWsMode] = useState<"preview" | "edit">("preview");
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");

  // 复习会话
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"ask" | "answer" | "graded">("ask");
  const [verdict, setVerdict] = useState<{ verdict: string; feedback: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const streak = streakFrom(knowledge.map((k) => k.masteredAt));
  const weekCount = knowledge.filter((k) => daysAgo(k.masteredAt) < 7).length;

  /* ---- 复习流程 ---- */
  const startReview = async () => {
    if (due.length === 0) return;
    setReviewQueue(due.map((k) => k.id));
    setOpenId(null);
    await askNext(due.map((k) => k.id));
  };

  const askNext = async (queue: string[]) => {
    const store = useAppStore.getState();
    const nextId = queue[0];
    if (!nextId) {
      setReviewQueue([]);
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
              .map((k) => ({ title: k.title, summary: k.body.slice(0, 120), domain: k.domain }))
          )
        ),
        messages: [{ role: "user", content: "出题。" }],
        onDelta: (d) => setQuestion((p) => p + d),
      });
      setPhase("answer");
    } catch {
      toast.error("复习出题失败，稍后再试");
      setReviewQueue([]);
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
        task: "review-grade",
        system: REVIEW_GRADE(`${item.title}${item.body ? "（" + item.body.slice(0, 150) + "）" : ""}`),
        messages: [{ role: "user", content: answer }],
        temperature: 0.2,
        onDelta: () => {},
      });
      const g = reviewGradeSchema.parse(extractJson(full));
      setVerdict(g);
      setPhase("graded");
      useAppStore.getState().recordReview(id, g.verdict === "pass");
    } catch {
      useAppStore.getState().recordReview(id, true);
      setVerdict({ verdict: "pass", feedback: "（评分服务异常，默认通过）" });
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
        desc="学过的、想过的，都在这里互相连接。到期的知识点会提醒你。"
        right={
          <div className="flex items-center gap-2">
            <ObsidianImport />
            <Button variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> 新笔记
            </Button>
          </div>
        }
      />

      {/* 统计卡 */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={<Brain className="size-4" />} label="笔记总量" value={knowledge.length} unit="条" />
        <StatCard icon={<Zap className="size-4" />} label="本周新增" value={weekCount} unit="条" />
        <StatCard
          icon={<Link2 className="size-4" />}
          label="连接数"
          value={knowledge.reduce((acc, k) => acc + k.links.length, 0)}
          unit="条"
        />
        <button onClick={startReview} disabled={due.length === 0} className="text-left cursor-pointer disabled:cursor-default">
          <Card className={cn("transition", due.length > 0 && "border-accent/40 hover:bg-surface-2")}>
            <div className="flex items-center justify-between">
              <div>
                <p className="flex items-center gap-1 text-xs text-ink-dim">
                  <Flame className="size-3.5" /> 连续 {streak} 天 · 待复习
                </p>
                <p className={cn("mt-1 text-2xl font-extrabold", due.length > 0 ? "text-accent" : "text-ink-dim")}>
                  {due.length} <span className="text-sm font-normal">条</span>
                </p>
              </div>
              <ProgressRing value={knowledge.length ? 1 - due.length / Math.max(1, knowledge.length) : 0} size={44} label="刷" />
            </div>
          </Card>
        </button>
      </div>

      {/* 复习提醒 */}
      {due.length > 0 && (
        <Card className="mb-6 flex items-center justify-between border-accent/25 bg-accent/[0.04]">
          <div>
            <p className="font-bold text-ink">{due.length} 个知识点快忘了</p>
            <p className="mt-1 text-xs text-ink-dim">趁还记得，刷一遍。</p>
          </div>
          <Button onClick={startReview}>
            <RefreshCcw className="size-4" /> 开始复习
          </Button>
        </Card>
      )}

      {/* Tab 切换 */}
      <div className="mb-4 flex gap-2">
        {(
          [
            ["notes", "笔记"],
            ["graph", "图谱"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-[10px] border px-4 py-2 text-sm font-medium transition cursor-pointer",
              tab === t
                ? "border-accent/30 bg-accent/[0.08] font-semibold text-accent"
                : "border-border bg-white text-ink-dim hover:text-ink hover:border-[#d4d4d8]"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "notes" && (
        <NoteWorkspace
          openId={openId}
          onOpenNote={(id) => {
            setOpenId(id);
            setWsMode("preview");
          }}
          mode={wsMode}
          onModeChange={setWsMode}
        />
      )}

      {tab === "graph" && (
        <Card className="p-3">
          <GraphView
            notes={knowledge}
            onOpen={(id) => {
              setOpenId(id);
              setWsMode("preview");
            }}
          />
          <p className="mt-3 text-center text-xs text-ink-dim">
            拖动节点整理布局 · 点击节点打开笔记 · 连线随内容增长而生长
          </p>
        </Card>
      )}

      {/* 复习弹窗 */}
      <Modal open={reviewQueue.length > 0} onClose={() => setReviewQueue([])} title="间隔复习" wide>
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-ink-dim">
            <span>剩余 {reviewQueue.length} 条</span>
            <span>1 → 3 → 7 → 15 天</span>
          </div>
          {phase === "ask" && (
            <div className="py-8 text-center text-sm text-ink-dim">
              <RefreshCcw className="mx-auto mb-3 size-6 animate-spin text-accent" />
              正在出题…
            </div>
          )}
          {(phase === "answer" || phase === "graded") && (
            <>
              <Card className="border-accent/25">
                <Markdown text={question} />
              </Card>
              <textarea
                className="w-full rounded-[10px] border border-border bg-white px-3.5 py-2.5 text-sm outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12]"
                rows={4}
                placeholder="不看笔记，凭回忆写下答案…"
                value={answer}
                disabled={phase === "graded"}
                onChange={(e) => setAnswer(e.target.value)}
              />
              {phase === "graded" && verdict && (
                <Card className={cn("animate-rise", verdict.verdict === "pass" ? "border-ok/30" : "border-bad/30")}>
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

      {/* 新笔记 */}
      <Modal open={adding} onClose={() => setAdding(false)} title="记一条笔记">
        <div className="space-y-3">
          <Input
            placeholder="标题（如：系统1与认知放松）"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <Textarea
            rows={5}
            placeholder="正文 Markdown，用 [[标题]] 可以链到其他笔记…"
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => {
                if (!newTitle.trim()) return;
                addKnowledge([{ title: newTitle.trim(), body: newBody.trim(), domain: "手动" }], "manual", "手动记录");
                setNewTitle("");
                setNewBody("");
                setAdding(false);
                toast.success("已存入第二大脑");
              }}
            >
              保存
            </Button>
          </div>
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
      <p className="tabular mt-2 text-2xl font-extrabold text-ink">
        {value} <span className="text-sm font-normal text-ink-dim">{unit}</span>
      </p>
    </Card>
  );
}
