"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Brain, Compass, FileText, GraduationCap, Sparkles, Search, Settings2, Footprints, ShieldCheck } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { useAuth } from "@/lib/auth-client";
import { isAdminEmail } from "@/lib/admin-emails";
import { cn } from "@/lib/utils";
import { FOCUSABLE, isTopOverlay, registerOverlay } from "@/components/ui";

/* 全局命令面板（⌘K）——大厂标配的" everything 跳转器"。
 * 解决：侧栏收起后没有目录/搜索入口的问题——任何状态下 Ctrl/Cmd+K
 * 都能搜页面、目标、笔记、书籍并直接跳转（笔记落到 /brain?note=id 自动打开）。 */

interface Item {
  group: "页面" | "目标" | "笔记" | "书籍" | "我的系统";
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

  /* Esc/Tab 挂 document（与 ui.tsx Modal 同一套对话框标准）：
   * Esc 带 isTopOverlay 叠层隔离——⌘K 常叠在已打开的 Modal（z-50）之上，一次 Esc
   * 不得两层同关；Tab 环回焦点陷阱——dialog 声明了 aria-modal="true"，此前只有
   * 输入框上 preventDefault，点选结果项拿到焦点后 Tab/Shift+Tab 能落到遮罩背后
   * 的页面内容，与对读屏的承诺不符。 */
  const boxRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  });
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    /* 登记进 ui.tsx 的叠层栈：本面板后挂载即最上层，Esc 先归本层 */
    const unregister = box ? registerOverlay(box) : () => {};
    const focusables = () =>
      Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!isTopOverlay(boxRef.current)) return;
        onOpenChangeRef.current(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unregister();
      prevFocus?.focus?.();
    };
  }, []);


  const query = q.trim().toLowerCase();
  const hasQuery = query.length > 0;

  /* 笔记搜索索引：「标题 + 正文前 400 字」只 lower 一次，随 knowledge 引用缓存。
   * 逐键击仅对预建 hay 做 includes，不再为每条笔记反复 slice(0,400)+模板串+
   * toLowerCase 分配数 MB 临时串；空查询（刚打开面板）全部命中，索引都不建。 */
  const noteIndex = useMemo<string[]>(
    () =>
      hasQuery
        ? knowledge.map((k) => `${k.title} ${k.body.slice(0, 400)}`.toLowerCase())
        : [],
    [hasQuery, knowledge]
  );

  const items = useMemo<Item[]>(() => {
    const match = (s: string) => !query || s.toLowerCase().includes(query);
    const out: Item[] = [];

    const pages: [string, string, typeof Search][] = [
      ["/", "Mentora", Sparkles],
      ["/learn", "学习教练", GraduationCap],
      ["/brain", "第二大脑", Brain],
      ["/read", "读书伙伴", BookOpen],
      ["/council", "人生伙伴", Compass],
      ["/life", "成长记录", Footprints],
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
    for (let i = 0; i < knowledge.length; i++) {
      const k = knowledge[i];
      if (!query || noteIndex[i].includes(query)) {
        out.push({
          group: k.workspace ? "我的系统" : "笔记",
          label: k.title,
          hint: k.domain,
          icon: FileText,
          go: () => router.push(k.workspace ? `/workspace/${encodeURIComponent(k.id)}` : `/brain?note=${encodeURIComponent(k.id)}`),
        });
      }
    }
    for (const b of books) {
      if (match(b.title)) {
        out.push({ group: "书籍", label: b.title, icon: BookOpen, go: () => router.push(`/read/${b.id}`) });
      }
    }
    return out.slice(0, 14);
  }, [query, noteIndex, goals, knowledge, books, router, isAdmin, user]);
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
      className="viewport-overlay fixed inset-0 z-[80] bg-black/25 p-4 transition-opacity duration-300"
      style={{ opacity: shown ? 1 : 0 }}
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        className={cn(
          "materialize mx-auto mt-[min(12dvh,64px)] flex max-h-[calc(var(--visual-viewport-height,100dvh)-min(12dvh,64px)-32px)] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-border bg-white/85 shadow-overlay backdrop-blur-[20px] [backdrop-filter:saturate(180%)_blur(20px)]",
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
              }
              /* Tab 不在输入框上拦截：交给 document 级焦点陷阱环回（Shift+Tab 从输入框
                 回到末尾结果项，Tab 到首个结果项，末端再回输入框——与 Modal 一致） */
            }}
            placeholder="搜索页面、目标、笔记、书籍…"
            className="h-12 min-w-0 w-full bg-transparent text-[16px] text-ink outline-none placeholder:text-faint focus-visible:outline-none"
          />
          <kbd className="shrink-0 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-3 tabular">
            Esc
          </kbd>
        </div>

        <div ref={listRef} role="listbox" id="cmdk-result" aria-label="搜索结果" className="min-h-0 max-h-[52dvh] overflow-y-auto overscroll-contain p-1.5">
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
                  <span className="min-w-0 truncate font-medium">{it.label}</span>
                  {it.hint && <span className="ml-auto max-w-[30%] truncate text-[11px] text-ink-3">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
