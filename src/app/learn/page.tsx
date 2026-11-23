"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Empty, Input, Modal, PageHeader, ProgressRing, StatusDot, Skeleton, UserBubble } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useChat, useHydrated } from "@/lib/use-chat";
import { DOMAIN_LABELS, type ChatMsg, type DomainKind } from "@/lib/types";
import { BookOpen, ChevronRight, Compass, GraduationCap, Plus, Trash2 } from "lucide-react";
import { NotesEntry } from "@/components/notes-entry";
import { cn } from "@/lib/utils";
import { ChatActivity } from "@/components/agent-trace";
import { ReadWorkspace } from "@/components/read-workspace";



/** 进度语义（E2 验收 2）：已完成 / 已跳过 / 已掌握分别统计，不混成一个百分比。
 *  ratio 只用于圆环（完成+跳过 / 总数）；明细在卡片上分行标注。 */
function goalProgress(goals: ReturnType<typeof useAppStore.getState>["goals"][number]) {
  if (!goals.plan) return { done: 0, total: 0, ratio: 0, passed: 0, skipped: 0, mastered: 0, current: null as string | null };
  const days = Object.values(goals.plan.days);
  const passed = days.filter((d) => d.status === "passed").length;
  const skipped = days.filter((d) => d.status === "skipped").length;
  /* 掌握只认验收证据（知识点 masteryStatus 达 independent 及以上，或当天有验收记录） */
  const mastered = days.filter((d) =>
    (d.knowledgePoints ?? []).some((k) => k.masteryStatus && k.masteryStatus !== "unknown" && k.masteryStatus !== "exposed")
  ).length;
  const done = passed + skipped;
  const currentDay = days.find((d) => d.status === "active");
  return {
    done, total: days.length, ratio: days.length ? done / days.length : 0,
    passed, skipped, mastered, current: currentDay?.title ?? null,
  };
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
  return <Suspense fallback={<Skeleton className="h-64 rounded-2xl" />}><LearnWorkspace /></Suspense>;
}

