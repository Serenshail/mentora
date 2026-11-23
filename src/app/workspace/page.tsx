"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useAppStore } from "@/lib/store";
import { parseWorkspace } from "@/lib/workspace";
import { useHydrated } from "@/lib/use-chat";

export default function PersonalWorkspaces() {
  const knowledge = useAppStore((s) => s.knowledge);
  const hydrated = useHydrated();
  /* 此前每次渲染都对每条带 workspace 的笔记跑完整 zod 校验（superRefine 里含每次
   * 180KB 上限的全文 stringify）——水合翻转、无关状态变化都会整页重算。memo 后
   * 只有 knowledge 数组真变化（云端快照、任意笔记编辑）才重新过滤。 */
  const pages = useMemo(() => knowledge.filter((n) => parseWorkspace(n.workspace)), [knowledge]);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold">我的系统</h1>
        <p className="text-sm leading-7 text-ink-dim">
          由你决定需要什么，再和 Mentora 一起搭建。文档、清单、记录表与学习计划可以按你的方式放在同一个页面。
        </p>
      </header>
      {!hydrated ? (
        <p role="status">正在打开…</p>
      ) : pages.length ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {pages.map((n) => (
            <Link
              key={n.id}
              className="min-w-0 rounded-2xl border border-border bg-white p-5 transition hover:border-accent/40"
              href={`/workspace/${encodeURIComponent(n.id)}`}
            >
              <h2 className="break-words font-semibold">{n.title}</h2>
              <p className="mt-2 line-clamp-2 break-words text-sm text-ink-dim">{n.body || "按你的需求搭建的个人页面"}</p>
              <p className="mt-3 text-xs text-ink-dim">
                {n.workspace!.blocks.length} 个区域 · {n.workspace!.pinned ? "已固定到侧栏" : "未固定"}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center">
          <p>你的系统会从当前真正需要的内容开始。</p>
          <p className="mt-2 text-sm text-ink-dim">告诉 Mentora 你想记录什么、跟踪什么，或怎样组织已有计划。</p>
        </div>
      )}
      <Link href="/" className="inline-flex min-h-11 items-center rounded-xl bg-ink px-5 text-sm text-white">
        和 Mentora 一起搭建
      </Link>
    </div>
  );
}
