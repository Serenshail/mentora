"use client";

/* 个人页面详情：markdown/清单/表格直接编辑并自动保存。
 * 修复记录（2026-11-23 复核）：
 *  - markdown 编辑框补上与 schema 同源的 maxLength（此前超 3 万字符要到保存时才被
 *    schema 拒绝，报错误导、点「完成」还把没保存的输入一起丢掉）；
 *  - 渲染路径的 parseWorkspace 按 workspace 内容缓存；编辑保存改为「复用渲染期校验
 *    结果 + 对被编辑的块做增量校验」，不再每次交互对整页跑三遍全量 stringify+深校验；
 *  - 固定/添加行/CTA 按钮改用共享 Button，补齐禁用态（300 行封顶）与悬停反馈；
 *  - 全文从压缩单行展开为常规格式（与 membership 等兄弟页面同风格）。 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useHydrated } from "@/lib/use-chat";
import {
  parseWorkspace,
  workspaceBlockSchema,
  WORKSPACE_FIELD_LIMITS,
  WORKSPACE_PAGE_CHAR_LIMIT,
  type WorkspaceBlock,
} from "@/lib/workspace";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui";
import { uid } from "@/lib/utils";
import { toast } from "sonner";

export default function PersonalWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const hydrated = useHydrated();
  const knowledge = useAppStore((s) => s.knowledge);
  const goals = useAppStore((s) => s.goals);
  const books = useAppStore((s) => s.books);
  const [editing, setEditing] = useState<string | null>(null);
  const note = knowledge.find((n) => n.id === id);
  /* 渲染路径按 workspace 内容缓存解析结果：编辑开关、无关 store 更新不再每次全量校验 */
  const workspace = useMemo(() => parseWorkspace(note?.workspace), [note?.workspace]);
  if (!hydrated) return <p role="status" className="p-6 text-ink-dim">正在打开你的页面…</p>;
  if (!note || !workspace)
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-xl font-bold">这个页面暂时不可用</h1>
        <p className="text-ink-dim">页面可能已删除，或尚未同步到当前账户。</p>
        <Link href="/workspace" className="text-accent underline">
          返回我的系统
        </Link>
      </div>
    );
  const changeBlock = (blockId: string, update: (block: WorkspaceBlock) => WorkspaceBlock) => {
    /* 从 getState() 重读以避免脏写（云同步可能在渲染后落进 store）是对的；
     * 但 store 与渲染持有同一份 workspace（绝大多数编辑）时直接复用渲染期已校验的结果 */
    const current = useAppStore.getState().knowledge.find((n) => n.id === id);
    const data = current?.workspace === note.workspace ? workspace : parseWorkspace(current?.workspace);
    if (!data) {
      toast.error("页面已变化，请重新打开");
      return;
    }
    const blocks = data.blocks.map((b) => (b.id === blockId ? update(b) : b));
    const updated = blocks.find((b) => b.id === blockId);
    if (!updated) {
      toast.error("页面已变化，请重新打开");
      return;
    }
    /* 增量校验：编号/列引用在编辑中不会变，只有被编辑的块需要重新过 schema；
     * 页面总量上限仍要查（接近 180KB 的页面再编辑仍可能越界）。 */
    if (
      !workspaceBlockSchema.safeParse(updated).success ||
      JSON.stringify({ ...data, blocks }).length > WORKSPACE_PAGE_CHAR_LIMIT
    ) {
      toast.error("内容超出当前页面容量，请拆为多个页面");
      return;
    }
    useAppStore.getState().updateKnowledge(id, { workspace: { ...data, blocks } });
  };
  const matches = (
    block: Extract<WorkspaceBlock, { type: "goals" | "notes" | "books" }>,
    itemId: string,
    title: string
  ) =>
    (!block.ids?.length || block.ids.includes(itemId)) &&
    (!block.query || title.toLowerCase().includes(block.query.toLowerCase()));
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 personal-workspace">
      <header className="space-y-3 border-b border-border pb-5">
        <Link href="/workspace" className="text-sm text-ink-dim hover:text-ink">
          我的系统 / 个人页面
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 flex-1 break-words text-2xl font-bold tracking-tight">{note.title}</h1>
          <Button
            variant="outline"
            onClick={() =>
              useAppStore.getState().updateKnowledge(id, { workspace: { ...workspace, pinned: !workspace.pinned } })
            }
          >
            {workspace.pinned ? "从侧栏取消固定" : "固定到侧栏"}
          </Button>
        </div>
        {note.body && <p className="whitespace-pre-wrap break-words text-sm leading-7 text-ink-dim">{note.body}</p>}
        <p className="text-xs text-ink-dim">按你的学习方式组织。勾选和表格编辑会自动保存；需要调整页面结构时，回到 Mentora 说明你想怎么改。</p>
      </header>
      {workspace.blocks.length === 0 && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-ink-dim">
          页面还没有内容。告诉 Mentora 你需要记录或查看什么，就能继续搭建。
        </p>
      )}
      {workspace.blocks.map((block) => (
        <section key={block.id} className="min-w-0 rounded-2xl border border-border bg-white p-4 md:p-6" data-workspace-block={block.id}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="min-w-0 break-words text-base font-semibold">{block.title}</h2>
            {block.type === "markdown" && (
              <button
                className="min-h-10 shrink-0 cursor-pointer rounded-lg px-3 text-sm text-accent hover:bg-accent/5"
                onClick={() => setEditing(editing === block.id ? null : block.id)}
              >
                {editing === block.id ? "完成" : "编辑"}
              </button>
            )}
          </div>
          {block.type === "markdown" &&
            (editing === block.id ? (
              <textarea
                aria-label={`编辑${block.title}`}
                defaultValue={block.text}
                /* 与 schema text max 对齐（WORKSPACE_FIELD_LIMITS.markdownText）：
                 * 输入/粘贴在源头截断，超限保存失败与丢稿不再可能发生 */
                maxLength={WORKSPACE_FIELD_LIMITS.markdownText}
                className="min-h-60 w-full resize-y rounded-lg border border-border p-3 text-base leading-7 outline-accent"
                onBlur={(event) => {
                  const value = event.target.value;
                  changeBlock(block.id, (current) => (current.type === "markdown" ? { ...current, text: value } : current));
                }}
              />
            ) : (
              <Markdown className="prose-reading break-words" text={block.text} />
            ))}
          {block.type === "checklist" && (
            <div className="space-y-3">
              {block.items.length > 0 && (
                <p className="text-xs text-ink-dim">完成 {block.items.filter((i) => i.done).length} / {block.items.length} 项</p>
              )}
              {block.items.map((item) => (
                <label key={item.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={(event) =>
                      changeBlock(block.id, (current) =>
                        current.type === "checklist"
                          ? { ...current, items: current.items.map((i) => (i.id === item.id ? { ...i, done: event.target.checked } : i)) }
                          : current
                      )
                    }
                    className="mt-1 size-4 shrink-0 accent-accent"
                  />
                  <span className={item.done ? "break-words text-ink-dim line-through" : "min-w-0 break-words"}>{item.text}</span>
                </label>
              ))}
              {block.items.length === 0 && <p className="text-sm text-ink-dim">还没有待办内容，可以让 Mentora 按当前目标补充。</p>}
            </div>
          )}
          {block.type === "table" && (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      {block.columns.map((c) => (
                        <th key={c.id} className="min-w-36 border-b border-border p-2 text-left font-medium text-ink-dim">
                          {c.label}
                        </th>
                      ))}
                      <th className="w-16 border-b border-border" aria-label="行操作" />
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row) => (
                      <tr key={row.id}>
                        {block.columns.map((column) => (
                          <td key={column.id} className="border-b border-border p-1">
                            <input
                              aria-label={`${column.label} ${row.id}`}
                              defaultValue={row.cells[column.id] ?? ""}
                              className="min-h-11 w-full min-w-32 rounded-md bg-transparent px-2 outline-accent"
                              maxLength={WORKSPACE_FIELD_LIMITS.tableCell}
                              onBlur={(event) => {
                                const value = event.target.value;
                                changeBlock(block.id, (current) =>
                                  current.type === "table"
                                    ? {
                                        ...current,
                                        rows: current.rows.map((r) => (r.id === row.id ? { ...r, cells: { ...r.cells, [column.id]: value } } : r)),
                                      }
                                    : current
                                );
                              }}
                            />
                          </td>
                        ))}
                        <td className="border-b border-border p-1">
                          <button
                            aria-label={`删除行 ${row.id}`}
                            className="min-h-11 min-w-12 cursor-pointer whitespace-nowrap px-2 text-ink-dim hover:text-bad"
                            onClick={() =>
                              changeBlock(block.id, (current) =>
                                current.type === "table" ? { ...current, rows: current.rows.filter((r) => r.id !== row.id) } : current
                              )
                            }
                          >
                            移除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Button
                variant="outline"
                className="mt-3"
                disabled={block.rows.length >= 300}
                onClick={() =>
                  changeBlock(block.id, (current) =>
                    current.type === "table" ? { ...current, rows: [...current.rows, { id: uid("row"), cells: {} }] } : current
                  )
                }
              >
                添加一行
              </Button>
            </div>
          )}
          {block.type === "goals" && (
            <div className="space-y-3">
              {goals.filter((g) => matches(block, g.id, g.topic)).map((g) => {
                const days = Object.values(g.plan?.days ?? {});
                const done = days.filter((d) => d.status === "passed").length;
                return (
                  <Link key={g.id} href={`/learn/${encodeURIComponent(g.id)}`} className="block rounded-xl border border-border p-4 hover:border-accent/40">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="break-words font-medium">{g.topic}</span>
                      <span className="text-xs text-ink-dim">{({ draft: "待规划", active: "进行中", paused: "已暂停", done: "已完成" })[g.status]}</span>
                    </div>
                    <p className="mt-2 break-words text-sm text-ink-dim">{g.direction || "方向待完善"} · 已完成 {done}/{days.length} 课</p>
                  </Link>
                );
              })}
              {!goals.some((g) => matches(block, g.id, g.topic)) && (
                <p className="text-sm text-ink-dim">当前没有匹配的学习计划。已有计划变化后，这里会自动更新。</p>
              )}
            </div>
          )}
          {block.type === "notes" && (
            <div className="space-y-2">
              {knowledge.filter((n) => n.id !== id && matches(block, n.id, n.title)).map((n) => (
                <Link
                  key={n.id}
                  className="block break-words rounded-lg border border-border px-3 py-3 text-sm hover:border-accent/40"
                  href={n.workspace ? `/workspace/${encodeURIComponent(n.id)}` : `/brain?note=${encodeURIComponent(n.id)}`}
                >
                  {n.title}
                </Link>
              ))}
              {!knowledge.some((n) => n.id !== id && matches(block, n.id, n.title)) && (
                <p className="text-sm text-ink-dim">还没有匹配的笔记。保存相关笔记后会出现在这里。</p>
              )}
            </div>
          )}
          {block.type === "books" && (
            <div className="space-y-2">
              {books.filter((b) => matches(block, b.id, b.title)).map((b) => (
                <Link key={b.id} className="block break-words rounded-lg border border-border px-3 py-3 text-sm hover:border-accent/40" href={`/read/${encodeURIComponent(b.id)}`}>
                  《{b.title}》 · 已读 {b.chapters.filter((c) => c.status === "done").length}/{b.chapters.length} 章
                </Link>
              ))}
              {!books.some((b) => matches(block, b.id, b.title)) && (
                <p className="text-sm text-ink-dim">书架中还没有匹配的书。</p>
              )}
            </div>
          )}
        </section>
      ))}
      <Link href="/" className="inline-flex min-h-11 items-center rounded-xl bg-ink px-5 text-sm text-white transition hover:bg-black/80">
        回到 Mentora，继续调整我的系统
      </Link>
    </div>
  );
}