function LearnWorkspace() {
  const hydrated = useHydrated();
  const router = useRouter();
  const goals = useAppStore((s) => s.goals);
  const removeGoal = useAppStore((s) => s.removeGoal);
  const [topic, setTopic] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [alsoNotes, setAlsoNotes] = useState(true); // 删计划类笔记(总纲要/阶段/目录)
  const [alsoKnowledge, setAlsoKnowledge] = useState(false); // 连知识点(含复习队列)一起删,默认保护
  // URL is the single source: refresh, shared links and same-page navigation agree.
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  useEffect(() => { if (requestedTab === "life") router.replace("/life"); }, [requestedTab, router]);
  const tab = requestedTab === "read" ? "read" : "coach";
  const setTab = (value: "coach" | "read") => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "coach") params.delete("tab");
    else params.set("tab", value);
    const query = params.toString();
    router.replace(query ? `/learn?${query}` : "/learn", { scroll: false });
  };

  const start = () => {
    /* 空输入不兜底成 "Python"：那会建一条垃圾草稿并白烧一次 intake AI 调用，
     * 正是 learn/new 在无 ?topic 时特意修掉的行为。空输入直接不动作。 */
    const t = topic.trim();
    if (!t) return;
    router.push(`/learn/new?topic=${encodeURIComponent(t)}`);
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <PageHeader
          icon={tab === "read" ? <BookOpen className="size-5" /> : <GraduationCap className="size-5" />}
          title={tab === "read" ? "读书伙伴" : "学习"}
          desc={tab === "read" ? "带着问题读，在讨论中理解，把有用的想法留下来。" : "先聊几句摸清底细再排计划，每天一课不过不放行；学过的都沉淀进笔记库。"}
        />
        <NotesEntry />
      </div>

      {/* 学习工作台 tabs（Trae 式：一个工作台，教练与读书两个功能） */}
      <div className="mb-4 flex items-center gap-1.5 rounded-xl border border-border bg-surface-2/50 p-1">
        {([
          { key: "coach", label: "学习教练", icon: GraduationCap },
          { key: "read", label: "读书伙伴", icon: BookOpen },
        ] as const).map((t) => (
          <button
            key={t.key}
            data-guide={t.key === "coach" ? "coach-tab" : "reading-tab"}
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2 py-2 text-xs font-medium transition sm:gap-1.5 sm:px-3 sm:text-[13px]",
              tab === t.key
                ? "bg-white text-ink shadow-sm"
                : "text-ink-dim hover:text-ink"
            )}
          >
            <t.icon className="size-4 shrink-0" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "read" ? (
        <ReadWorkspace />
      ) : (
        <>
      {/* 方向迷茫：第一性原理引导对话 */}
      <DirectionGuideCard />

      {/* 新目标入口：手机纵向堆叠（输入独占一行，按钮全宽 ≥44px），桌面保持横排 */}
      <Card className="mb-8">
        <p className="mb-3 text-sm font-semibold text-ink">想学点什么？</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && start()}
            placeholder="比如：Python、雅思、政治学、钢琴……"
          />
          <Button onClick={start} disabled={!topic.trim()} className="h-11 shrink-0 sm:h-10">
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
            <Skeleton key={i} className="h-28 rounded-2xl bg-surface/60" />
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
          {/* E2：正在进行的项目置顶——用户进来第一眼知道「现在该学什么、点哪里继续」 */}
          {(() => {
            const activeGoal = goals.find((g) => g.status === "active" && g.plan);
            if (!activeGoal) return null;
            const p = goalProgress(activeGoal);
            return (
              <Card className="border-accent/40 bg-accent/[0.04]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">正在学习</p>
                    <h3 className="mt-1 break-words text-lg font-bold text-ink [overflow-wrap:anywhere]">{activeGoal.topic}</h3>
                    <p className="mt-1 break-words text-sm text-ink-dim">
                      {p.current ? `当前任务：${p.current}` : "下一步：开始第一个学习日"}
                    </p>
                    <p className="mt-2 text-xs text-ink-dim/80">
                      已完成 {p.passed} 天 · 已跳过 {p.skipped} 天 · 含掌握证据 {p.mastered} 天 / 共 {p.total} 天
                    </p>
                  </div>
                  <Button
                    className="h-11 shrink-0"
                    onClick={() => router.push(`/learn/${activeGoal.id}`)}
                  >
                    继续学习 <ChevronRight className="size-4" />
                  </Button>
                </div>
              </Card>
            );
          })()}
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
                {/* 移动：纵向三层（进度+标题 → 方向 → 元数据+删除）；桌面保持横排（M4/§5.2） */}
                <div className="flex flex-col items-start gap-3 xl:flex-row xl:items-center xl:gap-5">
                  <div className="flex w-full min-w-0 items-center gap-4 xl:flex-1">
                    <ProgressRing
                      value={prog.ratio}
                      label={`${prog.total ? Math.round(prog.ratio * 100) : 0}%`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 break-words text-base font-bold text-ink [overflow-wrap:anywhere]">
                          {g.topic?.trim() || g.direction?.trim()?.slice(0, 20) || "未命名目标"}
                        </h3>
                        <Badge tone={DOMAIN_TONE[g.domainKind]}>{DOMAIN_LABELS[g.domainKind]}</Badge>
                        {g.status === "draft" && <Badge tone="warn">引导中 · 点击继续</Badge>}
                        {g.status === "done" && <Badge tone="ok">已完成</Badge>}
                        {g.status === "paused" && <Badge tone="dim">已暂停</Badge>}
                      </div>
                      <p className="mt-1 truncate text-sm text-ink-dim">
                        {g.direction || "（还在引导对话中，方向未定）"}
                      </p>
                    </div>
                  </div>
                  <div className="flex w-full min-w-0 flex-wrap items-center gap-2 xl:w-auto xl:max-w-[50%]">
                    <p className="mt-0 min-w-0 flex-1 basis-40 text-xs text-ink-dim/80">
                      <span className="block truncate">
                        完成 {prog.passed} 天 · 跳过 {prog.skipped} 天 · 含掌握证据 {prog.mastered} 天 / 共 {prog.total} 天
                      </span>
                      <span className="block truncate">
                        每周 {g.weeklyHours} 小时{g.deadline ? ` · 截止 ${g.deadline}` : ""}
                      </span>
                    </p>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
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
                        className="tap-target grid place-items-center rounded-lg text-ink-dim/60 transition hover:bg-bad/10 hover:text-bad cursor-pointer"
                        aria-label="删除目标"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
        </>
      )}

      {/* 删除确认：改用设计系统 Modal（手搓 fixed 层没有 role=dialog/焦点陷阱/Esc/滚动锁） */}
      <Modal
        open={!!confirmId}
        onClose={() => setConfirmId(null)}
        title="删除这个学习目标？"
      >
        <p className="text-sm text-ink-dim">计划与验收记录会一并删除。</p>
        <div className="mt-3 space-y-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-surface-2/50 p-2.5 text-sm">
            <input
              type="checkbox"
              checked={alsoNotes}
              onChange={(e) => setAlsoNotes(e.target.checked)}
              /* 用主题令牌：写死色值不会跟随时段主题重映射 */
              className="mt-0.5 size-4 accent-accent"
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
              className="mt-0.5 size-4 accent-warn"
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
              if (alsoNotes) useAppStore.getState().removeGoalAndNotes(confirmId!, alsoKnowledge);
              else removeGoal(confirmId!);
              setConfirmId(null);
              setAlsoNotes(true);
              setAlsoKnowledge(false);
            }}
          >
            删除
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/* ================= 方向迷茫：第一性原理引导（一次一问，最多 4 轮） ================= */
function DirectionGuideCard() {
  const owner = useAppStore((s) => s._storeUserId);
  return <DirectionGuide key={owner ?? "guest"} storageKey={`mentora-direction-guide:${owner ?? "guest"}`} />;
}

