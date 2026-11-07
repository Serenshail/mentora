"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Empty, Input, Modal, PageHeader, ProgressRing, StatusDot, Skeleton } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { DOMAIN_LABELS, type DomainKind } from "@/lib/types";
import { Brain, BookOpen, Compass, GraduationCap, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { ReadWorkspace } from "@/components/read-workspace";
import { LifeWorkspace } from "@/components/life-workspace";
import { Footprints } from "lucide-react";

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
  /* v23.3：学习 = 教练 + 读书伙伴 两个功能合一个工作台；?tab=read 直达读书 */
  const [tab, setTab] = useState<"coach" | "read" | "life">("coach");
  useEffect(() => {
    /* V26.2-H1：?tab=read 与 ?tab=life 都直达（/life 307 到 ?tab=life，
     * 此前只认 read 导致侧栏「学习人生」永远落在教练 tab）。
     * setState 放进 rAF（effect 里同步 setState 会被 React Compiler
     * 判为「触发级联渲染」，且 URL 是外部状态，首帧读不到 window 也不能崩）。 */
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t !== "read" && t !== "life") return;
    const id = requestAnimationFrame(() => setTab(t));
    return () => cancelAnimationFrame(id);
  }, []);

  const start = () => {
    const t = topic.trim() || "Python";
    router.push(`/learn/new?topic=${encodeURIComponent(t)}`);
  };

  return (
    <div>
      <PageHeader
        icon={<GraduationCap className="size-5" />}
        title="学习"
        desc="先聊几句摸清底细再排计划，每天一课不过不放行；学过的都沉淀进笔记库。"
        right={
          <Link
            href="/brain"
            className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-white px-3 py-2 text-[13px] font-medium text-ink-dim transition hover:border-accent/40 hover:text-ink"
          >
            <Brain className="size-4" /> 笔记库
          </Link>
        }
      />

      {/* 学习工作台 tabs（Trae 式：一个工作台，教练与读书两个功能） */}
      <div className="mb-4 flex items-center gap-1.5 rounded-xl border border-border bg-surface-2/50 p-1">
        {([
          { key: "coach", label: "学习教练", icon: GraduationCap },
          { key: "read", label: "读书伙伴", icon: BookOpen },
          { key: "life", label: "学习人生", icon: Footprints },
        ] as const).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition",
              tab === t.key
                ? "bg-white text-ink shadow-sm"
                : "text-ink-dim hover:text-ink"
            )}
          >
            <t.icon className="size-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "read" ? (
        <ReadWorkspace />
      ) : tab === "life" ? (
        /* V26.2-H1：补上学习人生渲染分支——LifeWorkspace 此前只 import 未渲染，
         * 点 tab/侧栏 /life 进入的永远是教练内容（审计 P0-1） */
        <LifeWorkspace />
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
            onKeyDown={(e) => e.key === "Enter" && start()}
            placeholder="比如：Python、雅思、政治学、钢琴……"
          />
          <Button onClick={start} className="h-11 shrink-0 sm:h-10">
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
                <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
                  <div className="flex w-full min-w-0 items-center gap-4">
                    <ProgressRing
                      value={prog.ratio}
                      label={`${prog.total ? Math.round(prog.ratio * 100) : 0}%`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-bold text-ink">
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
                  <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
                    <p className="mt-0 min-w-0 flex-1 basis-40 text-xs text-ink-dim/80 sm:mt-2 sm:flex-none">
                      <span className="block truncate">
                        {prog.done}/{prog.total} 天完成 · 每周 {g.weeklyHours} 小时
                        {g.deadline ? ` · 截止 ${g.deadline}` : ""}
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
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState("");
  const [phases, setPhases] = useState<TracePhase[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  /* 代际标记：收起面板再重开后旧流可能还在跑，回来时会用过期闭包里的 turns
   * 整体覆盖当前对话（把用户新说的内容抹掉）。只有代际未变才允许写 UI。 */
  const genRef = useRef(0);

  useEffect(() => {
    /* scrollIntoView 挂在滚动容器自身上只滚外层、不动内部 scrollTop：直接滚到底 */
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy, pending]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const gen = ++genRef.current;
    setInput("");
    const next = [...turns, { role: "user" as const, content: text }];
    setTurns(next);
    setBusy(true);
    setPending("");
    const t0 = Date.now();
    setPhases([{ label: "理解你的处境", state: "running" }]);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      setPhases([{ label: "理解你的处境", state: "done", durationMs: Date.now() - t0 }, { label: "想下一步问什么", state: "running" }]);
      const t1 = Date.now();
      const full = await streamChat({
        task: "direction-guide",
        args: { ctx: "" },
        messages: next.map((t) => ({ role: t.role, content: t.content })),
        temperature: 0.6,
        /* 真正把增量显示出来（旧实现 onDelta 是空函数，用户只看到"想一下…"） */
        onDelta: (d) => setPending((p) => p + d),
        onThink: (t) => setPending((p) => p + t),
      });
      setPhases((prev) => prev.map((p) => (p.state === "running" ? { ...p, state: "done", durationMs: Date.now() - t1 } : p)));
      if (gen !== genRef.current) return; // 陈旧流：不覆盖当前对话
      setTurns([...next, { role: "assistant", content: full || pending || "（没收到回复，再试一次）" }]);
    } catch {
      if (gen !== genRef.current) return;
      setPhases((prev) => prev.map((p) => (p.state === "running" ? { ...p, state: "failed" } : p)));
      setTurns([...next, { role: "assistant", content: "网络出问题了，稍后再聊。" }]);
    } finally {
      if (gen === genRef.current) {
        setPending("");
        setBusy(false);
      }
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
                  ? "max-w-[85%] rounded-2xl rounded-br-md bg-[#1d1d1f] px-3 py-2 text-[12.5px] text-white"
                  : "max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink"
              }
            >
              {t.content}
            </div>
          </div>
        ))}
        {busy && pending && (
          <div aria-live="polite" className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
            {pending}
            <span className="stream-cursor" />
          </div>
        )}
        {busy && !pending && <AgentTrace phases={phases} className="max-w-[92%]" />}
        {!busy && phases.length > 0 && <AgentTrace phases={phases} className="max-w-[92%]" />}
        {turns.length === 0 && !busy && (
          <p className="rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-dim">
            先从一个小事实开始：抛开「应该学什么」，最近哪件事让你做起来忘记时间？或者哪个问题让你反复烦躁、想解决它？
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
        聊出方向后，把方向填进下面的「想学点什么」，教练接着排计划。
      </p>
    </Card>
  );
}
