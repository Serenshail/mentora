"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, Button, Card, Input, Textarea } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { AgentTrace } from "@/components/agent-trace";
import { useChat, useHydrated } from "@/lib/use-chat";
import { streamChat } from "@/lib/ai/client";
import { extractJson, splitGoalReply, type GoalCard } from "@/lib/ai/client";
import { useAppStore } from "@/lib/store";
import { masterDraftToPlan } from "@/lib/plan";
import { startPlanTask, getRunningPlanTask, subscribePlanTask } from "@/lib/plan-tasks";
import { track } from "@/lib/track";

function planTitle(topic: string) {
  return `${topic} 学习计划`;
}

/** 流式期间只显示正文：碰到目标卡标记或 json 围栏就截断，避免把 JSON 边生成边刷给用户 */
function proseOnly(text: string) {
  return text.split(/<!--\s*GOAL_READY\s*-->|```json/i)[0];
}
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowRight, Compass, Loader2, Target } from "lucide-react";

function IntakeInner() {
  const params = useSearchParams();
  const router = useRouter();
  /* V26.1：本目标有在跑的总纲要任务时，页面重挂也显示"后台生成中"，完成自动进入目标页 */
  const [bgTask, setBgTask] = useState(false);
  const topicParam = params.get("topic");
  const resumeId = params.get("goal");
  const userName = useAppStore((s) => s.settings.userName);

  const { messages, setMessages, pending, thinking, streaming, error, setError, send } = useChat();
  const [input, setInput] = useState("");
  const [card, setCard] = useState<GoalCard | null>(null);
  const [stage, setStage] = useState<"chat" | "confirm" | "planning">("chat");
  const [topic, setTopic] = useState(topicParam || "");
  /* 无 ?topic 直接访问：不预建草稿，先让用户填想学什么 */
  const [awaitingTopic, setAwaitingTopic] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  const hydrated = useHydrated();
  const kicked = useRef(false);

  const handleDone = (full: string, expectCard = false) => {
    // 兼容模型漏掉 <!--GOAL_READY--> 标记的情况：只要回复里有一段合法目标卡 json 就进确认。
    // 教练的普通追问（没带卡）是正常对话流——静默返回，只有明确要求出卡的路径（skip 按钮）才提示。
    const { card: parsed } = splitGoalReply(full);
    if (!parsed) {
      if (expectCard)
        toast.error("这次没拿到完整目标卡——再点一次「不想再答了」让教练重新总结。");
      return;
    }
    setCard({
      ...parsed,
      topic: parsed.topic?.trim() || topic?.trim() || "未命名目标",
      deadline: parsed.deadline || undefined,
    });
    setStage("confirm");
  };

  const handleSkip = (full: string) => handleDone(full, true);

  /* 新建草稿并开场（?topic= 直达，或用户在入口框填写后开始） */
  const startNew = (t: string) => {
    const store = useAppStore.getState();
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
    track("intake_start", { topic: t, resumed: false });
    setTopic(t);
    setAwaitingTopic(false);
    history.replaceState(null, "", `/learn/new?goal=${goalId}`);
    void send({
      args: { topic: t, userName },
      userText: `我想学${t}`,
      task: "intake",
      onDone: handleDone,
    });
  };

  // 挂载：恢复草稿 或 新建草稿后开场。
  // 必须等 store 水合（useHydrated）：persist 是 skipHydration、由 setStoreUser 同步装载，
  // 若在水合前就读 store.goals（空的）会误判"没有草稿"→ 新建并盖掉用户数据，
  // 这正是"刷新后之前的对话全没了"的根因之一。
  useEffect(() => {
    if (!hydrated || kicked.current) return;
    kicked.current = true;
    // 状态初始化挪出 effect 同步体（effect 里直接 setState 会级联渲染，lint 红线）
    const raf = requestAnimationFrame(() => {
      const store = useAppStore.getState();

      if (resumeId) {
        // 只按 id 查，不按 status 过滤：确认目标卡后 status 已置 active（可能已生成计划），
        // 旧实现写死 status==="draft" → 刷新必然匹配不到 → 对话"消失"。
        const goal = store.goals.find((g) => g.id === resumeId);
        if (!goal) {
          toast.error("找不到这次引导的草稿（可能已被删除），请回目标列表重新开始。");
          return;
        }
        setTopic(goal.topic);
        track("intake_start", { topic: goal.topic, resumed: true });
        const transcript = goal.intakeTranscript ?? [];
        const restored = transcript.map((t) => ({
          id: uid("m"),
          role: t.role,
          content: t.content,
          at: new Date().toISOString(),
        }));
        setMessages(restored);
        // 总纲要已在：直接回目标页，别让用户对着确认卡再点一次
        if (goal.plan) {
          router.replace(`/learn/${resumeId}`);
          return;
        }
        // 自愈：本页新建草稿后会 replaceState 写上 ?goal=，Next 的 useSearchParams
        // 随即更新 → 组件重挂 → 这里会以"恢复"路径再进来一次。
        // 此时 transcript 是空的（首轮还没落库），必须重新开场，绝不能留白。
        if (transcript.length === 0) {
          void send({
            args: { topic: goal.topic, userName },
            userText: `我想学${goal.topic}`,
            task: "intake",
            onDone: handleDone,
          });
          return;
        }
        // V26.1-B2：总纲要后台任务若在跑（切页/刷新后回来），挂提示并订阅完成自动跳转
        if (getRunningPlanTask(resumeId)) {
          setBgTask(true);
          setStage("planning");
          subscribePlanTask(resumeId, (st) => {
            if (st.status === "completed") {
              const g = useAppStore.getState().goals.find((x) => x.id === resumeId);
              if (g?.plan) router.replace(`/learn/${resumeId}`);
            }
          });
          return;
        }
        // 上一轮是用户发言、回复还没到（重挂/刷新打断了在途请求）：原样重试这一轮
        const lastIdx = transcript.length - 1;
        if (transcript[lastIdx].role === "user") {
          void send({
            args: { topic: goal.topic, userName },
            history: restored.slice(0, lastIdx),
            userText: transcript[lastIdx].content,
            task: "intake",
            onDone: handleDone,
          });
          return;
        }
        // 优先从上一轮回复里还原目标卡（此前因漏标记卡住的草稿）；
        // 还原不到但有已确认的目标字段（说明是在"生成纲要"阶段刷新），用已确认字段重建确认卡
        const last = transcript[transcript.length - 1];
        const recovered = last?.role === "assistant" ? splitGoalReply(last.content).card : null;
        let rebuilt: GoalCard | null = recovered;
        if (!rebuilt && goal.status !== "draft" && goal.successCriteria?.length) {
          rebuilt = {
            topic: goal.topic,
            direction: goal.direction,
            domainKind: goal.domainKind,
            motivation: goal.motivation,
            background: goal.background,
            deadline: undefined,
            weeklyHours: goal.weeklyHours,
            learnerProfile: goal.learnerProfile ?? [],
            successCriteria: goal.successCriteria,
            assumptions: goal.assumptions ?? [],
          };
        }
        if (rebuilt) {
          setCard({ ...rebuilt, deadline: rebuilt.deadline || undefined });
          setStage("confirm");
        }
        return;
      }

      // 无 ?topic 访问：旧版直接 addGoal 一条 "Python" 草稿并烧一次 intake AI 调用，
      // 多次访问累积垃圾草稿。现在先展示输入引导，用户填了才建草稿
      if (!topicParam) {
        setAwaitingTopic(true);
        return;
      }
      startNew(topicParam);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, resumeId]);

  // 每轮对话后持久化到草稿。planning 阶段要跳过——那时 messages 里混进了
  // "请生成总学习纲要"的请求与整段总纲要 JSON，写进 intakeTranscript 会污染对话记录。
  useEffect(() => {
    if (stage === "planning") return;
    const goalId =
      resumeId || new URLSearchParams(window.location.search).get("goal");
    if (!goalId || messages.length === 0) return;
    useAppStore.getState().updateGoal(goalId, {
      intakeTranscript: messages.map((m) => ({ role: m.role, content: m.content })),
    });
  }, [messages, resumeId, stage]);

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send({
      args: { topic, userName },
      userText: text,
      task: "intake",
      onDone: handleDone,
    });
  };

  /* 失败后可重试：把最后一条用户消息原样再发一次（历史里去掉它，避免重复上屏）。
   * 只有真的有一条待重试的提问时才出现按钮，避免误导。 */
  const retryable = messages.length > 0 && messages[messages.length - 1]?.role === "user";
  const retryLast = () => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "user" || streaming) return;
    setError(null);
    void send({
      args: { topic, userName },
      userText: last.content,
      history: messages.slice(0, -1),
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
    // 生成纲要会往对话里追加"请求 + 整段 JSON"。失败回滚到这一步之前，
    // 否则持久化会把请求和裸 JSON 写进 intakeTranscript，刷新后对话就脏了。
    const beforeMessages = messages;

    useAppStore.getState().updateGoal(goalId, {
      /* 防脏数据：模型可能返回空 topic，直接用会把列表卡片标题写空 */
      topic: finalCard.topic?.trim() || topic?.trim() || "未命名目标",
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
    track("intake_complete", {
      domainKind: finalCard.domainKind,
      weeklyHours: finalCard.weeklyHours,
      criteria: finalCard.successCriteria.length,
    });

    /* V26.1 P0-B2：总纲要生成脱离 useChat（页面卸载即 abort），
     * 挂到模块级任务注册表 + KV 状态——切页/回页/刷新都能接续或恢复结果。 */
    const planTask = startPlanTask(goalId, "master");
    setBgTask(true);
    await (async () => {
      const full = await streamChat({
        args: { mode: "master", cardJson: JSON.stringify(finalCard, null, 2) },
        messages: [{ role: "user", content: "目标卡已确认，请生成总学习纲要（只要 JSON）。" }],
        task: "plan",
        temperature: 0.5,
        signal: planTask.signal,
        onDelta: () => {},
      }).catch((e: unknown) => {
        planTask.finish(e instanceof Error ? e.message : "生成失败");
        throw e;
      });
      // send 失败时内部已吞掉异常并返回 ""：必须在这里收口，
      // 否则界面永远停在"计划生成中…"（旧实现依赖 onDone，失败就再也不触发）。
      if (!full) {
        setMessages(beforeMessages);
        toast.error("总纲要生成失败——目标已保存，点下面「确认，生成总纲要」再试一次。");
        setStage("confirm");
        return;
      }
      try {
        const { masterPlanSchema } = await import("@/lib/ai/client");
        const draft = masterPlanSchema.parse(extractJson(full));
        const plan = masterDraftToPlan(draft, finalCard);
        useAppStore.getState().setPlan(goalId, plan);
        track("plan_generated", { phases: plan.phases.length });
        // 总计划入第二大脑关系链
        const store = useAppStore.getState();
        // 链接标题必须与阶段笔记实际标题完全一致(${planTitle} · ${phase.title}),否则点开是空占位
        const outlineMd = plan.phases
          .map((p) => {
            const noteTitle = `${planTitle(finalCard.topic)} · ${p.title}`;
            return `- **[[${noteTitle}]]**\n  ${p.outcome}`;
          })
          .join("\n");
        store.addKnowledge(
          [{
            title: `${planTitle(finalCard.topic)} · 学习总纲要`,
            body: `**方向：**${finalCard.direction}\n\n${plan.summary}\n\n${outlineMd}`,
            domain: `${finalCard.topic}/计划`,
          }],
          "learn",
          `${finalCard.topic} · 总纲要`
        );
        toast.success("总纲要已生成。第一阶段的天级计划在目标页一键生成。");
        planTask.finish();
        setBgTask(false);
        router.replace(`/learn/${goalId}`);
      } catch (e) {
        console.error(e);
        setMessages(beforeMessages);
        toast.error("纲要格式解析失败——目标已保存，可从目标列表进入该目标重试。");
        planTask.finish("parse failed");
        setStage("confirm");
      }
    })();
  };

  return (
    <div className="mx-auto max-w-3xl">
      {!hydrated ? (
        <div className="py-20 text-center text-sm text-ink-dim">正在载入你的学习数据…</div>
      ) : (
      <>
      <div className="mb-5 flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent/[0.08] text-accent border border-accent/20">
          <Compass className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-ink">方向引导：学{topic || "…"}</h1>
          <p className="text-xs text-ink-dim">
            教练想真正了解你，会多问几句。对话自动保存，想走就走。
          </p>
        </div>
        {stage === "planning" && <Badge tone="accent">计划生成中…</Badge>}
        {bgTask && <Badge tone="accent">后台生成中——切页不会中断</Badge>}
        {resumeId && stage === "chat" && messages.length > 0 && (
          <Badge tone="ok">已恢复上次对话</Badge>
        )}
        {/* 退出入口：草稿已实时落盘随时可走；planning 也不收回——
         * 旧版生成中只剩刷新一条路（离页会中止在途流并回滚，目标已保存可重试） */}
        <button
          onClick={() => router.push("/learn")}
          className="ml-auto cursor-pointer rounded-lg border border-border px-3 py-1.5 text-xs text-ink-dim transition hover:border-accent/50 hover:text-accent"
        >
          退出引导
        </button>
      </div>

      {/* 无 ?topic 直达：先问想学什么，不再预建 "Python" 垃圾草稿 */}
      {awaitingTopic ? (
        <Card className="mt-2">
          <p className="text-sm font-semibold text-ink">想学什么？</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-dim">
            一句话告诉教练，比如「我想学 Python」「我要考雅思」。
          </p>
          <div className="mt-4 flex gap-2">
            <Input
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && topicInput.trim()) {
                  startNew(topicInput.trim());
                }
              }}
              placeholder="想学的东西…"
              autoFocus
            />
            <Button
              onClick={() => topicInput.trim() && startNew(topicInput.trim())}
              disabled={!topicInput.trim()}
            >
              开始引导
            </Button>
          </div>
        </Card>
      ) : (
      <>
      {/* 对话区 */}
      <div className="space-y-4">
        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-white">
                  {m.content}
                </div>
              </div>
            );
          }
          // 目标卡 json 不展示给用户：只渲染正文，正文为空则整条气泡不显示
          const prose = splitGoalReply(m.content).prose;
          if (!prose) return null;
          return (
            <div key={m.id}>
              <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
                <Markdown text={prose} />
              </Card>
            </div>
          );
        })}
        {pending && stage !== "planning" && (
          <Card aria-live="polite" className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
            <Markdown text={proseOnly(pending)} />
            <span className="stream-cursor" />
          </Card>
        )}
        {/* 首字之前的空白期：显示思考骨架，避免"点了没反应" */}
        {streaming && !pending && stage !== "planning" && (
          <div className="max-w-[92%]">
            <AgentTrace
              phases={[
                { label: thinking ? "思考中" : "理解你的回答", state: "running", detail: thinking || undefined },
              ]}
            />
          </div>
        )}
        {error && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-bad">{error}</p>
            {/* 文案说"点重试即可"，旧页面却没有重试按钮——弱网错误态下用户无路可走 */}
            {retryable && (
              <Button size="sm" variant="outline" onClick={retryLast} disabled={streaming}>
                重试
              </Button>
            )}
          </div>
        )}
      </div>

      {/* 目标卡确认 */}
      {stage === "confirm" && card && (
        <Card className="mt-6 animate-rise border-accent/25">
          <div className="mb-4 flex items-center gap-2">
            <Target className="size-5 text-accent" />
            <h3 className="font-bold text-ink">目标卡确认</h3>
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
              <div className="rounded-xl border border-warn/25 bg-warn/[0.06] p-3 text-xs text-warn sm:col-span-2">
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
              确认，生成总纲要 <ArrowRight className="size-4" />
            </Button>
          </div>
        </Card>
      )}

      {/* 计划生成中 */}
      {stage === "planning" && (
        <Card className="mt-6 animate-rise border-accent/25">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <Loader2 className="size-4 animate-spin text-accent" />
            正在设计「{card?.topic}」的总学习纲要…
          </p>
          <pre className="max-h-40 overflow-hidden whitespace-pre-wrap text-xs text-ink-dim">
            {pending.slice(0, 400) || "…"}
          </pre>
        </Card>
      )}

      {/* 输入框 */}
      {stage === "chat" && (
        <div className="above-mobile-nav sticky mt-6">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // isComposing：中文输入法选词回车不算发送
                if (e.key === "Enter" && !e.nativeEvent.isComposing) doSend();
              }}
              placeholder="回答教练的问题…（Enter 发送）"
              disabled={streaming}
            />
            <Button onClick={doSend} loading={streaming} className="h-11 shrink-0 sm:h-10">
              发送
            </Button>
          </div>
          <button
            onClick={() => {
              if (streaming) return;
              void send({
                args: { topic, userName },
                userText: "（不想再答了，按已有信息直接给目标卡，缺的写进 assumptions。）",
                task: "intake",
                onDone: handleSkip,
              });
            }}
            disabled={streaming}
            className="mt-2 w-full cursor-pointer rounded-xl border border-dashed border-accent/30 py-2 text-xs text-ink-dim transition hover:border-accent/60 hover:text-accent disabled:opacity-50"
          >
            ⏭️ 不想再答了 —— 让教练按现有信息直接生成目标与计划
          </button>
        </div>
      )}
      </>
      )}
      </>
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
