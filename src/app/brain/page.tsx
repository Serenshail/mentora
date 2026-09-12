"use client";

import { useMemo, useState } from "react";
import {
  Badge, Button, Card, Empty, Input, Modal, PageHeader, ProgressRing, Textarea,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { GraphView } from "@/components/brain/graph-view";
import { WikiMarkdown } from "@/components/brain/wiki-markdown";
import { useAppStore, useDueReviews } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { REVIEW_GRADE, REVIEW_PROMPT, AUTOLINK } from "@/lib/ai/prompts";
import { extractJson, reviewGradeSchema, autolinkSchema } from "@/lib/ai/client";
import { cn, formatDate, REVIEW_INTERVALS, streakFrom, todayISO } from "@/lib/utils";
import type { KnowledgeItem } from "@/lib/types";
import { toast } from "sonner";
import {
  Brain, Flame, GitBranch, Link2, Pencil, Plus, RefreshCcw, Search, Sparkles, Trash2, Zap,
} from "lucide-react";

type Tab = "notes" | "graph";

export default function BrainPage() {
  const hydrated = useHydrated();
  const knowledge = useAppStore((s) => s.knowledge);
  const removeKnowledge = useAppStore((s) => s.removeKnowledge);
  const addKnowledge = useAppStore((s) => s.addKnowledge);

  const due = useDueReviews();
  const [tab, setTab] = useState<Tab>("notes");
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
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

  const domains = useMemo(() => Array.from(new Set(knowledge.map((k) => k.domain))), [knowledge]);
  const filtered = useMemo(
    () =>
      knowledge.filter(
        (k) =>
          (domain === "all" || k.domain === domain) &&
          (!query.trim() ||
            k.title.includes(query.trim()) ||
            k.body.includes(query.trim()))
      ),
    [knowledge, query, domain]
  );
  const streak = streakFrom(knowledge.map((k) => k.masteredAt));
  const weekCount = knowledge.filter((k) => daysAgo(k.masteredAt) < 7).length;
  const openNote = (openId ? knowledge.find((k) => k.id === openId) : null) ?? null;

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
        desc="Obsidian 式双链知识库：用 [[标题]] 连接笔记，自己建立联系或让 AI 建议连线；知识点自动流入并按 1/3/7/15 天复习。"
        right={
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> 新笔记
          </Button>
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
          <Card className={cn("transition", due.length > 0 && "border-accent/50 hover:bg-surface-2")}>
            <div className="flex items-center justify-between">
              <div>
                <p className="flex items-center gap-1 text-xs text-ink-dim">
                  <Flame className="size-3.5" /> 连续 {streak} 天 · 待复习
                </p>
                <p className={cn("mt-1 text-2xl font-extrabold", due.length > 0 ? "text-[#b7adff]" : "text-ink-dim")}>
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
        <Card className="mb-6 flex items-center justify-between border-accent/40 bg-accent/5">
          <div>
            <p className="font-bold text-white">🔔 有 {due.length} 个知识点到了复习日</p>
            <p className="mt-1 text-xs text-ink-dim">遗忘曲线不等人，花 5 分钟把它们钉进长期记忆。</p>
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
            ["notes", "📒 笔记库"],
            ["graph", "🕸️ 关系图谱"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-xl border px-4 py-2 text-sm font-medium transition cursor-pointer",
              tab === t
                ? "border-accent/60 bg-accent/15 text-white"
                : "border-border text-ink-dim hover:text-ink"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "notes" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-dim" />
              <Input
                className="pl-9"
                placeholder="搜索标题与正文…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <FilterChip active={domain === "all"} onClick={() => setDomain("all")}>
              全部
            </FilterChip>
            {domains.map((d) => (
              <FilterChip key={d} active={domain === d} onClick={() => setDomain(d)}>
                {d}
              </FilterChip>
            ))}
          </div>

          {filtered.length === 0 ? (
            <Empty
              icon={<Brain className="size-7" />}
              title={knowledge.length === 0 ? "第二大脑还是空的" : "没有匹配的笔记"}
              desc={
                knowledge.length === 0
                  ? "在「学习教练」通过验收、在「读书伙伴」提炼洞见，笔记会自动流进这里；也可以手动记录。"
                  : "换个关键词或筛选条件试试。"
              }
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {filtered.map((k) => (
                <NoteCard key={k.id} note={k} onOpen={() => setOpenId(k.id)} onDelete={() => removeKnowledge(k.id)} />
              ))}
            </div>
          )}
        </>
      )}

      {tab === "graph" && (
        <Card className="p-3">
          <GraphView notes={knowledge} onOpen={(id) => setOpenId(id)} />
          <p className="mt-3 text-center text-xs text-ink-dim">
            拖动节点整理布局 · 点击节点打开笔记 · 连线随内容增长而生长
          </p>
        </Card>
      )}

      {/* 笔记详情 */}
      <NoteModal note={openNote} notes={knowledge} onClose={() => setOpenId(null)} onOpenNote={(id) => setOpenId(id)} />

      {/* 复习弹窗 */}
      <Modal open={reviewQueue.length > 0} onClose={() => setReviewQueue([])} title="间隔复习" wide>
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-ink-dim">
            <span>剩余 {reviewQueue.length} 条</span>
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

/* ================= 笔记卡片 ================= */
function NoteCard({
  note,
  onOpen,
  onDelete,
}: {
  note: KnowledgeItem;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const notes = useAppStore((s) => s.knowledge);
  const linkedTitles = note.links
    .map((l) => notes.find((n) => n.id === l)?.title)
    .filter(Boolean)
    .slice(0, 3);
  return (
    <Card className="group card-lift cursor-pointer transition hover:border-accent/50 hover:bg-surface-2/70" onClick={onOpen}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-white">{note.title}</p>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="rounded-lg p-1 text-ink-dim/60 transition hover:text-bad cursor-pointer"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {note.body && (
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-dim">
          {note.body.replace(/\[\[([^\[\]]+)\]\]/g, "$1").replace(/[#*`>-]/g, "").slice(0, 120)}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone="accent">{note.domain}</Badge>
        <Badge tone="dim">
          {note.source === "learn" ? "🎯 学习" : note.source === "read" ? "📖 阅读" : note.source === "manual" ? "✍️ 手动" : "🧭 伙伴"}
          · {note.sourceTitle}
        </Badge>
        {note.nextReviewAt ? (
          <Badge tone={note.nextReviewAt <= todayISO() ? "warn" : "default"}>
            复习：{formatDate(note.nextReviewAt)}
          </Badge>
        ) : (
          <Badge tone="ok">记忆已固化</Badge>
        )}
        <span className="ml-auto flex items-center gap-1" title="复习轮次">
          {REVIEW_INTERVALS.map((_, i) => (
            <span
              key={i}
              className={cn("inline-block size-1.5 rounded-full", i < note.reviewStage ? "bg-ok" : "bg-white/15")}
            />
          ))}
        </span>
      </div>
      {linkedTitles.length > 0 && (
        <p className="mt-2 truncate text-[11px] text-[#8b83d6]">
          🔗 {linkedTitles.join(" · ")}
          {note.links.length > 3 ? " …" : ""}
        </p>
      )}
    </Card>
  );
}

/* ================= 笔记详情弹窗（查看/编辑/反链/AI 建联） ================= */
function NoteModal({
  note,
  notes,
  onClose,
  onOpenNote,
}: {
  note: KnowledgeItem | null;
  notes: KnowledgeItem[];
  onClose: () => void;
  onOpenNote: (id: string) => void;
}) {
  const updateKnowledge = useAppStore((s) => s.updateKnowledge);
  const linkNotes = useAppStore((s) => s.linkNotes);
  const unlinkNotes = useAppStore((s) => s.unlinkNotes);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [linkSearch, setLinkSearch] = useState("");
  const [linking, setLinking] = useState(false);
  const [suggests, setSuggests] = useState<{ targetId: string; reason: string }[]>([]);

  if (!note) return null;
  const backlinks = notes.filter((n) => n.links.includes(note.id));
  const linked = note.links.map((l) => notes.find((n) => n.id === l)).filter(Boolean) as KnowledgeItem[];

  const startEdit = () => {
    setDraft({ title: note.title, body: note.body });
    setEditing(true);
  };

  const saveEdit = () => {
    if (!draft?.title.trim()) return;
    updateKnowledge(note.id, { title: draft.title.trim(), body: draft.body });
    setEditing(false);
    toast.success("已保存");
  };

  /* AI 建联：为当前笔记找有思想联系的笔记 */
  const autoLink = async () => {
    if (notes.length < 2) {
      toast.error("笔记太少，先攒几条再来连线");
      return;
    }
    setLinking(true);
    setSuggests([]);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const candidates = notes
        .filter((n) => n.id !== note.id)
        .slice(0, 40)
        .map((n) => `(${n.id}) ${n.title}：${n.body.replace(/\[\[|\]\]/g, "").slice(0, 60)}`)
        .join("\n");
      const full = await streamChat({
        task: "autolink",
        system: AUTOLINK({
          note: `${note.title}\n${note.body.slice(0, 300)}`,
          candidates,
        }),
        messages: [{ role: "user", content: "建立联系。" }],
        temperature: 0.3,
        onDelta: () => {},
      });
      const parsed = autolinkSchema.parse(extractJson(full));
      if (parsed.links.length === 0) {
        toast("AI 认为暂时没有真正有联系的笔记——宁缺毋滥。");
      } else {
        setSuggests(parsed.links);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI 建联失败");
    } finally {
      setLinking(false);
    }
  };

  return (
    <Modal
      open={!!note}
      onClose={() => {
        onClose();
        setEditing(false);
        setSuggests([]);
      }}
      title={note.title}
      wide
    >
      {editing ? (
        <div className="space-y-3">
          <Input value={draft?.title ?? ""} onChange={(e) => setDraft({ ...draft!, title: e.target.value })} placeholder="标题" />
          <Textarea
            rows={8}
            value={draft?.body ?? ""}
            onChange={(e) => setDraft({ ...draft!, body: e.target.value })}
            placeholder="Markdown 正文，用 [[标题]] 链接其他笔记"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>取消</Button>
            <Button onClick={saveEdit}>保存</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* 元信息 */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone="accent">{note.domain}</Badge>
            <Badge tone="dim">
              {note.source === "learn" ? "🎯 学习" : note.source === "read" ? "📖 阅读" : note.source === "manual" ? "✍️ 手动" : "🧭 伙伴"}
              · {note.sourceTitle}
            </Badge>
            <span className="text-ink-dim">{formatDate(note.masteredAt)} 掌握</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={autoLink} loading={linking}>
                <Sparkles className="size-3.5" /> AI 建联
              </Button>
              <Button size="sm" variant="outline" onClick={startEdit}>
                <Pencil className="size-3.5" /> 编辑
              </Button>
            </div>
          </div>

          {/* 正文（双链可点） */}
          {note.body ? (
            <WikiMarkdown body={note.body} notes={notes} onOpen={onOpenNote} />
          ) : (
            <p className="text-sm text-ink-dim/70">（无正文——点击编辑补充，用 [[标题]] 链接其他笔记）</p>
          )}

          {/* AI 建联建议 */}
          {suggests.length > 0 && (
            <Card className="border-accent/40 bg-accent/5">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-[#b7adff]">
                <Sparkles className="size-4" /> AI 找到了这些联系（点击采纳）
              </p>
              <div className="space-y-2">
                {suggests
                  .filter((s) => !note.links.includes(s.targetId))
                  .map((s) => {
                    const target = notes.find((n) => n.id === s.targetId);
                    return (
                      <button
                        key={s.targetId}
                        onClick={() => {
                          linkNotes(note.id, s.targetId);
                          setSuggests((prev) => prev.filter((x) => x.targetId !== s.targetId));
                          toast.success("已建立连接");
                        }}
                        className="w-full rounded-xl border border-border bg-surface-2/60 p-3 text-left transition hover:border-accent/50 cursor-pointer"
                      >
                        <p className="text-sm font-semibold text-white">
                          <GitBranch className="mr-1.5 inline size-3.5 text-[#8b83d6]" />
                          {target?.title ?? "未知笔记"}
                        </p>
                        <p className="mt-1 text-xs text-ink-dim">{s.reason}</p>
                      </button>
                    );
                  })}
                {suggests.filter((s) => !note.links.includes(s.targetId)).length === 0 && (
                  <p className="text-xs text-ink-dim">建议的联系均已存在。</p>
                )}
              </div>
            </Card>
          )}

          {/* 出链 */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
              🔗 出链（{linked.length}）— 自己建立联系
            </p>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {linked.map((l) => (
                <span key={l.id} className="inline-flex items-center gap-1 rounded-lg border border-accent/40 bg-accent/10 px-2 py-1 text-xs text-[#b7adff]">
                  <button onClick={() => onOpenNote(l.id)} className="cursor-pointer hover:text-white">
                    {l.title}
                  </button>
                  <button
                    onClick={() => unlinkNotes(note.id, l.id)}
                    className="text-ink-dim/60 hover:text-bad cursor-pointer"
                    title="断开连接"
                  >
                    ✕
                  </button>
                </span>
              ))}
              {linked.length === 0 && <span className="text-xs text-ink-dim/60">还没有连接</span>}
            </div>
            <Input
              className="h-8 text-xs"
              placeholder="搜索笔记标题并连接…"
              value={linkSearch}
              onChange={(e) => setLinkSearch(e.target.value)}
            />
            {linkSearch.trim() && (
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                {notes
                  .filter(
                    (n) =>
                      n.id !== note.id &&
                      !note.links.includes(n.id) &&
                      n.title.includes(linkSearch.trim())
                  )
                  .slice(0, 6)
                  .map((n) => (
                    <button
                      key={n.id}
                      onClick={() => {
                        linkNotes(note.id, n.id);
                        setLinkSearch("");
                      }}
                      className="flex w-full items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs text-ink-dim hover:border-accent/40 hover:text-ink cursor-pointer"
                    >
                      <Link2 className="size-3" /> {n.title}
                      <span className="ml-auto text-[10px] text-ink-dim/60">{n.domain}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>

          {/* 反向链接 */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-dim">
              🔙 反向链接（{backlinks.length}）
            </p>
            <div className="flex flex-wrap gap-1.5">
              {backlinks.map((b) => (
                <button
                  key={b.id}
                  onClick={() => onOpenNote(b.id)}
                  className="rounded-lg border border-border bg-surface-2/60 px-2 py-1 text-xs text-ink-dim hover:text-ink cursor-pointer"
                >
                  {b.title}
                </button>
              ))}
              {backlinks.length === 0 && (
                <span className="text-xs text-ink-dim/60">暂无——当其他笔记链接到这条时会出现在这里</span>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs transition cursor-pointer",
        active
          ? "border-accent/50 bg-accent/15 text-white"
          : "border-border text-ink-dim hover:text-ink"
      )}
    >
      {children}
    </button>
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
      <p className="tabular mt-2 text-2xl font-extrabold text-white">
        {value} <span className="text-sm font-normal text-ink-dim">{unit}</span>
      </p>
    </Card>
  );
}
