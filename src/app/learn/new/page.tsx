"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { NotesEntry } from "@/components/notes-entry";
import { Badge, Button, Card, Input, Textarea, UserBubble } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { ChatActivity } from "@/components/agent-trace";
import { useChat, useHydrated } from "@/lib/use-chat";
import { streamChat } from "@/lib/ai/client";
import { extractJson, splitGoalReply, type GoalCard } from "@/lib/ai/client";
import { useAppStore } from "@/lib/store";
import { masterDraftToPlan, planOutlineNoteTitle, planPhaseNoteTitle } from "@/lib/plan";
import { startPlanTask, getRunningPlanTask, subscribePlanTask } from "@/lib/plan-tasks";
import type { Goal } from "@/lib/types";
import { track } from "@/lib/track";
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowRight, Compass, Target } from "lucide-react";

/** 用已落库的已确认字段重建目标卡：后台总纲要任务失败后要退回 confirm 阶段重试，
 *  但恢复路径没有卡片状态（直接 setStage("confirm") 会既不显示确认卡也不显示输入框）。
 *  字段不全（极旧草稿）返回 null，调用方退回对话阶段。 */
function cardFromConfirmedGoal(goal: Goal | undefined): GoalCard | null {
  if (!goal || goal.status === "draft" || !goal.successCriteria?.length) return null;
  return {
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

/** 流式期间只显示正文：碰到目标卡标记或 json 围栏就截断，避免把 JSON 边生成边刷给用户 */
function proseOnly(text: string) {
  return text.split(/<!--\s*GOAL_READY\s*-->|```json/i)[0];
}

function IntakeInner() {
  const params = useSearchParams();
  const router = useRouter();
  /* V26.1：本目标有在跑的总纲要任务时，页面重挂也显示"后台生成中"，完成自动进入目标页 */
  const [bgTask, setBgTask] = useState(false);
  const [outlineStreaming, setOutlineStreaming] = useState(false);
  const topicParam = params.get("topic");
  const resumeId = params.get("goal");
  const userName = useAppStore((s) => s.settings.userName);

  const { messages, setMessages, pending, activity, streaming, error, setError, send, stop } = useChat();
  const [input, setInput] = useState("");
  const [card, setCard] = useState<GoalCard | null>(null);
  const [stage, setStage] = useState<"chat" | "confirm" | "planning">("chat");
  const [topic, setTopic] = useState(topicParam || "");
  /* 无 ?topic 直接访问：不预建草稿，先让用户填想学什么 */
  const [awaitingTopic, setAwaitingTopic] = useState(false);
  const [topicInput, setTopicInput] = useState("");
  /* resumeId 对应的草稿不存在（已被删除/旧收藏链接）：不能只弹一条 toast 就把界面留在
   * 一个看似可用的引导对话——updateGoal 对不存在的 id 是静默 no-op，此后每轮对话都不落库
   * （刷新即丢），一路走到确认卡还会真实烧一次总纲要生成且结果无处落。置位后整页切换为
   * 持续的不可用提示 + 出口，不再渲染对话区。 */
  const [draftMissing, setDraftMissing] = useState(false);
  /* 点「确认」后的跨标签页互斥检查进行中：fetch 最多 6s，期间按钮 loading 防止无反馈等待 */
  const [startChecking, setStartChecking] = useState(false);
  const hydrated = useHydrated();
  const kicked = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const followReplyRef = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const end = chatEndRef.current;
      if (end) followReplyRef.current = end.getBoundingClientRect().top < window.innerHeight + 100;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stage === "chat" && followReplyRef.current) {
      chatEndRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [messages.length, pending, stage, streaming]);
  /* 恢复路径的订阅退订器：组件卸载/换目标时必须摘掉监听，
   * 否则任务在别的页面失败时仍会对已卸载组件 setState、弹无关 toast。 */
  const unsubPlanRef = useRef<null | (() => void)>(null);

  /* fallbackTopic 必须由调用方显式传入，不能读闭包里的 topic 状态：send 的 onDone 在
   * 流式结束（几十秒后）才执行，startNew / 挂载自愈路径都在 setTopic 的同一同步块里
   * 发起 send，闭包捕获的还是旧值（通常 ""）。模型返回空 topic（真实场景，client.ts
   * 的 goalCardSchema 未限定 topic 非空）时兜底链会拿到旧值 → 卡片 topic 变「未命名目标」，
   * confirmCard 又会把毒化值写进 goal。 */
  const handleDone = (full: string, fallbackTopic: string, expectCard = false) => {
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
      topic: parsed.topic?.trim() || fallbackTopic.trim() || "未命名目标",
      deadline: parsed.deadline || undefined,
    });
    setStage("confirm");
  };

  const handleSkip = (full: string) => handleDone(full, topic, true);

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
      // 同步块里 setTopic 还没生效，兜底 topic 必须显式传 t（见 handleDone 注释）
      onDone: (full) => handleDone(full, t),
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
          setDraftMissing(true);
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
            // setTopic 与 send 同一 raf，闭包 topic 还是旧值：兜底显式传 goal.topic
            onDone: (full) => handleDone(full, goal.topic),
          });
          return;
        }
        // V26.1-B2：总纲要后台任务若在跑（切页/刷新后回来），挂提示并订阅完成自动跳转
        // KV 补充判定（plan-tasks 45s 心跳续期 updatedAt）：
        //   本页注册表还挂着 → 任务仍活（组件重挂），KV 时间戳再旧也别误判；
        //   注册表没有 + 心跳停 4 拍以上（>180s）→ 任务真死了（整页刷新杀掉），标记中断给重试入口；
        //   注册表没有 + 心跳还新鲜 → 任务在另一个标签页活着，如实提示，别诱导用户在两处重复确认。
        void (async () => {
          try {
            const r = await fetch(`/api/tasks?goalId=${resumeId}`, { signal: AbortSignal.timeout(6000) });
            /* 503 = 任务状态库故障（不是"没有任务"）：不能当作空列表静默放过，
             * 否则中断恢复引导永远不出现且用户毫无察觉。如实告知并继续后面的恢复逻辑。
             * 401 是会话过期，由全局鉴权流程处理，这里不重复弹错。 */
            if (!r.ok) {
              if (r.status !== 401) {
                toast.error("暂时读不到上次的生成状态，若计划没出来请点「确认，生成总纲要」重试。");
              }
              return;
            }
            const j = await r.json();
            const t = (j.tasks ?? [])[0];
            if (!t || t.status !== "running") return;
            if (getRunningPlanTask(resumeId)) return; // 本页还活着（订阅路径已接管），心跳在续期
            if (Date.now() - new Date(t.updatedAt).getTime() > 180000) {
              await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...t, status: "interrupted" }) });
              toast("上次的计划生成被页面刷新中断了——点「确认，生成总纲要」再来一次。");
            } else {
              toast("这个目标的总纲要正在另一个标签页生成——等那边完成即可，别在两处同时点「确认」，否则会重复生成。");
            }
          } catch { /* 查询失败不阻塞 */ }
        })();
        if (getRunningPlanTask(resumeId)) {
          setBgTask(true);
          setStage("planning");
          // 生成中卡片标题要显示目标名（恢复路径没有卡片状态）；失败回退时也直接复用
          setCard(cardFromConfirmedGoal(goal));
          /* 恢复路径同样要收口失败：后台任务失败（BYOK 配额耗尽/网络故障）时只处理
           * completed，页面就永远停在"计划生成中…"转圈——输入区被隐藏、无错误、无重试入口。
           * failed/interrupted 都是终态（plan-tasks emit 后即删注册表），一律退回确认阶段，
           * 并用已确认字段重建目标卡（否则 confirm 阶段没有卡片可渲染，仍是白屏）；
           * 字段不全则退回对话，至少输入框可用。 */
          let settled = false;
          const recover = (error?: string) => {
            if (settled) return;
            settled = true;
            unsubPlanRef.current?.();
            unsubPlanRef.current = null;
            setBgTask(false);
            const g = useAppStore.getState().goals.find((x) => x.id === resumeId);
            const rebuiltCard = cardFromConfirmedGoal(g);
            setCard(rebuiltCard);
            setStage(rebuiltCard ? "confirm" : "chat");
            toast.error(
              `总纲要生成失败（${error || "未知原因"}）——目标已保存，点「确认，生成总纲要」再试一次。`
            );
          };
          unsubPlanRef.current = subscribePlanTask(resumeId, (st) => {
            if (st.status === "completed") {
              settled = true;
              const g = useAppStore.getState().goals.find((x) => x.id === resumeId);
              if (g?.plan) router.replace(`/learn/${resumeId}`);
              return;
            }
            if (st.status !== "failed" && st.status !== "interrupted") return;
            recover(st.error || (st.status === "interrupted" ? "已中断" : ""));
          });
          /* 竞态兜底：getRunningPlanTask 与 subscribe 之间任务已结束 → 注册表已删，
           * 订阅退化为空实现、回调永不触发。计划已落库就进目标页，否则按失败恢复
           * （settled 保证与上面的订阅回调不会双重触发）。 */
          if (!getRunningPlanTask(resumeId)) {
            if (useAppStore.getState().goals.find((x) => x.id === resumeId)?.plan) {
              settled = true;
              router.replace(`/learn/${resumeId}`);
            } else {
              recover();
            }
          }
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
            onDone: (full) => handleDone(full, goal.topic),
          });
          return;
        }
        // 优先从上一轮回复里还原目标卡（此前因漏标记卡住的草稿）；
        // 还原不到但有已确认的目标字段（说明是在"生成纲要"阶段刷新），用已确认字段重建确认卡
        const last = transcript[transcript.length - 1];
        const recovered = last?.role === "assistant" ? splitGoalReply(last.content).card : null;
        let rebuilt: GoalCard | null = recovered;
        if (!rebuilt) rebuilt = cardFromConfirmedGoal(goal);
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
    return () => {
      cancelAnimationFrame(raf);
      unsubPlanRef.current?.();
      unsubPlanRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, resumeId]);

  // 每轮对话后持久化到草稿。planning 阶段要跳过——总纲要生成已不走 useChat（V26.1），
  // messages 不会再混入请求与裸 JSON，但 stage 变化本身也会触发本 effect，
  // 这里显式跳过避免把同一份对话在 confirm→planning 切换时重写一遍。
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
      onDone: (full) => handleDone(full, topic),
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
      onDone: (full) => handleDone(full, topic),
    });
  };

  /* 跨标签页 master 互斥检查：另一标签页有新鲜（<180s）running 任务 → false（拒绝启动）。
   * 判定口径与挂载恢复路径一致（陈旧=已被页面刷新杀掉可重试；503/网络故障不拦生成）。
   * KV 无原子 CAS，两个标签页同一瞬间互相通过检查的残余窗口仍在——服务端硬互斥需要
   * db 层跨通道（GitHub/D1/Upstash）条件写语义，属结构性改造，这里先把「明知别处在跑
   * 还放行」的口子收掉。 */
  const confirmNoRemoteMaster = async (goalId: string): Promise<boolean> => {
    try {
      const r = await fetch(`/api/tasks?goalId=${goalId}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return true;
      const j = await r.json();
      const t = (j.tasks ?? [])[0];
      if (!t || t.status !== "running") return true;
      if (Date.now() - new Date(t.updatedAt).getTime() > 180000) return true;
      return false;
    } catch {
      return true; // 查询失败不拦生成（与挂载恢复路径同口径）
    }
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
    /* 行动前硬闸：挂载恢复路径只会 toast 提醒「别在两处同时点确认」，本函数此前对
     * 另一标签页在跑的 master 流毫无拦截——点「确认」照样并发第二条流（双倍 AI 计费；
     * setPlan 后完成者覆盖；纲要笔记 addKnowledge 按标题去重会丢弃后到的一条，
     * 留下的笔记正文里「${topic} 学习计划 · ${phase.title}」的 wikilink 指向先跑完一版的阶段标题，与
     * 最终 plan 永久错位）。检查期间按钮 loading，最多 6s（fetch 超时）。 */
    setStartChecking(true);
    let allowed = true;
    try {
      allowed = await confirmNoRemoteMaster(goalId);
    } finally {
      setStartChecking(false);
    }
    if (!allowed) {
      toast.error("这个目标的总纲要正在另一个标签页生成——去那边等结果即可，不要在两处同时生成（会重复计费且链接会错位）。");
      return;
    }
    setStage("planning");
    setOutlineStreaming(false);
    const finalCard = card;
    /* V26.1 后总纲要生成直接调 streamChat（下方），全程不往 useChat 的 messages 追加内容，
     * planning 阶段输入区/重试按钮也不可达——对话不可能被污染，无需「回滚 messages」。
     * 旧实现在这里捕获 beforeMessages 并在三条失败路径 setMessages(beforeMessages)，
     * 那是 genOutline 还走 send 的年代写下的：同一引用 setMessages 是 no-op，纯误导。 */

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
      let full: string;
      try {
        full = await streamChat({
          args: { mode: "master", cardJson: JSON.stringify(finalCard, null, 2) },
          messages: [{ role: "user", content: "目标卡已确认，请生成总学习纲要（只要 JSON）。" }],
          task: "plan",
          temperature: 0.5,
          signal: planTask.signal,
          onDelta: () => setOutlineStreaming(true),
        });
      } catch (e) {
        /* 失败必须就地收口：confirmCard 是 async onClick，这里若重抛就是 unhandled
         * rejection，页面会永远停在"计划生成中"且无 toast（对比下方空回复/解析失败路径）。
         * 就地恢复后 return，不落进下方空回复分支（避免双重报错）。 */
        planTask.finish(e instanceof Error ? e.message : "生成失败");
        setBgTask(false);
        toast.error(
          `总纲要生成失败（${e instanceof Error ? e.message : "网络异常"}）——目标已保存，点「确认，生成总纲要」再试一次。`
        );
        setStage("confirm");
        return;
      }
      // send 失败时内部已吞掉异常并返回 ""：必须在这里收口，
      // 否则界面永远停在"计划生成中…"（旧实现依赖 onDone，失败就再也不触发）。
      if (!full) {
        /* 必须 finish 收口注册表：旧实现只回退 UI，任务条目仍以 running 留在模块注册表里，
         * 之后切页再回来 getRunningPlanTask 命中 → 订阅"永远在生成"，恢复路径无从脱困。 */
        planTask.finish("模型返回空回复");
        setBgTask(false);
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
        // wikilink 标题与阶段笔记实际落库标题（learn/[id]）共用 plan.ts 的契约函数——
        // 失配即链接静默悬空（点开是空占位），两处不许再手拼
        const outlineMd = plan.phases
          .map((p) => {
            const noteTitle = planPhaseNoteTitle(finalCard.topic, p.title);
            return `- **[[${noteTitle}]]**\n  ${p.outcome}`;
          })
          .join("\n");
        store.addKnowledge(
          [{
            title: planOutlineNoteTitle(finalCard.topic),
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
        toast.error("纲要格式解析失败——目标已保存，可从目标列表进入该目标重试。");
        planTask.finish("parse failed");
        // 同失败路径：角标必须复位，否则"后台生成中"残留在顶部
        setBgTask(false);
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
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="ml-auto order-first flex w-full justify-end"><NotesEntry /></div>
        <div className="flex size-10 items-center justify-center rounded-xl bg-accent/[0.08] text-accent border border-accent/20">
          <Compass className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-ink">方向引导：学{topic || "…"}</h1>
          <p className="text-xs text-ink-dim">
            教练会沿用你已提供的信息。对话会自动保存。
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

      {/* 草稿不存在：整页换成持续提示 + 出口（toast 几秒即消失，界面此前停在可正常对话的假象） */}
      {draftMissing ? (
        <Card className="mt-2">
          <p className="text-sm font-bold text-ink">找不到这次引导的草稿</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-dim">
            它可能已被删除。本页的对话无法再保存（刷新即丢），请回目标列表重新开始一次引导。
          </p>
          <Button className="mt-4" onClick={() => router.push("/learn")}>
            回目标列表
          </Button>
        </Card>
      ) : awaitingTopic ? (
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
                {/* 与 learn/page 方向引导共用 ui.UserBubble 一份，度量不再各写各的 */}
                <UserBubble>{m.content}</UserBubble>
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
        {streaming && stage === "chat" && (
          <ChatActivity activity={activity} waitingLabel="正在读取你的学习需求" writingLabel="正在生成引导回复" />
        )}
        {streaming && stage === "chat" && proseOnly(pending).trim() && (
          <Card className="max-w-[92%] rounded-2xl rounded-bl-md py-4">
            <Markdown text={proseOnly(pending)} />
            <span className="stream-cursor" />
          </Card>
        )}
        {error && (
          <div className="flex flex-wrap items-center gap-3">
            {/* role="alert"：动态插入的错误会被读屏播报（与 learn/page:412 同款流式错误同语义） */}
            <p role="alert" className="text-sm text-bad">{error}</p>
            {/* 文案说"点重试即可"，旧页面却没有重试按钮——弱网错误态下用户无路可走 */}
            {retryable && (
              <Button size="sm" variant="outline" onClick={retryLast} disabled={streaming}>
                重试
              </Button>
            )}
          </div>
        )}
        <div ref={chatEndRef} />
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
            <Button onClick={confirmCard} loading={startChecking}>
              确认，生成总纲要 <ArrowRight className="size-4" />
            </Button>
          </div>
        </Card>
      )}

      {/* 计划生成中 */}
      {stage === "planning" && (
        <Card className="mt-6 animate-rise border-accent/25">
          <ChatActivity
            activity={outlineStreaming ? "writing" : "waiting"}
            waitingLabel="正在整理已确认的目标和时间安排"
            writingLabel="正在生成学习纲要的阶段和验收目标"
          />
          <p className="mt-2 text-xs text-ink-dim">纲要可以在后台继续生成，完成后可从学习列表打开。</p>
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
            {/* 流式中断入口与 learn/page 方向引导同款（busy ? 停止 : 发送）：旧实现流式期间
                输入框/发送钮全禁用，唯一中断方式是离开页面——同一产品两个聊天面，
                一个能停一个不能。useChat.stop 掐断在途流（半截回复不落库）。 */}
            {streaming ? (
              <Button variant="outline" onClick={stop} className="h-11 shrink-0 sm:h-10">
                停止
              </Button>
            ) : (
              <Button onClick={doSend} className="h-11 shrink-0 sm:h-10">
                发送
              </Button>
            )}
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
