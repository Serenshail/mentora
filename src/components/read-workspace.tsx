"use client";

/* 读书伙伴工作台（v23.3 从 /read 列表页抽取）：作为「学习」页的第二个 tab 渲染；
 * /read 列表入口重定向到 /learn?tab=read，书籍详情 /read/[id] 保留原路由。 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, Empty, Input, Modal, Textarea, Skeleton } from "@/components/ui";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import { extractJson, readingPlanSchema } from "@/lib/ai/client";
import { ReadingShelf } from "@/components/reading-shelf";
import { trackReading } from "@/lib/track";
import { verifyBook } from "@/lib/book-verify";
import { uid } from "@/lib/utils";
import { toast } from "sonner";
import { BookOpen, Plus } from "lucide-react";

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
  /* V26.1/V26.2 书籍真实性核查：无可信来源或核查不可用时暂停生成，弹窗交给用户决定（PRD §5） */
  const [verifyState, setVerifyState] = useState<{
    title: string; author: string; pasted: string; samples: string[];
    status: "insufficient" | "unsearchable";
  } | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);

  /* 生成中的取消手柄：旧实现弹窗可被 Esc/遮罩随时关掉而生成照跑，
   * 成功后又 addBook + 强制跳转——用户明明"取消"了却凭空多出一本书（删除还得再点一次）。 */
  const createAbortRef = useRef<AbortController | null>(null);
  const cancelCreate = () => createAbortRef.current?.abort();
  /* 组件卸载（浏览器 Back/硬件返回离开 /learn）时中止在途生成：verifyBook 与 streamChat
   * 两条流继续跑到上游完成会白烧 AI token（服务端照常计费），完成后 addBook 仍会把
   * 用户已放弃的书写进 store 并同步上云，router.push 还会把用户强行拽回书籍详情页。
   * 与 use-chat.ts / agent-home.tsx 的卸载兜底同款。abort 后走既有 AbortError 分支：
   * 不建书、不跳转（catch 里只 toast）。 */
  useEffect(() => () => createAbortRef.current?.abort(), []);

  const create = async () => {
    if (!title.trim()) {
      toast.error("先写个书名");
      return;
    }
    setCreating(true);
    const ctrl = new AbortController();
    createAbortRef.current = ctrl;
    /* V26.2-H2（PRD §5）：任何路径都先核查——粘贴材料不再免检（材料只改变证据语义：
     * 核实通过 → verified；未核实但用户坚持且提供了材料 → user_material，生成结果如实标注）。
     * 核查服务不可用 → unsearchable，同样暂停（C7：明确提示暂时无法核实，不静默放行）。 */
    try {
      const v = await verifyBook(title, author, ctrl.signal);
      if (v.status !== "verified") {
        setCreating(false);
        setVerifyState({
          title: title.trim(),
          author: author.trim(),
          pasted: pasted.trim(),
          samples: v.hits.slice(0, 3).map((r) => `${r.title} — ${r.url}`),
          status: v.status,
        });
        setVerifyOpen(true);
        return; // 暂停：等用户在弹窗里决定
      }
      await generateBook(title.trim(), author.trim(), pasted.trim(), "verified");
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setCreating(false);
        return; // 用户取消
      }
      // 核查服务不可用（网络/限流）→ unsearchable，走弹窗而不是静默生成（PRD C7）
      setCreating(false);
      setVerifyState({
        title: title.trim(),
        author: author.trim(),
        pasted: pasted.trim(),
        samples: [],
        status: "unsearchable",
      });
      setVerifyOpen(true);
      return;
    }
  };

  /* 生成阅读计划并创建书。bTitle/bAuthor/bPasted：核查弹窗"我确认要读"时带上的原书名与用户材料。 */
  const generateBook = async (
    bTitle: string,
    bAuthor: string,
    bPasted: string,
    verification: "verified" | "user_material"
  ) => {
    setCreating(true);
    const ctrl = new AbortController();
    createAbortRef.current = ctrl;
    const id = uid("book");
    const desc = `书名：《${bTitle}》${bAuthor ? ` 作者：${bAuthor}` : ""}${
      bPasted.trim() ? `\n用户粘贴的内容/笔记：\n${bPasted.trim().slice(0, 6000)}` : ""
    }`;
    try {
      const { streamChat } = await import("@/lib/ai/client");
      let plan: ReturnType<typeof readingPlanSchema.parse> | null = null;
      const full = await streamChat({
        args: { desc, materialOnly: verification === "user_material" },
        messages: [{ role: "user", content: "生成阅读计划。" }],
        temperature: 0.5,
        task: "reading-plan",
        signal: ctrl.signal,
        onDelta: () => {},
      });
      if (ctrl.signal.aborted) return;
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
        title: bTitle,
        author: bAuthor || undefined,
        pastedText: bPasted.trim() || undefined,
        status: "reading",
        readStatus: "reading",
        verification, // V26.2-H2：verified=搜索核实 / user_material=基于用户材料（详情页如实标注）
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
       * 且新书目标意图与所有旧书都不同，才算启动第二个真实问题（PRD 约束 5：同目标多会话不算）。
       * 去重判据修正：建书这一刻新书还没有 goal（addBook 载荷不含 goal，goal 是之后在详情页
       * 由用户/AI 写入的），拿书名去和旧书 goal.intent 全等比较几乎恒为 false——护栏形同虚设，
       * 每本新书都会触发一次，后台「第二个真实问题」指标被系统性高估。改用两条可达成判据：
       * 归一化后同书名（同一个问题重复建书），或旧书已记录的 goal.intent 与新书书名归一化相等
       * （用户把同一意图直接写成了书名）。 */
      trackReading("roadmap_generated", { bookId: id, source: "create", nodes: plan.chapters.length });
      const books = useAppStore.getState().books;
      const hasEffectiveLearning = books.some(
        (b) => b.id !== id && ((b.transfers ?? []).length > 0 || b.chapters.some((c) => c.masteredAt))
      );
      const normIntent = (s: string) => s.replace(/[\s《》「」"'“”]/g, "").toLowerCase();
      const intent = normIntent(bTitle);
      if (
        hasEffectiveLearning &&
        intent &&
        !books.some(
          (b) =>
            b.id !== id &&
            (normIntent(b.title) === intent || (!!b.goal?.intent && normIntent(b.goal.intent) === intent))
        )
      ) {
        trackReading("second_problem_started", { bookId: id, goal: bTitle.slice(0, 60) });
      }
      toast.success("阅读计划已生成，开读！");
      router.push(`/read/${id}`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") toast("已取消生成，没有创建这本书");
      else toast.error(e instanceof Error ? e.message : "生成阅读计划失败");
    } finally {
      createAbortRef.current = null;
      setCreating(false);
      setVerifyOpen(false);
      setVerifyState(null);
    }
  };

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button className="min-h-11 shrink-0" onClick={() => setOpen(true)}>
          <Plus className="size-4" /> 添加书籍
        </Button>
      </div>

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
        <ReadingShelf books={books} onDelete={(book) => setDeleting({ id: book.id, title: book.title })} />
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

      {/* V26.1/V26.2 书籍真实性核查（PRD §5.4/§5.6）：无法核实 → 暂停生成，交给用户决定 */}
      <Modal open={verifyOpen} onClose={() => { setVerifyOpen(false); setVerifyState(null); }} title="暂时无法核实这本书">
        <div className="space-y-3 text-sm leading-relaxed text-ink">
          {verifyState?.status === "unsearchable" ? (
            <p>
              核查服务暂时不可用，无法确认「<b>{verifyState?.title}</b>」的真实性。
              为避免虚构作者、目录和章节，生成已暂停——稍后重试，或直接粘贴这本书的材料继续。
            </p>
          ) : (
            <p>
              我们搜索了「<b>{verifyState?.title}</b>」，没有找到可信的图书来源（图书平台、馆藏或出版记录）
              {verifyState?.author ? <>，或来源信息与作者「{verifyState?.author}」不符</> : null}。
              为避免虚构作者、目录和章节，生成已暂停。
            </p>
          )}
          {verifyState && verifyState.samples.length > 0 && (
            <div className="rounded-lg bg-surface-2/60 p-2.5 text-xs text-ink-dim">
              <p className="mb-1 font-medium text-ink">最接近的搜索结果（可能是同名或无关内容）：</p>
              {verifyState.samples.map((sm, i) => (
                <p key={i} className="truncate">· {sm}</p>
              ))}
            </div>
          )}
          <p className="text-ink-dim">两个选择：</p>
          <div className="space-y-2">
            <div className="rounded-lg border border-border bg-white p-2.5">
              <p className="font-medium text-ink">① 换个书名再试</p>
              <p className="text-xs text-ink-dim">关掉这个弹窗，回到表单修改书名后重新点「生成阅读计划」。</p>
            </div>
            <div className="rounded-lg border border-border bg-white p-2.5">
              <p className="font-medium text-ink">② 我确认要读它（基于我提供的材料）</p>
              <p className="text-xs text-ink-dim">
                在表单里粘贴这本书的原文片段或目录（必填），我们基于你给的材料做阅读计划——
                书籍详情会如实标注「基于你的材料」，不会冒充已核实的完整书目。
              </p>
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => { setVerifyOpen(false); setVerifyState(null); }}>
            换个书名
          </Button>
          <Button
            onClick={() => {
              if (verifyState && !verifyState.pasted.trim()) {
                toast.error("请先在表单里粘贴这本书的原文片段或目录，再确认生成");
                return;
              }
              const vs = verifyState;
              setVerifyOpen(false);
              if (vs) void generateBook(vs.title, vs.author, vs.pasted, "user_material");
            }}
          >
            确认，基于我的材料生成
          </Button>
        </div>
      </Modal>
    </div>
  );
}
