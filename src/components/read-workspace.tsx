"use client";

/* 读书伙伴工作台（v23.3 从 /read 列表页抽取）：作为「学习」页的第二个 tab 渲染；
 * /read 列表入口重定向到 /learn?tab=read，书籍详情 /read/[id] 保留原路由。 */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge, Button, Card, Empty, Input, Modal, PageHeader, Textarea, Skeleton } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { extractJson, readingPlanSchema } from "@/lib/ai/client";
import { READING_GOAL_LABELS } from "@/lib/types";
import { trackReading } from "@/lib/track";
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import { BookOpen, Plus, Trash2 } from "lucide-react";

export function ReadWorkspace() {
  const hydrated = useHydrated();
  const router = useRouter();
  const books = useAppStore((s) => s.books);
  const addBook = useAppStore((s) => s.addBook);
  const removeBook = useAppStore((s) => s.removeBook);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [pasted, setPasted] = useState("");
  const [creating, setCreating] = useState(false);
  /* 删除确认：与学习页同约定——删书会连章节进度/洞见/对话一起删，且随云同步双端丢失 */
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);

  /* 生成中的取消手柄：旧实现弹窗可被 Esc/遮罩随时关掉而生成照跑，
   * 成功后又 addBook + 强制跳转——用户明明"取消"了却凭空多出一本书（删除还得再点一次）。 */
  const createAbortRef = useRef<AbortController | null>(null);
  const cancelCreate = () => createAbortRef.current?.abort();

  const create = async () => {
    if (!title.trim()) {
      toast.error("先写个书名");
      return;
    }
    setCreating(true);
    const ctrl = new AbortController();
    createAbortRef.current = ctrl;
    const id = uid("book");
    const desc = `书名：《${title.trim()}》${author.trim() ? ` 作者：${author.trim()}` : ""}${
      pasted.trim() ? `\n用户粘贴的内容/笔记：\n${pasted.trim().slice(0, 6000)}` : ""
    }`;
    try {
      const { streamChat } = await import("@/lib/ai/client");
      let plan: ReturnType<typeof readingPlanSchema.parse> | null = null;
      const full = await streamChat({
        args: { desc },
        messages: [{ role: "user", content: "生成阅读计划。" }],
        temperature: 0.5,
        task: "reading-plan",
        signal: ctrl.signal,
        onDelta: () => {},
      });
      plan = readingPlanSchema.parse(extractJson(full));
      /* v25：新链路给 map（认知地图），旧输出只有 bookProfile——转换兼容，两代数据都接 */
      const map = plan.map
        ? { ...plan.map, generatedAt: new Date().toISOString() }
        : plan.bookProfile
          ? {
              coreProblem: plan.bookProfile.positioning,
              authorStance: plan.bookProfile.author,
              lineage: plan.bookProfile.lineage,
              controversies: plan.bookProfile.controversies,
              generatedAt: new Date().toISOString(),
            }
          : undefined;
      addBook({
        id,
        title: title.trim(),
        author: author.trim() || undefined,
        pastedText: pasted.trim() || undefined,
        status: "reading",
        readStatus: "reading",
        map,
        profile: plan.bookProfile || undefined,
        planSummary: plan.planSummary,
        chapters: plan.chapters.map((c) => ({
          ...c,
          knowledgeType: c.knowledgeType || "concept",
          coreIdea: c.coreIdea || undefined,
          perspectives: c.perspectives || undefined,
          capture: c.capture || undefined,
          keyConcepts: c.keyConcepts || undefined,
          prerequisites: c.prerequisites || undefined,
          expectedOutcome: c.expectedOutcome || undefined,
          assessFocus: c.assessFocus || undefined,
          id: uid("ch"),
          status: "todo" as const,
        })),
        insights: [],
        chat: [],
        createdAt: new Date().toISOString(),
      });
      setOpen(false);
      setTitle("");
      setAuthor("");
      setPasted("");
      /* v26.1 G1：路线生成事件（建书即路线）；第二问题识别——已有"有效学习"记录（迁移/掌握）
       * 且新书目标意图与所有旧书都不同，才算启动第二个真实问题（PRD 约束 5：同目标多会话不算） */
      trackReading("roadmap_generated", { bookId: id, source: "create", nodes: plan.chapters.length });
      const books = useAppStore.getState().books;
      const hasEffectiveLearning = books.some(
        (b) => b.id !== id && ((b.transfers ?? []).length > 0 || b.chapters.some((c) => c.masteredAt))
      );
      const intent = title.trim();
      if (hasEffectiveLearning && intent && !books.some((b) => b.id !== id && b.goal?.intent === intent)) {
        trackReading("second_problem_started", { bookId: id, goal: intent.slice(0, 60) });
      }
      toast.success("阅读计划已生成，开读！");
      router.push(`/read/${id}`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") toast("已取消生成，没有创建这本书");
      else toast.error(e instanceof Error ? e.message : "生成阅读计划失败");
    } finally {
      createAbortRef.current = null;
      setCreating(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<BookOpen className="size-5" />}
        title="读书伙伴"
        desc="带着问题读，读完聊。聊出来的想法自动进你的知识库。"
        right={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" /> 添加书籍
          </Button>
        }
      />

      {!hydrated ? (
        <Skeleton className="h-40 rounded-2xl bg-surface/60" />
      ) : books.length === 0 ? (
        <Empty
          icon={<BookOpen className="size-7" />}
          title="从一本书开始"
          desc="说书名就行，怎么读教练来安排。"
          action={
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" /> 添加第一本书
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {books.map((b) => {
            const doneCh = b.chapters.filter((c) => c.status === "done").length;
            const masteredCh = b.chapters.filter((c) => c.masteredAt).length;
            const readStatus = b.readStatus ?? (b.status === "done" ? "finished" : b.status === "reading" ? "reading" : "unread");
            const statusMeta: Record<string, { label: string; tone: "ok" | "accent" | "warn" | "default" }> = {
              unread: { label: "未开始", tone: "default" },
              reading: { label: "在读", tone: "accent" },
              finished: { label: "已读完", tone: "warn" },
              assessing: { label: "验收中", tone: "warn" },
              mastered: { label: "已掌握", tone: "ok" },
            };
            const sm = statusMeta[readStatus] ?? statusMeta.reading;
            return (
              <Card
                key={b.id}
                className="group card-lift cursor-pointer transition hover:border-accent/50 hover:bg-surface-2/70"
                onClick={() => router.push(`/read/${b.id}`)}
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <h3 className="truncate font-bold text-ink">《{b.title}》</h3>
                    {b.author && <p className="mt-0.5 text-xs text-ink-dim">{b.author}</p>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleting({ id: b.id, title: b.title });
                      }}
                      className="rounded-lg p-1.5 text-ink-dim/60 transition hover:bg-bad/10 hover:text-bad cursor-pointer"
                      aria-label="删除这本书"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                    {/* 已读完 ≠ 已掌握：两态分开显示（PRD 4.5） */}
                    <Badge tone={sm.tone === "default" ? "default" : sm.tone}>{sm.label}</Badge>
                  </div>
                </div>
                {b.goal && (
                  <p className="mt-2 text-[11.5px] text-ink-dim">
                    目标：<span className="font-semibold text-accent">{READING_GOAL_LABELS[b.goal.primary].label}</span>
                    {b.goal.secondary?.length ? ` + ${b.goal.secondary.map((g) => READING_GOAL_LABELS[g].label).join("、")}` : ""}
                    {b.goal.intent ? <span className="ml-1.5">· {b.goal.intent.slice(0, 30)}</span> : null}
                  </p>
                )}
                {b.planSummary && (
                  <p className="mt-2 line-clamp-2 text-xs text-ink-dim">{b.planSummary}</p>
                )}
                <div className="mt-3 flex items-center gap-3 text-xs text-ink-dim">
                  <span>
                    节点 {doneCh}/{b.chapters.length}
                  </span>
                  {masteredCh > 0 && <span className="text-ok">已掌握 {masteredCh}</span>}
                  <span>洞见 {b.insights.length} 条</span>
                  {b.chat.length > 0 && <span>对话 {b.chat.length} 轮</span>}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={open}
        /* 生成期间不允许关窗：关了也拦不住请求，成功照样建书跳转——那种"取消了却多出一本书"最恼人 */
        onClose={() => {
          if (creating) return;
          setOpen(false);
        }}
        title="添加书籍"
      >
        <div className="space-y-3">
          <Input placeholder="书名（必填）" value={title} onChange={(e) => setTitle(e.target.value)} disabled={creating} />
          <Input placeholder="作者（可选）" value={author} onChange={(e) => setAuthor(e.target.value)} disabled={creating} />
          <Textarea
            rows={5}
            placeholder="粘贴原文片段 / 你的笔记 / 目录（可选）——有的话阅读计划会围绕它安排"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            disabled={creating}
          />
          <div className="flex items-center justify-end gap-2">
            {creating && <span className="mr-auto text-xs text-ink-dim">正在拆解这本书…（约 1 分钟，请别关窗）</span>}
            {creating ? (
              <Button variant="outline" onClick={cancelCreate}>
                取消生成
              </Button>
            ) : (
              <Button onClick={create}>生成阅读计划</Button>
            )}
          </div>
        </div>
      </Modal>

      {/* 删除确认：误触一次就丢整本书的进度与对话（还会同步上云），必须明示范围 */}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="删除这本书？"
      >
        <p className="text-sm leading-relaxed text-ink">
          《{deleting?.title}》的阅读计划、章节进度、洞见和全部对话会一起删除，
          并同步到其他设备。删了找不回来。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!deleting) return;
              removeBook(deleting.id);
              setDeleting(null);
              toast.success("已删除");
            }}
          >
            删除
          </Button>
        </div>
      </Modal>
    </div>
  );
}