function DirectionGuide({ storageKey }: { storageKey: string }) {
  const [open, setOpen] = useState(false);
  const { messages: turns, setMessages: setTurns, activity, pending, streaming: busy, error, send, stop, cancel } = useChat();
  const [input, setInput] = useState("");
  const [restored, setRestored] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        const draft = JSON.parse(localStorage.getItem(storageKey) ?? "null") as {
          open?: boolean;
          turns?: ChatMsg[];
          input?: string;
        } | null;
        if (draft) {
          setOpen(draft.open === true);
          if (Array.isArray(draft.turns)) setTurns(draft.turns);
          if (typeof draft.input === "string") setInput(draft.input);
        }
      } catch { /* A missing local draft leaves the guide empty. */ }
      setRestored(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [setTurns, storageKey]);

  /* 持久化防抖：旧实现依赖数组含 input，每敲一个字符就 JSON.stringify 全量对话历史并
   * 同步写 localStorage（主线程同步 IO）——长会话（几十轮、每轮数 KB）下输入出现可感知
   * 卡顿。400ms 防抖把写入频率钳到停顿一次写一遍；卸载时补写最后一次，防抖窗口内的
   * 键入不丢（补写读 ref 里的最新值，unmount-only effect 不随 dep 变化反复触发）。 */
  const draftRef = useRef({ open, turns, input, restored, storageKey });
  useEffect(() => {
    draftRef.current = { open, turns, input, restored, storageKey };
  });
  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(storageKey, JSON.stringify({ open, turns, input })); }
      catch { /* Keep the current session usable when local storage is unavailable. */ }
    }, 400);
    return () => clearTimeout(t);
  }, [open, turns, input, restored, storageKey]);
  useEffect(() => () => {
    const { open, turns, input, restored, storageKey } = draftRef.current;
    if (!restored) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ open, turns, input })); }
    catch { /* Keep the current session usable when local storage is unavailable. */ }
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy, pending]);

  const sendTurn = (userText?: string) =>
    send({ task: "direction-guide", args: { ctx: "" }, userText, temperature: 0.6 });
  const doSend = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendTurn(text);
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
            <Compass className="size-4" /> {turns.length > 0 ? "继续聊方向" : "聊出方向"}
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
          onClick={() => { cancel(); setOpen(false); }}
          className="cursor-pointer text-xs text-ink-dim hover:text-ink"
        >
          收起
        </button>
      </div>
      <div ref={boxRef} className="mt-3 max-h-72 space-y-2.5 overflow-y-auto pr-1">
        {turns.map((t) => (
          <div key={t.id} className={t.role === "user" ? "flex justify-end" : ""}>
            {t.role === "user" ? (
              /* 用户气泡与 learn/new 同语义气泡共用 ui.UserBubble 一份（令牌+度量真正同源，
               * ink 一旦参与时段主题重映射才跟得上） */
              <UserBubble>{t.content}</UserBubble>
            ) : (
              <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                {t.content}
              </div>
            )}
          </div>
        ))}
        {busy && <ChatActivity activity={activity} waitingLabel="正在读取你的回答" />}
        {busy && pending && (
          <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
            {pending}
            <span className="stream-cursor" />
          </div>
        )}
        {error && <p role="alert" className="text-xs text-bad">{error}</p>}
        {turns.length === 0 && !busy && (
          <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-dim">
            先从一个小事实开始：抛开「应该学什么」，最近哪件事让你做起来忘记时间？或者哪个问题让你反复烦躁、想解决它？
          </p>
        )}
      </div>
      {!busy && turns.at(-1)?.role === "user" && (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void sendTurn()}>继续回答</Button>
      )}
      <div className="mt-3 flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && doSend()}
          placeholder="想到什么说什么…"
        />
        {busy
          ? <Button onClick={stop} variant="outline" className="shrink-0">停止</Button>
          : <Button onClick={doSend} className="shrink-0">发送</Button>}
      </div>
      <p className="mt-2 text-[11px] text-ink-dim/70">
        聊出方向后，把方向填进下面的「想学点什么」，教练接着排计划。
      </p>
    </Card>
  );
}
