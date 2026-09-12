"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Card, Input, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useChat } from "@/lib/use-chat";
import { SOCRATIC_INTAKE, PLANNER } from "@/lib/ai/prompts";
import { extractJson, goalCardSchema, planSchema, type GoalCard } from "@/lib/ai/client";
import { useAppStore } from "@/lib/store";
import { draftToPlan } from "@/lib/plan";
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowRight, Compass, Target } from "lucide-react";

function IntakeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const topicParam = params.get("topic");
  const resumeId = params.get("goal");
  const userName = useAppStore((s) => s.settings.userName);

  const { messages, setMessages, pending, streaming, error, send } = useChat();
  const [input, setInput] = useState("");
  const [card, setCard] = useState<GoalCard | null>(null);
  const [stage, setStage] = useState<"chat" | "confirm" | "planning">("chat");
  const [planStream, setPlanStream] = useState("");
  const [topic, setTopic] = useState(topicParam || "");
  const kicked = useRef(false);

  // 挂载：恢复草稿 或 新建草稿后开场
  useEffect(() => {
    if (kicked.current) return;
    kicked.current = true;
    const store = useAppStore.getState();

    if (resumeId) {
      const draft = store.goals.find((g) => g.id === resumeId && g.status === "draft");
      if (draft) {
        setTopic(draft.topic);
        setMessages(
          draft.intakeTranscript.map((t) => ({
            id: uid("m"),
            role: t.role,
            content: t.content,
            at: new Date().toISOString(),
          }))
        );
        return;
      }
    }

    const t = topicParam || "Python";
    const goalId = uid("goal");
    store.addGoal({
      id: goalId,
      topic: t,
      direction: "",
      domainKind: "other",
      motivation: "",
      background: "",
      weeklyHours: 8,
      successCriteria: [],
      status: "draft",
      createdAt: new Date().toISOString(),
      quizLog: [],
      intakeTranscript: [],
    });
    history.replaceState(null, "", `/learn/new?goal=${goalId}`);
    void send({
      system: SOCRATIC_INTAKE(t, userName),
      userText: `我想学${t}`,
      task: "intake",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每轮对话后持久化到草稿
  useEffect(() => {
    const goalId =
      resumeId || new URLSearchParams(window.location.search).get("goal");
    if (!goalId || messages.length === 0) return;
    useAppStore.getState().updateGoal(goalId, {
      intakeTranscript: messages.map((m) => ({ role: m.role, content: m.content })),
    });
  }, [messages, resumeId]);

  const handleDone = (full: string) => {
    if (stage !== "chat") return;
    if (!full.includes("<!--GOAL_READY-->")) return;
    try {
      const jsonText = full.split("<!--GOAL_READY-->")[1] ?? "";
      const parsed = goalCardSchema.parse(extractJson(jsonText));
      setCard({ ...parsed, deadline: parsed.deadline || undefined });
      setStage("confirm");
    } catch {
      toast.error("目标卡解析失败，请再补充一句，让教练重新总结。");
    }
  };

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send({
      system: SOCRATIC_INTAKE(topic, userName),
      userText: text,
      task: "intake",
      onDone: handleDone,
    });
  };

  // 确认目标卡 → 生成计划
  const confirmCard = async () => {
    if (!card) return;
    const goalId =
      resumeId || new URLSearchParams(window.location.search).get("goal") || "";
    if (!goalId) {
      toast.error("草稿丢失，请回列表重新开始引导");
      return;
    }
    setStage("planning");
    const finalCard = card;

    useAppStore.getState().updateGoal(goalId, {
      topic: finalCard.topic,
      direction: finalCard.direction,
      domainKind: finalCard.domainKind,
      motivation: finalCard.motivation,
      background: finalCard.background,
      weeklyHours: finalCard.weeklyHours,
      learnerProfile: finalCard.learnerProfile || [],
      assumptions: finalCard.assumptions || [],
      successCriteria: finalCard.successCriteria,
      status: "active",
    });

    await send({
      system: PLANNER(JSON.stringify(finalCard, null, 2)),
      userText: "目标卡已确认，请生成学习计划（只要 JSON）。",
      task: "plan",
      onDone: async (full) => {
        setPlanStream(full);
        try {
          const draft = planSchema.parse(extractJson(full));
          const plan = draftToPlan(draft, finalCard);
          useAppStore.getState().setPlan(goalId, plan);
          toast.success("计划生成完毕，开始第一天！");
          router.replace(`/learn/${goalId}`);
        } catch (e) {
          console.error(e);
          toast.error(
            "计划 JSON 解析失败——目标已保存为进行中，可从学习列表进入该目标重试。"
          );
          setStage("confirm");
        }
      },
    });
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent/15 text-[#b7adff] border border-accent/25">
          <Compass className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-white">方向引导：学{topic}</h1>
          <p className="text-xs text-ink-dim">
            教练想真正了解你，会多问几句。对话自动保存，想走就走。
          </p>
        </div>
        {stage === "planning" && <Badge tone="accent">计划生成中…</Badge>}
        {resumeId && stage === "chat" && messages.length > 0 && (
          <Badge tone="ok">已恢复上次对话</Badge>
        )}
      </div>

      {/* 对话区 */}
      <div className="space-y-4">
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2.5 text-sm">
                {m.content}
              </div>
            ) : (
              <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                <Markdown text={m.content.split("<!--GOAL_READY-->")[0]} />
              </Card>
            )}
          </div>
        ))}
        {pending && (
          <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
            <Markdown text={pending.split("<!--GOAL_READY-->")[0]} />
            <span className="stream-cursor" />
          </Card>
        )}
        {error && (
          <p className="text-sm text-bad">{error} —— 可在设置页检查 Key / 网络。</p>
        )}
      </div>

      {/* 目标卡确认 */}
      {stage === "confirm" && card && (
        <Card className="mt-6 animate-rise border-accent/40">
          <div className="mb-4 flex items-center gap-2">
            <Target className="size-5 text-[#b7adff]" />
            <h3 className="font-bold text-white">目标卡确认</h3>
            <Badge tone="accent">可修改</Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-dim sm:col-span-2">
              一句话方向（学完后能做成什么）
              <Input
                className="mt-1"
                value={card.direction}
                onChange={(e) => setCard({ ...card, direction: e.target.value })}
              />
            </label>
            <label className="text-xs text-ink-dim">
              每周可投入（小时）
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={80}
                value={card.weeklyHours}
                onChange={(e) =>
                  setCard({ ...card, weeklyHours: Number(e.target.value) || 8 })
                }
              />
            </label>

            <label className="text-xs text-ink-dim sm:col-span-2">
              学习者画像（教练对你的了解，可修改）
              <Textarea
                className="mt-1"
                rows={3}
                value={(card.learnerProfile ?? []).join("\n")}
                onChange={(e) =>
                  setCard({
                    ...card,
                    learnerProfile: e.target.value.split("\n").filter(Boolean),
                  })
                }
              />
            </label>
            {(card.assumptions?.length ?? 0) > 0 && (
              <div className="rounded-xl border border-warn/30 bg-warn/10 p-3 text-xs text-warn/90 sm:col-span-2">
                <p className="mb-1 font-semibold">教练替你做的假设（不同意就在对话里纠正）：</p>
                <ul className="list-disc pl-4 space-y-0.5">
                  {card.assumptions!.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </div>
            )}
            <label className="text-xs text-ink-dim sm:col-span-2">
              成功标准（每行一条）
              <Textarea
                className="mt-1"
                rows={3}
                value={card.successCriteria.join("\n")}
                onChange={(e) =>
                  setCard({
                    ...card,
                    successCriteria: e.target.value.split("\n").filter(Boolean),
                  })
                }
              />
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setStage("chat")}>
              继续补充
            </Button>
            <Button onClick={confirmCard}>
              确认，生成学习计划 <ArrowRight className="size-4" />
            </Button>
          </div>
        </Card>
      )}

      {/* 计划生成中 */}
      {stage === "planning" && (
        <Card className="mt-6 animate-rise border-accent/40">
          <p className="mb-2 text-sm font-semibold text-white">
            🏗️ 首席学习架构师正在设计「{card?.topic}」的阶段计划…
          </p>
          <pre className="max-h-40 overflow-hidden whitespace-pre-wrap text-xs text-ink-dim">
            {planStream.slice(0, 400) || "…"}
          </pre>
        </Card>
      )}

      {/* 输入框 */}
      {stage === "chat" && (
        <div className="sticky bottom-20 mt-6 md:bottom-4">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSend()}
              placeholder="回答教练的问题…（Enter 发送）"
              disabled={streaming}
            />
            <Button onClick={doSend} loading={streaming} className="shrink-0">
              发送
            </Button>
          </div>
          <button
            onClick={() => {
              if (streaming) return;
              void send({
                system: SOCRATIC_INTAKE(topic, userName),
                userText: "（不想再答了，按已有信息直接给目标卡，缺的写进 assumptions。）",
                task: "intake",
                onDone: handleDone,
              });
            }}
            disabled={streaming}
            className="mt-2 w-full cursor-pointer rounded-xl border border-dashed border-accent/40 py-2 text-xs text-ink-dim transition hover:border-accent/70 hover:text-[#b7adff] disabled:opacity-50"
          >
            ⏭️ 不想再答了 —— 让教练按现有信息直接生成目标与计划
          </button>
        </div>
      )}
    </div>
  );
}

export default function LearnNewPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-ink-dim">加载中…</div>}>
      <IntakeInner />
    </Suspense>
  );
}
