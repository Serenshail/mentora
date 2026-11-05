"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Brain, Compass, FileText, GraduationCap, LayoutDashboard, Search, Settings2, Footprints, ShieldCheck } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin-emails";
import { cn } from "@/lib/utils";

/* 全局命令面板（⌘K）——大厂标配的" everything 跳转器"。
 * 解决：侧栏收起后没有目录/搜索入口的问题——任何状态下 Ctrl/Cmd+K
 * 都能搜页面、目标、笔记、书籍并直接跳转（笔记落到 /brain?note=id 自动打开）。 */

interface Item {
  group: "页面" | "目标" | "笔记" | "书籍";
  label: string;
  hint?: string;
  icon: typeof Search;
  go: () => void;
}

export function CmdK({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  /* 弹层期间锁滚动（放在常驻父组件；面板本体 open=false 时真卸载，state 自然重置） */
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
  if (!open) return null;
  return <CmdKDialog onOpenChange={onOpenChange} />;
}

function CmdKDialog({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [shown, setShown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const goals = useAppStore((s) => s.goals);
  const knowledge = useAppStore((s) => s.knowledge);
  const books = useAppStore((s) => s.books);
  const { user } = useAuth();
  const isAdmin = user ? isAdminEmail(user.email, process.env.NEXT_PUBLIC_ADMIN_EMAILS) : false;

  /* 挂载动画：下一拍加 .open，让 materialize 从当前值过渡（可打断） */
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setShown(true);
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  /* Esc 挂 document（焦点在面板任意处都能关，与 Modal 同标准），关闭后焦点归还触发元素 */
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [onOpenChange]);


  const items = useMemo<Item[]>(() => {
    const query = q.trim().toLowerCase();
    const match = (s: string) => !query || s.toLowerCase().includes(query);
    const out: Item[] = [];

    const pages: [string, string, typeof Search][] = [
      ["/", "总览", LayoutDashboard],
      ["/learn", "学习教练", GraduationCap],
      ["/brain", "第二大脑", Brain],
      ["/read", "读书伙伴", BookOpen],
      ["/council", "人生伙伴", Compass],
      ["/life", "学习人生", Footprints],
      ["/settings", "设置", Settings2],
    ];
    if (user && isAdmin) pages.push(["/admin", "管理后台", ShieldCheck]);
    for (const [href, label, icon] of pages) {
      if (match(label)) {
        out.push({ group: "页面", label, icon, go: () => router.push(href) });
      }
    }
    for (const g of goals) {
      if (match(`${g.topic} ${g.direction ?? ""}`)) {
        out.push({
          group: "目标",
          label: g.topic,
          hint: g.status === "draft" ? "草稿" : undefined,
          icon: GraduationCap,
          go: () => router.push(`/learn/${g.id}`),
        });
      }
    }
    for (const k of knowledge) {
      if (match(`${k.title} ${k.body.slice(0, 400)}`)) {
        out.push({
          group: "笔记",
          label: k.title,
          hint: k.domain,
          icon: FileText,
          go: () => router.push(`/brain?note=${k.id}`),
        });
      }
    }
    for (const b of books) {
      if (match(b.title)) {
        out.push({ group: "书籍", label: b.title, icon: BookOpen, go: () => router.push(`/read/${b.id}`) });
      }
    }
    return out.slice(0, 14);
  }, [q, goals, knowledge, books, router, isAdmin, user]);
  /* 键盘高亮跟随：选中项滚进可视区（listRef 此前只挂不读） */
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [idx, items]);

  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    onOpenChange(false);
    it.go();
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/25 p-4 transition-opacity duration-300"
      style={{ opacity: shown ? 1 : 0 }}
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        className={cn(
          "materialize mx-auto mt-[16vh] w-[min(600px,94vw)] overflow-hidden rounded-2xl border border-border bg-white/85 shadow-overlay backdrop-blur-[20px] [backdrop-filter:saturate(180%)_blur(20px)]",
          shown && "open"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search className="size-4.5 shrink-0 text-ink-3" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-result"
            aria-autocomplete="list"
            aria-activedescendant={items[idx] ? `cmdk-opt-${idx}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0); // 查询变了从头选
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => (i + 1) % Math.max(1, items.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => (i - 1 + items.length) % Math.max(1, items.length));
              } else if (e.key === "Enter") {
                e.preventDefault();
                pick(idx);
              } else if (e.key === "Tab") {
                e.preventDefault(); // 单输入面板：Tab 留在框内
              }
            }}
            placeholder="搜索页面、目标、笔记、书籍…"
            className="h-12 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-faint focus-visible:outline-none"
          />
          <kbd className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3 tabular">
            Esc
          </kbd>
        </div>

        <div ref={listRef} role="listbox" id="cmdk-result" aria-label="搜索结果" className="max-h-[52vh] overflow-y-auto p-1.5">
          {items.length === 0 && (
            <p role="presentation" className="px-3 py-8 text-center text-[13px] text-ink-3">没有匹配的结果</p>
          )}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={`${it.group}-${it.label}-${i}`}>
                {header && (
                  <p role="presentation" className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3/80">
                    {header}
                  </p>
                )}
                <button
                  role="option"
                  id={`cmdk-opt-${i}`}
                  aria-selected={i === idx}
                  data-active={i === idx || undefined}
                  onClick={() => pick(i)}
                  onMouseEnter={() => setIdx(i)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors duration-100",
                    i === idx ? "bg-black/[0.05] text-ink" : "text-ink-dim"
                  )}
                >
                  <it.icon className="size-4 shrink-0" strokeWidth={1.75} />
                  <span className="truncate font-medium">{it.label}</span>
                  {it.hint && <span className="ml-auto shrink-0 text-[11px] text-ink-3">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
