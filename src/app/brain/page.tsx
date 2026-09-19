"use client";

import { useState } from "react";
import {
  Badge, Button, Card, Modal,
} from "@/components/ui";
import { GraphView } from "@/components/brain/graph-view";
import { ObsidianImport } from "@/components/brain/obsidian-import";
import { NoteWorkspace } from "@/components/brain/note-workspace";
import { Markdown } from "@/components/markdown";
import { useAppStore, useDueReviews } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { REVIEW_GRADE, REVIEW_PROMPT } from "@/lib/ai/prompts";
import { extractJson, reviewGradeSchema } from "@/lib/ai/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Brain, RefreshCcw } from "lucide-react";

type Tab = "notes" | "graph";

export default function BrainPage() {
  const hydrated = useHydrated();
  const knowledge = useAppStore((s) => s.knowledge);

  const due = useDueReviews();
  const [tab, setTab] = useState<Tab>("notes");
  const [openId, setOpenId] = useState<string | null>(null);
  const [wsMode, setWsMode] = useState<"preview" | "edit">("preview");

  // 复习会话
  const [reviewQueue, setReviewQueue] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"ask" | "answer" | "graded">("ask");
  const [verdict, setVerdict] = useState<{ verdict: string; feedback: string } | null>(null);
  const [busy, setBusy] = useState(false);


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
      {/* 紧凑顶栏：标题 + 统计 + 复习 + Tab */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="flex items-center gap-2 text-[17px] font-bold tracking-[-0.01em] text-ink">
          <Brain className="size-4.5 text-accent" /> 第二大脑
        </h1>
        <span className="text-xs text-ink-dim">
          {knowledge.length} 篇 · 连接 {knowledge.reduce((a, k) => a + k.links.length, 0)}
          {due.length > 0 && (
            <>
              {" "}· 待复习{" "}
              <button onClick={startReview} className="font-semibold text-accent hover:underline cursor-pointer">
                {due.length}
              </button>
            </>
          )}
        </span>
        <div className="ml-auto flex gap-1.5">
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
                "rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition cursor-pointer",
                tab === t
                  ? "border-accent/30 bg-accent/[0.08] font-semibold text-accent"
                  : "border-border bg-white text-ink-dim hover:text-ink"
              )}
            >
              {label}
            </button>
          ))}
        </div>
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
          onGraph={() => setTab("graph")}
          onReview={startReview}
          dueCount={due.length}
          importSlot={<ObsidianImport iconOnly />}
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

    </div>
  );
}



