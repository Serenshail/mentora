"use client";

/* ============================================================
 * NoteWorkspace — 第二大脑的 Obsidian 式工作台
 * 左栏：搜索 / 标签筛选 / 笔记列表 / 新建
 * 中栏：标题 + 工具栏 + [[双链]] 自动补全的编辑器 / 预览（点击双链跳转或建新笔记）
 * 右栏：反向链接 · 出链 · 大纲 · 标签（Obsidian 右侧面板四件套）
 * 全局命令面板（⌘K，cmdk.tsx）负责任意跳转；自动保存（改动即写入，无需手动保存）
 * ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Empty } from "@/components/ui";
import { WikiMarkdown } from "@/components/brain/wiki-markdown";
import { fileToMarkdown, docTitleFromFilename } from "@/lib/doc-import";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { KnowledgeItem } from "@/lib/types";
import { toast } from "sonner";
import { buildWikiIndex, hasUnlinkedWikiMention, resolvedWikiIds, wikiHeadingId } from "@/lib/wiki-links";
import {
  ArrowDownUp, Bold, Braces, ChevronRight, Eye, FileText, FolderPlus, Heading2, Heading3,
  Loader2, PanelRight,
  Link2, List, ListOrdered, Minus, MoreVertical, Pencil, Plus, Quote, RefreshCcw, Search, Sparkles, Tag,
  Trash2, Type, Upload, X, Zap,
} from "lucide-react";

type RightTab = "backlinks" | "outgoing" | "outline" | "tags";

/** 笔记来源的读法（E3：来源要能看懂，不是枚举值直出） */
const SOURCE_LABELS: Record<string, string> = {
  learn: "学习产出",
  read: "阅读产出",
  council: "圆桌/人生伙伴",
  manual: "手动记录",
  obsidian: "Obsidian 导入",
};

/* ---- 小工具 ---- */

function normTitle(t: string) {
  return t.trim().toLowerCase();
}

/** 大纲：解析正文标题，忽略代码围栏。 */
function outlineOf(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence=marker[1]; else if (marker[1][0]===fence[0] && marker[1].length>=fence.length) fence=null; continue; }
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (m && m[2].trim()) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** 行内 #标签；配合 tags 字段一起展示。
 *  标题行的行首 #（## 二级）不会被误当标签：捕获组已排除 # 与空白，去掉前导空白后
 *  首字符必然是 #，因此「1-6 个 # + 空白」永远不会命中——无需（也无法）再做一次
 *  「标题行排除」。标题行里另写的 #标签（如「## 项目 #重要」）照常计入，与 Obsidian 一致。 */
function inlineTags(body: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\s)#([^\s#`~!@#$%^&*()=+{\}[\]|\\:;"'<>,.?/，。！？：（）【】]{2,24})/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const t = m[1].replace(/[.,;:!?，。：；！？]+$/, "");
    if (t && !/^\d+$/.test(t)) out.add(t);
  }
  return [...out];
}

const TAGS_OF = (k: KnowledgeItem) => [...new Set([...(k.tags ?? []), ...inlineTags(k.body)])];

/* 把正文切成"块"（空行分隔；代码围栏内部不拆），供块级实时预览编辑 */
function splitBlocks(body: string): string[] {
  const lines = body.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const flush = () => {
    if (cur.length) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
  };
  for (const ln of lines) {
    if (/^```/.test(ln.trim())) {
      inFence = !inFence;
      cur.push(ln);
      continue;
    }
    if (!inFence && ln.trim() === "") {
      flush();
      continue;
    }
    cur.push(ln);
  }
  flush();
  return blocks;
}

/* 把「未提交草稿」rebase 到 currentBody 上并返回应写回的正文（null = 无需提交）。
 * 段级编辑只替换目标段落，不再用编辑开始时的 blocks 快照整体覆写正文——否则编辑期间
 * 由别处（AI 追加摘要 / 整篇润色）落库的改动会被 join 出来的旧快照静默抹掉。 */
function rebaseDraft(
  pending:
    | { mode: "whole"; text: string }
    | { mode: "block"; index: number; text: string; blocks: string[] },
  currentBody: string
): string | null {
  if (pending.mode === "whole") {
    if (pending.text === currentBody) return null;
    /* 整篇草稿不整篇覆盖：敲字期间若有外部落库到达（bindStoreSync 跨标签页 adopt 等
       会整仓替换 knowledge），currentBody 已非空且不等于草稿——整体写回会把外部写入
       静默抹掉。与段级路径同一哲学：宁可多一段也不丢字，草稿追加为独立段落。 */
    if (currentBody.trim()) return [...splitBlocks(currentBody), pending.text].join("\n\n");
    return pending.text;
  }
  const orig = pending.blocks[pending.index];
  if (pending.text === orig) return null; // 本段没改：不写回，免得白白覆盖别处改动
  const cur = splitBlocks(currentBody);
  /* 优先按原下标（并发改动多为追加，下标仍对齐）；下标处已不是原段落时再按内容找 */
  const at = cur[pending.index] === orig ? pending.index : cur.indexOf(orig);
  if (at >= 0) {
    cur[at] = pending.text;
    return cur.join("\n\n");
  }
  /* 原段落已被别处改写/删除（如整篇 AI 润色）：不覆写整篇，把这次编辑追加为独立段落，
     宁可多一段也不静默丢掉用户刚敲的内容。 */
  return [...cur, pending.text].join("\n\n");
}

/* Obsidian 式实时预览编辑：整篇默认渲染成排版文档；点哪一段,只有那一段进入可编辑(显示原文),
 * 其余段落保持渲染、纹丝不动。不懂 MD 的人也能直接改。提交只替换被编辑的那一块。 */
function LiveBlocks({
  body,
  notes,
  onCommit,
  onOpen,
  onCreate,
  onRewrite,
}: {
  body: string;
  notes: KnowledgeItem[];
  onCommit: (next: string) => void;
  onOpen: (id: string) => void;
  onCreate: (title: string) => void;
  onRewrite?: (t: string) => Promise<string>;
}) {
  const blocks = useMemo(() => splitBlocks(body), [body]);
  const [active, setActive] = useState<number | null>(null);
  const [text, setText] = useState("");
  /* 块级 AI 改写：旧实现既无门也无失败反馈——可以连点发起并发调用，返回后 setText
   * 覆盖用户等待期间敲的内容，失败还静默吞掉（同文件其它 AI 按钮都有门）。
   * 三处都补上了：按钮 disabled 防连点、catch 出 toast、返回期间 textarea readOnly
   * 关掉「等待中继续敲字被 setText 覆盖」的丢失窗口。 */
  const [rewriting, setRewriting] = useState(false);

  /* 尚未提交的草稿。空笔记（blocks=[]）走整篇 textarea 分支，active 恒为 null——
   * 旧实现的 commit() 首行 `if (active == null) return` 让这条默认路径的正文永远不落库，
   * 切到另一篇笔记时组件卸载、局部 state 销毁，用户输入静默丢失。 */
  const pendingRef = useRef<
    | { mode: "whole"; text: string }
    | { mode: "block"; index: number; text: string; blocks: string[] }
    | null
  >(null);
  /* 卸载兜底必须用最新回调；onCommit 闭包绑定的是当前这篇笔记的 id，切走时不会写错对象 */
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });
  /* 最新正文镜像：卸载兜底 effect 是空依赖闭包，读不到最新的 body prop——没有它 rebase
   * 只能拿首帧正文，等于又回到「用旧正文兜底」。 */
  const bodyRef = useRef(body);
  useEffect(() => {
    bodyRef.current = body;
  });

  const commit = () => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) {
      /* rebase 到此刻的正文：段级编辑只替换本段，不再整体覆写、丢掉编辑期间的 AI 写入 */
      const next = rebaseDraft(pending, body);
      if (next != null) onCommit(next);
    }
    setActive(null);
  };

  /* 兜底：失焦没触发（键盘/程序化跳转、直接切笔记）时也把草稿写回去。
   * whole 模式同样过 rebaseDraft：有外部写入到达时追加而非整篇覆盖，等值时不产生多余 store 写。 */
  useEffect(
    () => () => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending) return;
      const next = rebaseDraft(pending, bodyRef.current);
      if (next != null) commitRef.current(next);
    },
    []
  );

  const open = (i: number) => {
    /* 改写等待期禁止切换编辑目标：否则异步返回后 setText(rewritten) + pendingRef
       会把 i 的改写稿写进用户后来点开的段落 j（段落错位/重复）。textarea 在等待期
       readOnly 只防了输入，点其他段落这条路径必须在这里挡住。 */
    if (rewriting) return;
    // 先落上一段未提交的改动，再切换编辑目标（防止程序化跳转绕过 blur）
    if (pendingRef.current) commit();
    setActive(i);
    setText(blocks[i] ?? "");
    pendingRef.current = null;
  };

  return (
    <div className="min-h-full px-3 py-3">
      {blocks.length === 0 ? (
        <textarea
          autoFocus
          className="min-h-[40vh] w-full resize-none bg-transparent px-2 font-mono text-[13px] leading-relaxed text-ink outline-none"
          value={text}
          placeholder="像聊天一样写就行——点别处自动排版。输入 [[ 可链接其他笔记…"
          onChange={(e) => {
            setText(e.target.value);
            pendingRef.current = { mode: "whole", text: e.target.value };
          }}
          onBlur={commit}
        />
      ) : (
        blocks.map((b, i) =>
          active === i ? (
            <div key={i}>
              {onRewrite && (
                <div className="mb-1 flex justify-end">
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    disabled={rewriting}
                    onClick={async () => {
                      setRewriting(true);
                      try {
                        const rewritten = await onRewrite(text);
                        setText(rewritten);
                        // 改写结果也是未提交草稿：否则切走时会被当成"没改过"
                        pendingRef.current = { mode: "block", index: i, text: rewritten, blocks };
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "AI 改写失败，原文未改动");
                      } finally {
                        setRewriting(false);
                      }
                    }}
                    className="rounded-md px-1.5 py-0.5 text-[10.5px] text-accent transition hover:bg-accent/[0.08] cursor-pointer disabled:opacity-50"
                    title="AI 改写这一段（不改原意）"
                  >
                    {rewriting ? "改写中…" : "✨ AI 改写这段"}
                  </button>
                </div>
              )}
              <textarea
              autoFocus
              rows={Math.max(2, text.split("\n").length + 1)}
              className="my-1 w-full resize-none rounded-lg border border-accent/40 bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-ink outline-none"
              value={text}
              /* 改写期间只读：否则用户在最长 45s 的等待里继续敲字，onRewrite 返回后的
                 setText(rewritten) 会把这段输入连同 pendingRef 一起静默覆盖掉。
                 readOnly 不移除焦点、不触发 blur，专注状态与已提交草稿都不受影响。 */
              readOnly={rewriting}
              onChange={(e) => {
                setText(e.target.value);
                pendingRef.current = { mode: "block", index: i, text: e.target.value, blocks };
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Escape") commit();
              }}
              />
            </div>
          ) : (
            <div
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => open(i)}
              onKeyDown={(e) => {
                /* 键盘也能进块编辑；内部链接按钮的回车不在这里截胡 */
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open(i);
                }
              }}
              title="点击编辑这一段（其余保持排版）"
              className="prose-mentora cursor-text rounded-lg px-3 py-1.5 transition hover:bg-black/[0.035]"
            >
              <WikiMarkdown body={b} notes={notes} onOpen={onOpen} onCreate={onCreate} />
            </div>
          )
        )
      )}
    </div>
  );
}

/* Obsidian 式搜索命中上下文：截取首个命中处前后若干字符并压平空白 */
function matchSnippet(body: string, q: string): string | null {
  const idx = body.toLowerCase().indexOf(q);
  if (idx === -1) return null;
  const start = Math.max(0, idx - 18);
  const end = Math.min(body.length, idx + q.length + 42);
  const raw = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${raw}${end < body.length ? "…" : ""}`;
}

/* 左栏行摘要：逐键重渲染热路径。此前是行内联正则（双链剥离 + 语法字符剥离，
 * 兜底分支还要把 TAGS_OF→inlineTags 全文跑两遍），raw 模式每键 setBodyDraft 触发
 * 整组件重渲染时，每个可见行都把该笔记完整正文重算一遍。store 的写入路径都换
 * 新对象引用，WeakMap 按对象身份缓存即可：只有真正被编辑的那篇会重算。 */
const rowSummaryCache = new WeakMap<KnowledgeItem, string>();
function rowSummary(k: KnowledgeItem): string {
  let s = rowSummaryCache.get(k);
  if (s === undefined) {
    const flat = k.body.replace(/\[\[([^\[\]]+)\]\]/g, "$1").replace(/[#*`>-]/g, "").slice(0, 40);
    if (flat) {
      s = flat;
    } else {
      const tags = TAGS_OF(k)
        .slice(0, 3)
        .map((t) => "#" + t)
        .join(" ");
      s = tags || "（空笔记）";
    }
    rowSummaryCache.set(k, s);
  }
  return s;
}

/* 搜索态命中片段同理按笔记对象身份缓存（q 作二级键）：同一查询下的每次重渲染
 * 不再对命中正文全量 indexOf；笔记对象被替换（编辑落库）时旧缓存随之可回收。 */
const snippetCache = new WeakMap<KnowledgeItem, Map<string, string | null>>();
function snippetFor(k: KnowledgeItem, q: string): string | null {
  let per = snippetCache.get(k);
  if (!per) {
    per = new Map();
    snippetCache.set(k, per);
  }
  let s = per.get(q);
  if (s === undefined) {
    s = matchSnippet(k.body, q);
    per.set(q, s);
  }
  return s;
}

/* 大小写不敏感高亮命中词 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const hit = lower.indexOf(ql, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(
      <mark key={key++} className="rounded-sm bg-accent/20 px-0.5 text-ink">
        {text.slice(hit, hit + ql.length)}
      </mark>
    );
    i = hit + ql.length;
  }
  return <>{parts}</>;
}

/* ============================================================ */

/* 编辑器工具栏：事件在点击时才触达 ref */
interface ToolbarHandlers {
  note: KnowledgeItem | null;
  /** 当前正文（含未落库的本地草稿）：程序化编辑要基于它，否则会算错光标位置 */
  liveBody: string;
  setBody: (b: string) => void;
  onTaChange: (b: string, caret: number) => void;
  /** 只重算 [[ 补全候选（不改正文），用于插入后光标归位 */
  onCaretMove: (b: string, caret: number) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
  surround: (before: string, after?: string, placeholder?: string) => void;
  autoLink: () => void | Promise<void>;
  linking: boolean;
}

const TOOLBAR: {
  id: string;
  icon: typeof Bold;
  title: string;
  run: (h: ToolbarHandlers) => void;
}[] = [
  { id: "bold", icon: Bold, title: "粗体", run: (h) => h.surround("**", "**", "粗体") },
  { id: "italic", icon: Type, title: "斜体", run: (h) => h.surround("*", "*", "斜体") },
  { id: "h2", icon: Heading2, title: "二级标题", run: (h) => h.surround("\n## ", "", "标题") },
  { id: "h3", icon: Heading3, title: "三级标题", run: (h) => h.surround("\n### ", "", "标题") },
  { id: "code", icon: Braces, title: "行内代码", run: (h) => h.surround("`", "`", "代码") },
  { id: "quote", icon: Quote, title: "引用", run: (h) => h.surround("\n> ", "", "引用的话") },
  { id: "ul", icon: List, title: "无序列表", run: (h) => h.surround("\n- ", "", "条目") },
  { id: "ol", icon: ListOrdered, title: "有序列表", run: (h) => h.surround("\n1. ", "", "条目") },
  { id: "hr", icon: Minus, title: "分割线", run: (h) => h.surround("\n\n---\n\n", "", "") },
  {
    id: "wikilink",
    icon: Link2,
    title: "[[双链]]",
    run: (h) => {
      const ta = h.taRef.current;
      if (!ta || !h.note) return;
      const pos = ta.selectionStart;
      /* 基于 liveBody（可能含未落库草稿）而不是 store 里的 note.body */
      const body2 = h.liveBody.slice(0, pos) + "[[" + h.liveBody.slice(pos);
      h.setBody(body2);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(pos + 2, pos + 2);
        h.onCaretMove(body2, pos + 2);
      });
    },
  },
  { id: "autolink", icon: Sparkles, title: "AI 建联：找出有思想联系的笔记", run: (h) => void h.autoLink() },
];

export function NoteWorkspace({
  openId,
  onOpenNote,
  mode,
  onModeChange,
  onGraph,
  onReview,
  dueCount = 0,
  importSlot,
}: {
  openId: string | null;
  onOpenNote: (id: string | null) => void;
  mode: "preview" | "edit";
  onModeChange: (m: "preview" | "edit") => void;
  /** 左缘 ribbon：切图谱 / 开始复习（数据从父组件来） */
  onGraph?: () => void;
  onReview?: () => void;
  dueCount?: number;
  /** Obsidian 导入按钮（iconOnly 形态） */
  importSlot?: React.ReactNode;
}) {
  const knowledge = useAppStore((s) => s.knowledge);
  const createKnowledge = useAppStore((s) => s.createKnowledge);
  const updateKnowledge = useAppStore((s) => s.updateKnowledge);
  const enableReview = useAppStore((s) => s.enableReview);
  const removeKnowledge = useAppStore((s) => s.removeKnowledge);
  /* 删文件夹用：一次 set 完成 N 篇删除，逐篇 removeKnowledge 是 N 次全库重算 + N 次全仓 persist 写盘 */
  const removeKnowledgeMany = useAppStore((s) => s.removeKnowledgeMany);
  const linkNotes = useAppStore((s) => s.linkNotes);
  const folders = useAppStore((s) => s.folders);
  /* 来源失效告警的数据源：此前渲染期 useAppStore.getState() 直读——非订阅，别处删除
   * 目标/书/圆桌会话不会触发本组件重渲染，⚠ 告警要等某次无关变化才补显，状态与数据脱节 */
  const srcGoals = useAppStore((s) => s.goals);
  const srcBooks = useAppStore((s) => s.books);
  const srcSessions = useAppStore((s) => s.sessions);
  const addFolder = useAppStore((s) => s.addFolder);
  const removeFolder = useAppStore((s) => s.removeFolder);

  const [query, setQuery] = useState("");
  /* 编辑态默认 Obsidian 式实时预览(块级),可切源码 */
  const [editStyle, setEditStyle] = useState<"live" | "raw">("live");
  /* 移动端单栏:列表/笔记/信息 三选一切换(桌面仍多栏并列) */
  const [mobilePane, setMobilePane] = useState<"list" | "editor" | "info">("list");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [jump, setJump] = useState<{ id: string; heading: string } | null>(null);
  useEffect(() => {
    if (!openId) return;
    const frame = requestAnimationFrame(() => setRecentIds(ids => ids.includes(openId) ? ids : [...ids,openId].slice(-6)));
    return () => cancelAnimationFrame(frame);
  }, [openId]);
  const openLinkedNote = useCallback((id: string, heading?: string) => {
    const target = id || openId;
    if (!target) return;
    onOpenNote(target);
    onModeChange("preview");
    setMobilePane("editor");
    if (heading) setJump({id:target,heading});
  }, [openId,onOpenNote,onModeChange]);
  useEffect(() => {
    if (!jump || jump.id !== openId || mode !== "preview") return;
    const frame = requestAnimationFrame(() => {
      const heading = document.getElementById(wikiHeadingId(jump.heading));
      if (heading && workspaceRef.current?.contains(heading)) heading.scrollIntoView({block:"start",behavior:"smooth"});
      setJump(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [jump,openId,mode,mobilePane]);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "e" || event.altKey || !openId) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      onModeChange(mode === "edit" ? "preview" : "edit");
    };
    window.addEventListener("keydown",toggle);
    return () => window.removeEventListener("keydown",toggle);
  }, [mode,openId,onModeChange]);
  // Deep links and backlinks must open the selected note in the single-pane layout.
  // A later manual switch to the list remains intact until a different note is opened.
  useEffect(() => {
    if (!openId) return;
    const frame = requestAnimationFrame(() => setMobilePane("editor"));
    return () => cancelAnimationFrame(frame);
  }, [openId]);
  /* 三个 AI 动作各自标记忙碌：共用一个布尔会让三个按钮同时变成同一句「AI 中…」，
     用户分不清在跑哪个（追加摘要 / 整篇重写 / 全库编译行为差异很大）。 */
  const [aiBusy, setAiBusy] = useState<null | "summarize" | "rewrite" | "wiki">(null);
  /* AI 中断态：每次 AI 动作开一个 AbortController 挂在这里，「取消」按钮 abort 它，
     不用干等 45s 自动超时。ctrl.signal.aborted 只在用户主动取消时为 true
     （AbortSignal.timeout 超时不会 abort 这个 ctrl），catch 里据此区分文案。 */
  const aiAbortRef = useRef<AbortController | null>(null);

  /* AI 帮改笔记:rewrite 润色 / summarize 总结 / continue 续写(服务端组装提示词)。
   * useCallback 稳定引用：WikiMarkdown 有 memo（wiki-markdown.tsx），onRewrite/
   * onCreate 等内联箭头每帧新引用会让 memo 恒失效（见下方 onCreateWiki）。 */
  const aiNote = useCallback(async (mode: "rewrite" | "summarize" | "continue", text: string) => {
    /* 取消 signal 从 aiAbortRef 入口同步读取（调用方开跑前已把本次的 controller
     * 挂上）。不作为第三个参数传入：既有回归锁以本函数的两参调用形态为语义锚点，
     * 签名保持不变。ref 在入口同步读，绑定的就是发起这一次调用的 controller。 */
    const external = aiAbortRef.current?.signal;
    const { streamChat } = await import("@/lib/ai/client");
    return streamChat({
      task: "note-assist",
      args: { mode, text },
      messages: [{ role: "user", content: "执行。" }],
      temperature: 0.3,
      /* 弱网下不设超时会让 aiBusy 恒为 true：45s 自动超时兜底 + 用户可主动取消
         （「取消」按钮 abort aiAbortRef 里的 controller），任一触发即中止。 */
      signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(external ? [external] : [])]),
      onDelta: () => {},
    });
  }, []);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("backlinks");
  const [tagEdit, setTagEdit] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [rightOpen, setRightOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newFolder, setNewFolder] = useState<string | null>(null);
  /* 展开到某路径：沿途每一级父夹都要展开。renderDir 的 isOpen 只看自身路径是否在
   * expanded 里，创建「a/b」时若只展开叶子，父夹「a」折叠或本次连带新建时整支子树
   * 不渲染——用户回车后看不到新文件夹，以为创建失败。 */
  const expandPath = (path: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      const segs = path.split("/");
      for (let i = 1; i <= segs.length; i++) next.add(segs.slice(0, i).join("/"));
      return next;
    });
  };
  const docInputRef = useRef<HTMLInputElement>(null);
  const [docBusy, setDocBusy] = useState(false);
  /* 上传文档 → Markdown 笔记（进当前笔记所在科目/笔记,否则 笔记/笔记） */
  const uploadDoc = async (file: File) => {
    if (docBusy) return; // .docx 转换数秒级，防重复触发
    if (file.size > 20 * 1024 * 1024) {
      toast.error("文件超过 20MB——请拆分后再导入");
      return;
    }
    setDocBusy(true);
    try {
      const body = await fileToMarkdown(file);
      const title = docTitleFromFilename(file.name);
      const store = useAppStore.getState();
      const subj = (store.knowledge.find((k) => k.id === openId)?.domain?.split("/")[0] || "笔记");
      const dup = store.knowledge.find((k) => k.title === title);
      if (dup) {
        // 同名文档 = 更新：addKnowledge 按标题去重会把新内容静默丢弃，还提示"已导入"
        // 覆盖不可恢复，与删除/AI 润色同一档确认
        if (!confirm(`已有同名笔记《${title}》，用新文档覆盖它的正文？`)) return;
        /* 只覆盖正文，不动 domain：确认框只承诺覆盖正文，旧实现顺带改 domain 会把
         * 其他科目下的同名笔记悄悄搬进当前科目（updateKnowledge 对 domain 变更连带
         * 重算两个科目的 MOC，移动持久生效）。dup 若是 Obsidian 断链生成的 unresolved
         * 占位，覆盖后必须清掉占位标记：否则它继续按灰色虚影渲染（graph-view）、
         * wiki 编译永久跳过它（wiki-compile），且 addKnowledge 的标题去重排除占位——
         * 之后同标题的学习/读书产出会再建一篇重复笔记。 */
        store.updateKnowledge(dup.id, { body, ...(dup.unresolved ? { unresolved: false } : {}) });
        openLinkedNote(dup.id);
        toast.success(`已更新《${title}》`);
        return;
      }
      store.addKnowledge([{ title, body, domain: `${subj}/笔记` }], "manual", "上传文档");
      // 导入后直接打开这篇,用户立刻看到转换结果(而不是"传了但没反应")
      const created = useAppStore.getState().knowledge.find((k) => k.title === title);
      if (created) openLinkedNote(created.id);
      toast.success(`已导入《${title}》`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败");
    } finally {
      setDocBusy(false);
    }
  };
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null); // 当前打开 ⋮ 菜单的文件夹
  const [showTags, setShowTags] = useState(false); // 标签筛选默认收起
  const taRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLDivElement>(null); // 标题栏：编辑态失焦豁免区

  /* 点击空白处关闭文件夹菜单 */
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuFor]);

  /* [[ 自动补全状态：fragment 为 [[ 之后到光标的文本 */
  const [suggest, setSuggest] = useState<{ fragment: string; index: number } | null>(null);
  const [suggestIdx, setSuggestIdx] = useState(0);

  const note = knowledge.find((k) => k.id === openId) ?? null;

  /* ---- 派生 ---- */
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of knowledge) for (const t of TAGS_OF(k)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  }, [knowledge]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return knowledge.filter((k) => {
      if (activeTag && !TAGS_OF(k).some((t) => t.toLowerCase() === activeTag.toLowerCase())) return false;
      if (!q) return true;
      return k.title.toLowerCase().includes(q) || k.body.toLowerCase().includes(q);
    });
  }, [knowledge, query, activeTag]);

  const wikiIndex = useMemo(() => buildWikiIndex(knowledge),[knowledge]);
  const backlinks = useMemo(
    () => (note ? knowledge.filter((k) => k.id !== note.id && ((k.links ?? []).includes(note.id) || resolvedWikiIds(k.body,wikiIndex).includes(note.id))) : []),
    [knowledge, note,wikiIndex]
  );
  const outgoing = useMemo(
    () =>
      note
        ? [...new Set([...(note.links ?? []),...resolvedWikiIds(note.body,wikiIndex)])]
            .map((id) => knowledge.find((k) => k.id === id))
            .filter((k): k is KnowledgeItem => !!k)
        : [],
    [knowledge, note,wikiIndex]
  );
  const relatedNotes = [...new Map([...outgoing, ...backlinks].map((item) => [item.id, item])).values()]
    .filter((item) => item.id !== note?.id);
  /* 大纲与阅读/编辑模式无关：编辑态右栏同样能看到当前正文的标题结构，
     否则编辑模式下明明有 ## 标题，大纲 tab 却显示「写几个标题就会有大纲」的假空态。 */
  const outline = useMemo(() => (note ? outlineOf(note.body) : []), [note]);
  const noteTags = note ? TAGS_OF(note) : [];

  /* 未链接提及只展示正文中尚未建立关系的普通文字；不重复已解析的反链。 */
  const unlinkedMentions = useMemo(() => {
    if (!note) return [];
    const linked = new Set(backlinks.map(k=>k.id));
    return knowledge.filter(k=>k.id!==note.id&&!linked.has(k.id)&&hasUnlinkedWikiMention(k.body,note.title));
  }, [knowledge, note, backlinks]);

  /* ---- 打开 / 新建 ---- */
  const openByTitle = useCallback(
    (title: string, edit = false) => {
      const found = knowledge.find((k) => normTitle(k.title) === normTitle(title));
      if (found) {
        onOpenNote(found.id);
        if (edit) onModeChange("edit");
        return found;
      }
      /* 点双链的新目标：建一篇同名笔记并进入编辑 */
      const id = createKnowledge({ title: title.trim(), domain: "笔记" });
      onOpenNote(id);
      onModeChange("edit");
      return null;
    },
    [knowledge, createKnowledge, onOpenNote]
  );

  /* 传给 WikiMarkdown/LiveBlocks 的稳定回调。wiki-markdown.tsx 对 WikiMarkdown 做了
   * memo（注释明言避免整库导入后每块重解析），内联箭头每帧新引用会让浅比较恒失败：
   * live 模式下父级任意 state 变化（搜索逐键、titleDraft、suggest、aiBusy、dragOverPath）
   * 都会把当前笔记每个可见块重跑一遍 ReactMarkdown 解析。 */
  const onCreateWiki = useCallback((title: string) => openByTitle(title, true), [openByTitle]);
  /* 块级改写也占住全局 AI 忙碌位：否则块级「AI 改写这段」的 45s 等待期里，父级
   * 「AI 总结 / AI 润色 / AI 整理」仍可点击，两个 AI 并发写同一篇笔记。 */
  const rewriteNoteBlock = useCallback(
    (t: string) => {
      const ctrl = new AbortController();
      aiAbortRef.current = ctrl;
      setAiBusy("rewrite");
      /* 取消的文案在这里归一：LiveBlocks 的 catch 只展示 e.message，
         AbortError 原文是英文 DOMException（「用户取消」不显示成一条错误）。 */
      return aiNote("rewrite", t)
        .catch((e) => {
          throw ctrl.signal.aborted && !(e instanceof DOMException && e.name === "TimeoutError")
            ? new Error("已取消 AI 改写")
            : e;
        })
        .finally(() => setAiBusy(null));
    },
    [aiNote]
  );

  const createNote = (domain?: string) => {
    const id = createKnowledge({ domain: domain ?? "笔记" });
    onOpenNote(id);
    onModeChange("edit");
    setMobilePane("editor"); // 手机上新建后直接进编辑，与其它打开笔记路径一致
    if (!domain) toast.success("已新建，标题点一下就能改。");
    else setExpanded((s) => new Set(s).add(domain));
  };


  /* ---- 编辑器：自动保存 + [[ 补全 + 工具栏 ---- */

  /* 正文逐键编辑的落库节流。原先 textarea 每次 onChange 都 setBody → updateKnowledge：
   * 每键重建全库派生（标签 TAGS_OF / 列表 filtered / 目录树 dirTree）并触发整仓
   * localStorage 同步序列化（store.ts persist 无防抖），大库打字卡顿。改为打字期间
   * 只推进本地草稿（输入零延迟），空闲 350ms、失焦、切笔记或卸载时才一次性落库。 */
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const bodyDraftRef = useRef<string | null>(null); // 供卸载/失焦的陈旧闭包读取
  /* 打字那一刻这一帧的 setBody：它闭包绑定的正是当时这篇笔记，切笔记的卸载清理
     也用它写回上一篇，不会写到新笔记上。 */
  const bodyWriterRef = useRef<((b: string) => void) | null>(null);
  const bodyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBodyTimer = () => {
    if (bodyTimerRef.current) {
      clearTimeout(bodyTimerRef.current);
      bodyTimerRef.current = null;
    }
  };
  /* 落库：本地草稿 → store（用打字时那一帧的 setBody 闭包写，绑定的笔记不会错；
     切笔记的卸载清理也走它，不会把上一篇的草稿写进新笔记）。 */
  const flushBodyDraft = () => {
    if (bodyTimerRef.current) {
      clearTimeout(bodyTimerRef.current);
      bodyTimerRef.current = null;
    }
    const writer = bodyWriterRef.current;
    const text = bodyDraftRef.current;
    bodyWriterRef.current = null;
    bodyDraftRef.current = null;
    setBodyDraft(null);
    if (writer && text !== null) writer(text);
  };
  /* 定时器/卸载清理要拿到最新 flushBodyDraft；不在 render 期写 ref（React 禁止） */
  const flushBodyDraftRef = useRef(flushBodyDraft);
  useEffect(() => {
    flushBodyDraftRef.current = flushBodyDraft;
  });

  const setBody = (body: string) => {
    /* 程序化写入（工具栏 / AI / 提交）优先于在途的逐键草稿：取消定时器并让位，
       否则草稿稍后会把程序化写入或 AI 结果覆盖回旧文本。 */
    cancelBodyTimer();
    bodyWriterRef.current = null;
    bodyDraftRef.current = null;
    setBodyDraft(null);
    if (!note) return;
    /* 取 store 里此刻的这篇（而不是本帧闭包里的 note）：编辑器可能已经跑过几轮
       updateKnowledge，用陈旧引用算 links 差值会漏掉期间新增/删除的双链。 */
    const st = useAppStore.getState();
    const target = st.knowledge.find((k) => k.id === note.id);
    if (!target) return;
    /* 敲 [[标题]] 时自动把双链解析进 links（标题→id），反链/图谱即时生效。
       删掉正文里的 [[...]] 时同步移除对应链接（只增不减会让陈旧反链永久误导）：
       以「旧正文解析出的链接」为界，之外的都是无文本来源的手动/AI 链接，保留。 */
    const byTitle = buildWikiIndex(st.knowledge);
    const parse = (s: string) => {
      return resolvedWikiIds(s,byTitle).filter(id => id !== target.id);
    };
    const resolved = parse(body);
    const textLinks = new Set(parse(target.body));
    const manual = target.links.filter((id) => !textLinks.has(id));
    st.updateKnowledge(target.id, { body, links: [...new Set([...resolved, ...manual])] });
  };

  /* 切笔记 / 组件卸载：把在途草稿落库，避免节流窗口内切走时丢字 */
  useEffect(() => () => flushBodyDraftRef.current(), [note?.id]);

  /* 光标前是否有未闭合的 [[ —— 逐键与点击光标都要跑，与落库解耦 */
  const detectSuggest = (body: string, caret: number) => {
    const before = body.slice(0, caret);
    const m = before.match(/\[\[([^\]\n]*)$/);
    if (m) {
      setSuggest({ fragment: m[1], index: caret });
      setSuggestIdx(0);
    } else {
      setSuggest(null);
    }
  };

  /* textarea 逐键：只推进本地草稿并排定落库，不在每键上重算全库；[[ 补全按草稿即时检测 */
  const onTaChange = (body: string, caret: number) => {
    if (note) {
      bodyDraftRef.current = body;
      bodyWriterRef.current = setBody; // 绑定此刻这篇笔记，切笔记的清理也写回它
      setBodyDraft(body);
      cancelBodyTimer();
      bodyTimerRef.current = setTimeout(() => flushBodyDraftRef.current(), 350);
    }
    detectSuggest(body, caret);
  };

  const suggestCandidates = useMemo(() => {
    if (!suggest) return [];
    const frag = suggest.fragment.toLowerCase();
    return knowledge
      .filter((k) => k.id !== note?.id && k.title.toLowerCase().includes(frag))
      .slice(0, 7);
  }, [suggest, knowledge, note]);

  const applySuggest = (title: string) => {
    if (!note || !suggest) return;
    const ta = taRef.current;
    /* 用本地草稿而非 note.body：草稿可能还没落库（节流窗口内），拿 store 的旧正文
       拼接会把光标前刚敲的 [[ 之前的字符算错位。setBody 会取消在途草稿并按最新正文落库。 */
    const body = bodyDraftRef.current ?? note.body;
    const start = suggest.index - suggest.fragment.length - 2; // [[ 位置
    const next = body.slice(0, start) + `[[${title}]]` + body.slice(suggest.index);
    setBody(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      ta?.focus();
      const pos = start + title.length + 4;
      ta?.setSelectionRange(pos, pos);
    });
  };

  /* 「＋ 新建」行的统一激活入口：下拉头部的「Enter 插入」提示对它同样成立。
     fragment 为空白时插不出 [[标题]]，给一句提示并保持下拉开着（用户还在输入）。 */
  const activateNewNoteSuggest = () => {
    if (!suggest) return;
    const t = suggest.fragment.trim();
    if (t) applySuggest(t);
    else toast("先输入标题，再点「＋ 新建」");
  };

  const onTaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /* 中文 IME 组词期间不劫持键：Enter/Tab/方向键是「确认组词 / 切换候选」，此时把它
       当 [[ 补全操作会插入 [[...]] 并打断组词（与 agent-home.tsx:714 同一守卫）。 */
    if (e.nativeEvent.isComposing) return;
    if (suggest && suggestCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestIdx((i) => (i + 1) % suggestCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestIdx((i) => (i - 1 + suggestCandidates.length) % suggestCandidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySuggest(suggestCandidates[suggestIdx].title);
        return;
      }
      if (e.key === "Escape") {
        setSuggest(null);
        return;
      }
    } else if (suggest) {
      /* 无候选时下拉只剩「＋ 新建」一行（渲染为选中态）：Enter/Tab 激活它，
         键盘用户也能借补全建新笔记，与鼠标点击同路径 */
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        activateNewNoteSuggest();
        return;
      }
      if (e.key === "Escape") {
        setSuggest(null);
        return;
      }
    }
  };

  /** 工具栏：对选区包裹或在光标处插入 */
  const surround = (before: string, after = before, placeholder = "文本") => {
    const ta = taRef.current;
    if (!ta || !note) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e) || placeholder;
    const next = value.slice(0, s) + before + sel + after + value.slice(e);
    setBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + before.length, s + before.length + sel.length);
    });
  };

  /* 标题重命名：逐键校验撞名会把中间前缀卡死（已有《机器学习》时打不出《机器学习基础》）。
     草稿绑定笔记 id（切笔记自动失效，无需 effect 重置）：唯一即实时落库，
     撞名只在 blur/回车提交时报错回退 */
  const [titleDraft, setTitleDraft] = useState<{ id: string; text: string } | null>(null);
  const titleTaken = (t: string) =>
    knowledge.some((k) => k.id !== note?.id && normTitle(k.title) === normTitle(t));

  /* 行内删除（树行/搜索平铺行）与头部删除共用一份「确认→删除→收尾」：
   * 此前文件夹树与根列表是两份逐字拷贝，改行为要同步多处。 */
  const deleteNoteById = (k: KnowledgeItem) => {
    if (!confirm(`删除《${k.title}》？此操作不可撤销。`)) return;
    removeKnowledge(k.id);
    if (openId === k.id) onOpenNote(null);
    toast.success("已删除");
  };

  const deleteNote = () => {
    if (!note) return;
    deleteNoteById(note);
  };

  const addTag = () => {
    const t = newTag.trim().replace(/^#/, "");
    if (!note || !t) return;
    const merged = [...new Set([...(note.tags ?? []), t])];
    updateKnowledge(note.id, { tags: merged });
    setNewTag("");
  };

  const removeTag = (t: string) => {
    if (!note) return;
    updateKnowledge(note.id, { tags: (note.tags ?? []).filter((x) => x !== t) });
  };

  /* AI 建联（沿 brain 页原有 AUTOLINK 能力）：为当前笔记找有思想联系的笔记 */
  const [linking, setLinking] = useState(false);
  /* 建联建议绑定生成它的那篇笔记（切笔记自动失效，无需 effect 重置）：
     否则「＋连接」会把上一篇的建议错连到当前笔记 */
  const [suggests, setSuggests] = useState<{
    forNote: string;
    links: { targetId: string; reason: string }[];
  } | null>(null);

  const autoLink = async () => {
    if (!note) return;
    if (knowledge.length < 2) {
      toast.error("笔记太少，先攒几篇再来连线");
      return;
    }
    setLinking(true);
    setSuggests(null);
    try {
      const { streamChat } = await import("@/lib/ai/client");
      const { extractJson, autolinkSchema } = await import("@/lib/ai/client");
      const candidates = knowledge
        .filter((k) => k.id !== note.id)
        .slice(0, 40)
        .map((k) => `(${k.id}) ${k.title}：${k.body.replace(/\[\[|\]\]/g, "").slice(0, 60)}`)
        .join("\n");
      const full = await streamChat({
        task: "autolink",
        args: {
          note: `${note.title}\n${note.body.slice(0, 300)}`,
          candidates,
        },
        messages: [{ role: "user", content: "建立联系。" }],
        temperature: 0.3,
        signal: AbortSignal.timeout(45_000),
        onDelta: () => {},
      });
      const parsed = autolinkSchema.parse(extractJson(full));
      if (parsed.links.length === 0) toast("暂时没有真正有联系的笔记——宁缺毋滥。");
      else setSuggests({ forNote: note.id, links: parsed.links });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "建联失败");
    } finally {
      setLinking(false);
    }
  };

  const h = {
    note,
    liveBody: bodyDraft ?? note?.body ?? "",
    setBody,
    onTaChange,
    onCaretMove: detectSuggest,
    taRef,
    surround,
    autoLink,
    linking,
  };

  /* ---- 渲染 ---- */

  /* 嵌套文件夹树：domain 可含 "/"（如 WorkBuddy/学习/agent项目） */
  interface TreeDir {
    name: string;
    path: string;
    dirs: Map<string, TreeDir>;
    notes: KnowledgeItem[];
  }
  const dirTree = useMemo(() => {
    const root: TreeDir = { name: "", path: "", dirs: new Map(), notes: [] };
    const ensure = (path: string): TreeDir => {
      if (!path) return root;
      let cur = root;
      for (const seg of path.split("/")) {
        if (!cur.dirs.has(seg)) {
          cur.dirs.set(seg, {
            name: seg,
            path: cur.path ? cur.path + "/" + seg : seg,
            dirs: new Map(),
            notes: [],
          });
        }
        cur = cur.dirs.get(seg)!;
      }
      return cur;
    };
    // Search results are immediately visible even when their folders are collapsed.
    if (query.trim() || activeTag) {
      root.notes = filtered;
      return root;
    }
    for (const folder of folders) ensure(folder);
    for (const k of filtered) ensure(k.domain).notes.push(k);
    return root;
  }, [folders, filtered, query, activeTag]);

  const countNotes = (dir: TreeDir): number => {
    let n = dir.notes.length;
    for (const child of dir.dirs.values()) n += countNotes(child);
    return n;
  };

  const moveNote = (noteId: string, domain: string) => {
    updateKnowledge(noteId, { domain });
    toast.success("已移动到「" + domain + "」");
  };

  const renderDir = (dir: TreeDir, depth: number): React.ReactNode => {
    const isOpen = expanded.has(dir.path) || depth === 0;
    const subCount = countNotes(dir);
    const rows: React.ReactNode[] = [];
    if (depth > 0) {
      rows.push(
        <div
          key={"dir-" + dir.path}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverPath(dir.path);
          }}
          onDragLeave={() => setDragOverPath((v) => (v === dir.path ? null : v))}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/mentora-note");
            if (id) moveNote(id, dir.path);
            setDragOverPath(null);
          }}
          className={cn(
            "group relative flex items-center gap-1 rounded-lg px-1.5 py-1.5 transition",
            dragOverPath === dir.path
              ? "bg-accent/[0.14] ring-1 ring-accent/40"
              : isOpen
                ? "bg-black/[0.03]"
                : "hover:bg-black/[0.03]"
          )}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <button
            onClick={() =>
              setExpanded((s) => {
                const next = new Set(s);
                if (next.has(dir.path)) next.delete(dir.path);
                else next.add(dir.path);
                return next;
              })
            }
            className="flex min-w-0 flex-1 items-center gap-1 text-left cursor-pointer"
          >
            <ChevronRight className={cn("size-3.5 shrink-0 text-ink-dim transition", isOpen && "rotate-90")} />
            <span className="truncate text-[12.5px] font-medium text-ink">{dir.name}</span>
            <span className="tabular shrink-0 text-[10px] text-ink-dim/60">{subCount}</span>
          </button>
          <button
            title="文件夹操作"
            aria-label="文件夹操作"
            aria-haspopup="menu"
            aria-expanded={menuFor === dir.path}
            onClick={(e) => {
              e.stopPropagation();
              setMenuFor(menuFor === dir.path ? null : dir.path);
            }}
            /* 常显不 hover-only：display:none 让按钮不进 Tab 焦点序，触屏也没有可靠
             * hover——键盘/触屏用户此前完全无法触达「新建笔记到文件夹 / 删除文件夹」 */
            className="shrink-0 rounded p-0.5 text-ink-dim/50 transition hover:text-ink cursor-pointer"
          >
            <MoreVertical className="size-3.5" />
          </button>
          {menuFor === dir.path && (
            <div
              className="absolute z-20 w-36 overflow-hidden rounded-lg border border-border bg-white py-1 shadow-lg"
              style={{ top: "100%", left: 6 + depth * 12 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  createNote(dir.path);
                  setMenuFor(null);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-black/[0.04] cursor-pointer"
              >
                <Plus className="size-3.5" /> 新建笔记
              </button>
              {openId && (
                <button
                  title="把正在编辑的笔记移动到这个文件夹（触屏/键盘的替代移动路径）"
                  onClick={() => {
                    const cur = knowledge.find((k) => k.id === openId);
                    if (!cur) return;
                    if (cur.domain === dir.path) toast("当前笔记已在这个文件夹");
                    else moveNote(openId, dir.path);
                    setMenuFor(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink hover:bg-black/[0.04] cursor-pointer"
                >
                  <ArrowDownUp className="size-3.5" /> 移入当前笔记
                </button>
              )}
              <button
                onClick={() => {
                  /* 筛选态下 dir.notes 只含命中搜索/标签的笔记（dirTree 只由 filtered 构建），
                   * 而操作语义是「删除整个文件夹及其中的笔记」。必须按 domain 前缀从全库取
                   * 待删笔记（含子文件夹），否则未命中的笔记会残留：removeFolder 移除文件夹后，
                   * dirTree 下次 ensure(k.domain) 又把同名文件夹连同残留笔记重建出来——文件夹
                   * 删完复活，与确认框承诺的语义不符。无筛选时该集合与整棵树等价。 */
                  const inFolder = knowledge.filter(
                    (k) => k.domain === dir.path || k.domain.startsWith(dir.path + "/")
                  );
                  const msg = inFolder.length > 0
                    ? `删除文件夹「${dir.name}」及其中的 ${inFolder.length} 篇笔记？此操作不可撤销。`
                    : `删除空文件夹「${dir.name}」？`;
                  if (!confirm(msg)) return;
                  // 先删光里面的笔记（含子文件夹），再移除文件夹本身
                  // 批量一次落库：逐篇 removeKnowledge 每篇都是一次全库 filter/map 重算
                  // + 全仓 persist 同步序列化写盘，几百篇的文件夹会冻结主线程数秒
                  removeKnowledgeMany(inFolder.map((k) => k.id));
                  removeFolder(dir.path);
                  setExpanded((s) => {
                    const next = new Set(s);
                    next.delete(dir.path);
                    return next;
                  });
                  setMenuFor(null);
                  if (openId && inFolder.some((k) => k.id === openId)) onOpenNote(null);
                  toast.success("已删除文件夹");
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-bad hover:bg-bad/[0.06] cursor-pointer"
              >
                <Trash2 className="size-3.5" /> 删除文件夹
              </button>
            </div>
          )}
        </div>
      );
    }
    if (isOpen) {
      for (const child of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
        rows.push(renderDir(child, depth + 1));
      }
      for (const k of [...dir.notes].sort((a, b) => a.title.localeCompare(b.title, "zh"))) {
        const active = k.id === openId;
        rows.push(
          <div
            key={k.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/mentora-note", k.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            className={cn(
              "group relative flex w-full items-start rounded-lg transition",
              active ? "bg-accent/[0.09]" : "hover:bg-black/[0.035]"
            )}
            style={{ marginLeft: depth > 0 ? 12 : 0 }}
          >
            <button
              onClick={() => openLinkedNote(k.id)}
              className="min-w-0 flex-1 cursor-grab px-2 py-1.5 text-left active:cursor-grabbing"
            >
              <p className={cn("truncate text-[12.5px]", active ? "font-semibold text-accent" : "text-ink")}>
                {k.title}
              </p>
              <p className="mt-0.5 truncate text-[10.5px] text-ink-dim/70">
                {rowSummary(k)}
              </p>
            </button>
            <button
              title="删除这篇笔记"
              aria-label="删除这篇笔记"
              onClick={(e) => {
                e.stopPropagation();
                deleteNoteById(k);
              }}
              /* 常显不 hover-only：display:none 不进 Tab 焦点序且触屏无 hover（见文件夹 ⋮ 按钮） */
              className="mr-1 mt-1.5 shrink-0 rounded p-1 text-ink-dim/40 transition hover:text-bad cursor-pointer"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        );
      }
      if (depth > 0 && dir.notes.length === 0 && dir.dirs.size === 0) {
        rows.push(
          <p
            key={"empty-" + dir.path}
            className="pb-1.5 text-[11px] text-ink-dim/60"
            style={{ paddingLeft: 12 + depth * 12 }}
          >
            空文件夹——把笔记拖进来
          </p>
        );
      }
    }
    return rows;
  };

  const leftPane = (
    <div className="flex h-full flex-col">
      {/* 搜索 */}
      <div className="relative mb-1.5">
        <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-dim" />
        <input
          className="w-full rounded-lg border border-border bg-white py-2 pl-8 pr-2 text-sm outline-none transition focus:border-accent/50"
          placeholder="搜索标题或正文…"
          aria-label="搜索笔记（标题或正文）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* 标签筛选（默认收起：导入大库时标签会堆成一片，展开才显示） */}
      {allTags.length > 0 && (
        <div className="mb-1.5">
          <button
            onClick={() => setShowTags((v) => !v)}
            className="flex w-full items-center gap-1 text-left text-[11.5px] font-semibold uppercase tracking-[0.12em] text-ink-dim/70 hover:text-ink cursor-pointer"
          >
            <ChevronRight className={cn("size-3 transition", showTags && "rotate-90")} />
            标签筛选 · {allTags.length}
          </button>
          {showTags && (
            <div className="mt-1 flex flex-wrap gap-1">
              {allTags.map(([t, n]) => (
                <button
                  key={t}
                  onClick={() => setActiveTag(activeTag === t ? null : t)}
                  className={cn(
                    "rounded-full border px-2 py-1 text-[11.5px] transition cursor-pointer",
                    activeTag === t
                      ? "border-accent/40 bg-accent/[0.1] font-semibold text-accent"
                      : "border-border bg-white text-ink-dim hover:text-ink"
                  )}
                >
                  #{t} <span className="tabular opacity-60">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 文件夹树（拖笔记到文件夹上即可移动） */}
      <div className="mb-1 flex items-center justify-between px-0.5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-dim/70">
          文件夹 · 可拖拽整理
        </p>
        <div className="flex items-center gap-0.5">
          <input
            ref={docInputRef}
            type="file"
            accept=".docx,.md,.markdown,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadDoc(f);
              e.target.value = "";
            }}
          />
          <button
            title={docBusy ? "正在转换文档…" : "上传文档（.docx / .md / .txt → 笔记；旧 .doc/.wps 请先另存为 .docx）"}
            aria-label={docBusy ? "正在转换文档" : "上传文档"}
            disabled={docBusy}
            onClick={() => docInputRef.current?.click()}
            className={cn(
              "rounded-md p-1 transition cursor-pointer",
              /* 转换等待期要看得见进行中：spinner 全亮（disabled:opacity-40 会把它调暗成
               * 看不出的静默），.docx 转换数秒级，此前只有 disabled 变灰 + title 提示，
               * Firefox 不给 disabled 按钮派发鼠标事件、移动端无 tooltip，用户以为没反应 */
              docBusy ? "text-accent" : "text-ink-dim/70 hover:text-ink disabled:opacity-40"
            )}
          >
            {docBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          </button>
          <button
            title="新建文件夹"
            aria-label="新建文件夹"
            onClick={() => setNewFolder(" ")}
            className="rounded-md p-1 text-ink-dim/70 transition hover:text-ink cursor-pointer"
          >
            <FolderPlus className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="-mr-1 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {newFolder !== null && (
          <div className="mb-0.5 flex items-center gap-1.5 rounded-lg bg-accent/[0.06] px-2 py-1.5">
            <FolderPlus className="size-3.5 shrink-0 text-accent" />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none"
              placeholder="文件夹名（可用 / 建子夹），回车创建"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newFolder.trim()) {
                  addFolder(newFolder.trim());
                  expandPath(newFolder.trim());
                  setNewFolder(null);
                }
                if (e.key === "Escape") setNewFolder(null);
              }}
              onBlur={() => {
                if (newFolder && newFolder.trim()) {
                  addFolder(newFolder.trim());
                  expandPath(newFolder.trim());
                }
                setNewFolder(null);
              }}
            />
          </div>
        )}
        {[...dirTree.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, "zh")).map((child) =>
          renderDir(child, 1)
        )}
        {dirTree.notes.map((k) => (
          <div
            key={k.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/mentora-note", k.id)}
            className={cn(
              "group relative flex w-full items-start rounded-lg transition",
              k.id === openId ? "bg-accent/[0.09]" : "hover:bg-black/[0.035]"
            )}
          >
            <button
              onClick={() => openLinkedNote(k.id)}
              className="min-w-0 flex-1 cursor-grab px-2 py-1.5 text-left active:cursor-grabbing"
            >
              <p className={cn("truncate text-[12.5px]", k.id === openId ? "font-semibold text-accent" : "text-ink")}>
                <Highlight text={k.title} q={query.trim().toLowerCase()} />
              </p>
              {/* Obsidian 式：标题未命中但正文命中时,给出命中上下文片段 */}
              {query.trim() &&
                !k.title.toLowerCase().includes(query.trim().toLowerCase()) &&
                (() => {
                  const sn = snippetFor(k, query.trim().toLowerCase());
                  if (!sn) return null;
                  return (
                    <p className="truncate text-[11px] leading-relaxed text-ink-dim">
                      <Highlight text={sn} q={query.trim().toLowerCase()} />
                    </p>
                  );
                })()}
            </button>
            <button
              title="删除这篇笔记"
              aria-label="删除这篇笔记"
              onClick={(e) => {
                e.stopPropagation();
                deleteNoteById(k);
              }}
              className="mr-1 mt-1 shrink-0 rounded p-1 text-ink-dim/40 transition hover:text-bad cursor-pointer"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}
        {/* 搜索/标签筛选无命中时给空态（此前列表永远铺满，「0 篇可见」自相矛盾） */}
        {filtered.length === 0 && (query.trim() || activeTag) && (
          <div className="px-2 py-6 text-center">
            <p className="text-sm text-ink-dim">没有匹配的笔记</p>
            <p className="mt-1 text-xs text-ink-dim/60">
              {query.trim() ? `关键词「${query.trim()}」` : ""}
              {query.trim() && activeTag ? " + " : ""}
              {activeTag ? `标签 #${activeTag}` : ""}
            </p>
            <button
              type="button"
              onClick={() => { setQuery(""); setActiveTag(null); }}
              className="mt-3 cursor-pointer rounded-lg border border-border bg-white px-3 py-1.5 text-xs text-ink-dim transition hover:text-ink"
            >
              清除筛选
            </button>
          </div>
        )}
        {filtered.length === 0 && !query.trim() && !activeTag && (
          <div className="px-2 py-6 text-center">
            <p className="text-sm text-ink-dim/60">还没有笔记——点「新建笔记」开始记。</p>
            {/* 与左缘 ribbon（@min-[900px]:flex）同一参照系的断点：容器 <900px 时 ribbon
                隐藏、中栏 Empty 在移动端也看不到，这个按钮是唯一创建入口。此前用视口
                断点 md:hidden，在「视口 ≥768px 且容器 <900px」的窗口带（展开侧栏约
                768–1190px）与 ribbon 同时隐藏，列表 Tab 内没有任何创建入口。 */}
            <button
              type="button"
              onClick={() => createNote()}
              className="mt-3 cursor-pointer rounded-lg border border-border bg-white px-3 py-1.5 text-xs text-accent transition hover:bg-accent/[0.06] @min-[900px]:hidden"
            >
              新建笔记
            </button>
          </div>
        )}
      </div>
      <p className="pt-1.5 text-[10px] text-ink-dim/60">
        {knowledge.length} 篇 · {filtered.length} 篇可见 · 拖动笔记到文件夹即可移动（触屏/键盘可用文件夹 ⋮ 菜单）
      </p>
    </div>
  );


  const rightPane = (
    <div className="flex h-full flex-col">
      {/* E3：来源常显（辅助信息，不抢正文）——学习/阅读/圆桌产出的笔记要能看见出处；
       *  来源对象已删除时如实提示，不留空白也不误跳。 */}
      {note && (
        <div className="mb-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim/70">来源</p>
          <p className="mt-1 break-words text-[12px] text-ink-dim">
            {SOURCE_LABELS[note.source] ?? note.source}
            {note.sourceTitle ? ` · ${note.sourceTitle}` : ""}
          </p>
          {note.source !== "manual" && note.source !== "obsidian" && note.sourceTitle && (() => {
            /* 来源对象是否还在：学习目标按主题、书按书名、会话按标题。
             * 数据来自组件顶部的 selector 订阅（srcGoals/srcBooks/srcSessions），
             * 删除来源对象会触发重渲染，告警即时出现/消失，不再依赖无关变化。 */
            const exists =
              note.source === "learn" ? srcGoals.some((g) => note.sourceTitle.includes(g.topic)) :
              note.source === "read" ? srcBooks.some((b) => note.sourceTitle.includes(b.title)) :
              note.source === "council" ? srcSessions.some((x) => note.sourceTitle.includes(x.title)) :
              true;
            return exists ? null : (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-warn">
                <span aria-hidden>⚠</span>
                <span>来源对象已不存在（可能已删除）；笔记本身与正文不受影响。</span>
              </p>
            );
          })()}
        </div>
      )}
      <div className="mb-2 flex gap-1 border-b border-border pb-1.5">
        {(
          [
            ["backlinks", "反链"],
            ["outgoing", "出链"],
            ["outline", "大纲"],
            ["tags", "标签"],
          ] as [RightTab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => setRightTab(t)}
            /* 与同页移动端三栏切换（aria-pressed）、brain 页顶部 tab（brain/page.tsx
               aria-pressed）同一语义：读屏用户能得知当前停在哪个 tab */
            aria-pressed={rightTab === t}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] font-medium transition cursor-pointer",
              rightTab === t ? "bg-ink/[0.06] font-semibold text-ink" : "text-ink-dim hover:text-ink"
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="-mr-1 flex-1 overflow-y-auto pr-1 text-[12.5px]">
        {!note && <p className="py-6 text-center text-ink-dim/70">先选一篇笔记</p>}
        {note && rightTab === "backlinks" && (
          <div className="space-y-1.5">
            {backlinks.length === 0 && unlinkedMentions.length === 0 && (
              <p className="py-4 text-center text-ink-dim/70">还没有笔记链到这里</p>
            )}
            {backlinks.map((k) => (
              <button
                key={k.id}
                onClick={() => onOpenNote(k.id)}
                className="block w-full rounded-lg border border-border bg-white px-2.5 py-1.5 text-left transition hover:border-accent/40 cursor-pointer"
              >
                <span className="font-medium text-ink">{k.title}</span>
                <span className="mt-0.5 block truncate text-[10.5px] text-ink-dim/70">
                  {k.body.replace(/\[\[([^\[\]]+)\]\]/g, "$1").slice(0, 50)}
                </span>
              </button>
            ))}
            {unlinkedMentions.length > 0 && (
              <>
                <p className="pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim/70">
                  未链接提及
                </p>
                {unlinkedMentions.map((k) => (
                  <button
                    key={k.id}
                    onClick={() => onOpenNote(k.id)}
                    className="block w-full rounded-lg px-2.5 py-1.5 text-left text-ink-dim transition hover:bg-black/[0.03] cursor-pointer"
                  >
                    {k.title}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {note && rightTab === "outgoing" && (
          <div className="space-y-1.5">
            {outgoing.length === 0 && <p className="py-4 text-center text-ink-dim/70">这篇还没有出链</p>}
            {outgoing.map((k) => (
              <button
                key={k.id}
                onClick={() => onOpenNote(k.id)}
                className="block w-full rounded-lg border border-border bg-white px-2.5 py-1.5 text-left font-medium text-ink transition hover:border-accent/40 cursor-pointer"
              >
                {k.title}
              </button>
            ))}
          </div>
        )}
        {note && rightTab === "outline" && (
          <div className="space-y-0.5">
            {outline.length === 0 ? (
              <p className="py-4 text-center text-ink-dim/70">正文里写几个标题（## 二级）就会有大纲</p>
            ) : (
              outline.map((h, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => openLinkedNote(note.id,h.text)}
                  className={cn(
                    "block min-h-9 w-full cursor-pointer truncate rounded px-1.5 py-1.5 text-left text-ink hover:bg-surface-2",
                    h.level === 1 && "font-semibold",
                    h.level === 2 && "pl-4",
                    h.level === 3 && "pl-7 text-ink-dim"
                  )}
                >
                  {h.text}
                </button>
              ))
            )}
          </div>
        )}
        {note && rightTab === "tags" && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {noteTags.length === 0 && <p className="py-2 text-ink-dim/70">还没有标签，正文里写 #标签 或在下面添加</p>}
              {noteTags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-white px-2 py-0.5 text-[11px] text-ink"
                >
                  #{t}
                  {(note.tags ?? []).includes(t) && (
                    <button onClick={() => removeTag(t)} aria-label={`删除标签 ${t}`} className="text-ink-dim/60 hover:text-bad cursor-pointer">
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {tagEdit ? (
              <div className="flex gap-1">
                <input
                  autoFocus
                  className="w-full rounded-lg border border-border bg-white px-2 py-1 text-[12px] outline-none focus:border-accent/50"
                  placeholder="标签名，回车添加"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addTag();
                    if (e.key === "Escape") setTagEdit(false);
                  }}
                />
                <Button size="sm" onClick={addTag}>
                  加
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setTagEdit(true)}
                className="flex items-center gap-1 text-[11.5px] text-accent hover:underline cursor-pointer"
              >
                <Tag className="size-3" /> 添加标签
              </button>
            )}
            <p className="text-[10.5px] leading-relaxed text-ink-dim/60">
              标签可筛选左侧列表；正文里的 #标签 也会被自动识别。
            </p>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="@container" ref={workspaceRef}>
      {recentIds.length > 0 && <div className="note-tab-strip" aria-label="已打开的笔记">
        {recentIds.map(id => knowledge.find(k => k.id === id)).filter((k): k is KnowledgeItem => !!k).map(k => <div key={k.id} className={cn("note-tab",k.id === openId && "note-tab-active")}>
          <button type="button" onClick={() => openLinkedNote(k.id)} aria-current={k.id === openId ? "page" : undefined} title={k.title} className="min-w-0 flex-1 truncate text-left">{k.title}</button>
          <button type="button" aria-label={`关闭笔记标签 ${k.title}`} className="grid size-7 shrink-0 place-items-center rounded hover:bg-black/5" onClick={() => { const remaining=recentIds.filter(id=>id!==k.id);setRecentIds(remaining);if(openId===k.id)onOpenNote(remaining.filter(id=>knowledge.some(n=>n.id===id)).at(-1)??null); }}><X className="size-3" /></button>
        </div>)}
      </div>}
      {/* 按工作区实际宽度切换三栏，避免侧栏挤掉编辑器。 */}
      {/* 工作台：左缘 ribbon + 文件夹树 + 编辑器 + 功能面板（可收起） */}
      {/* 移动端单栏切换 Tab（桌面隐藏）；命中盒 ≥44px（M3-1） */}
      <div className="mb-2 flex gap-1 @min-[900px]:hidden">
        {(
          [
            ["list", "列表"],
            ["editor", "笔记"],
            ["info", "信息"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMobilePane(key)}
            aria-pressed={mobilePane === key}
            className={cn(
              "min-h-[44px] flex-1 rounded-lg py-2 text-[12.5px] transition cursor-pointer",
              mobilePane === key ? "bg-ink/[0.07] font-semibold text-ink" : "text-ink-dim hover:bg-black/[0.04]"
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className={cn(
          /* 高度几何（PRD §7.1）：手机 = dvh - 顶栏(52+safeTop) - 底栏reserve(60+safeBottom) - 移动Tab行 - 页头/页边；
           * 键盘弹出时 --keyboard-inset 由 JS 写入自动收缩。桌面保持原式。 */
          "flex h-[calc(100dvh-var(--safe-top)-var(--safe-bottom)-var(--keyboard-inset)-390px)] min-h-[360px] overflow-hidden rounded-2xl border border-border bg-white",
          "md:h-[calc(100vh-150px)] md:min-h-[500px]"
        )}
      >
        {/* 左缘 ribbon（Obsidian 式竖排图标） */}
        <div className="hidden h-full w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border py-3 @min-[900px]:flex">
          <button title="新建笔记" aria-label="新建笔记" onClick={() => createNote()} className="rounded-lg p-2 text-ink transition hover:bg-black/[0.05] cursor-pointer">
            <Plus className="size-4.5" />
          </button>
          {importSlot}
          <button title="开始复习" aria-label="开始复习" onClick={onReview} disabled={dueCount === 0} className="rounded-lg p-2 text-ink transition hover:bg-black/[0.05] disabled:opacity-30 cursor-pointer">
            <RefreshCcw className="size-4.5" />
          </button>
          <button title="关系图谱" aria-label="关系图谱" onClick={onGraph} className="rounded-lg p-2 text-ink transition hover:bg-black/[0.05] cursor-pointer">
            <Zap className="size-4.5" />
          </button>
          <div className="mt-auto flex flex-col items-center gap-1">
            <button
              title={rightOpen ? "收起功能面板" : "展开功能面板"}
              aria-label={rightOpen ? "收起功能面板" : "展开功能面板"}
              onClick={() => setRightOpen((v) => !v)}
              className={cn(
                "rounded-lg p-2 transition cursor-pointer",
                rightOpen ? "bg-accent/[0.1] text-accent" : "text-ink-dim hover:bg-black/[0.05] hover:text-ink"
              )}
            >
              <PanelRight className="size-4.5" />
            </button>
          </div>
        </div>

        {/* 文件树（移动端=列表 Tab） */}
        <div
          className={cn(
            "h-full w-full shrink-0 overflow-hidden border-r border-border p-2.5 @min-[900px]:w-60",
            mobilePane === "list" ? "block" : "hidden @min-[900px]:block"
          )}
        >
          {leftPane}
        </div>

        {/* 中栏：编辑器 / 预览（移动端=笔记 Tab） */}
        <div className={cn("h-full min-w-0 flex-1 overflow-hidden", mobilePane === "editor" ? "block" : "hidden @min-[900px]:block")}>
          {!note ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Empty
                icon={<FileText className="size-7" />}
                title="选一篇笔记，或新建一篇"
                desc="双链 [[]]、#标签、反向链接、大纲——都在这套工作台里。Ctrl/Cmd+K 全局快速跳转。"
              />
              <Button size="sm" onClick={() => createNote()}>
                <Plus className="size-4" /> 新笔记
              </Button>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              {/* 标题行 + 模式切换 */}
              <div ref={headerRef} className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                <input
                  className="min-w-0 flex-1 basis-full bg-transparent text-[17px] font-bold tracking-[-0.01em] text-ink outline-none @min-[600px]:basis-auto"
                  value={titleDraft && titleDraft.id === note.id ? titleDraft.text : note.title}
                  spellCheck={false}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTitleDraft({ id: note.id, text: v });
                  }}
                  onBlur={() => {
                    const t = titleDraft && titleDraft.id === note.id ? titleDraft.text.trim() : "";
                    setTitleDraft(null);
                    if (!t || t === note.title) return;
                    if (titleTaken(t)) toast.error("已有同名笔记");
                    else updateKnowledge(note.id, { title: t });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
                <div className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-white p-0.5">
                  <button
                    onClick={() => onModeChange("preview")}
                    className={cn(
                      "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] cursor-pointer",
                      mode === "preview" ? "bg-ink/[0.07] font-semibold text-ink" : "text-ink-dim"
                    )}
                  >
                    <Eye className="size-3.5" /> 阅读
                  </button>
                  <button
                    onClick={() => {
                      onModeChange("edit");
                      setSuggest(null);
                    }}
                    className={cn(
                      "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] cursor-pointer",
                      mode === "edit" ? "bg-ink/[0.07] font-semibold text-ink" : "text-ink-dim"
                    )}
                  >
                    <Pencil className="size-3.5" /> 编辑
                  </button>
                </div>
                <button
                  onClick={deleteNote}
                  title="删除这篇笔记"
                  aria-label="删除这篇笔记"
                  className="shrink-0 rounded-md p-1 text-ink-dim/50 transition hover:text-bad cursor-pointer"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>

              {/* 工具栏（编辑态）：手机可横向滚动，每个工具命中盒 ≥44px（M3-1/M5-2） */}
              {mode === "edit" && (
                <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-surface-2/60 px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:px-3 md:py-1.5">
                  {TOOLBAR.map((b) => {
                    /* live 模式没有源码光标（taRef 只挂源码分支），包裹/双链按钮无从下手——
                       隐藏而不是静默无操作 */
                    if (editStyle === "live" && b.id !== "autolink") return null;
                    return (
                      <button
                        key={b.title}
                        title={b.title}
                        aria-label={b.title}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => b.run(h)}
                        disabled={b.id === "autolink" && linking}
                        className="grid size-11 shrink-0 place-items-center rounded-md text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:size-8"
                      >
                        <b.icon className="size-4" />
                      </button>
                    );
                  })}
                  <button
                    disabled={!note}
                    title={note?.nextReviewAt ? "把这篇文章移出间隔复习队列" : "把这篇加入间隔复习队列（导入/手写笔记默认不进）"}
                    onClick={() => {
                      if (!note) return;
                      enableReview(note.id, !note.nextReviewAt);
                      toast.success(note.nextReviewAt ? "已移出复习队列" : "已加入复习队列");
                    }}
                    className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:h-8"
                  >
                    {note?.nextReviewAt ? "移出复习" : "加入复习"}
                  </button>
                  <button
                    disabled={!!aiBusy || !note}
                    title="AI 生成本篇要点摘要并追加到文末"
                    onClick={async () => {
                      if (!note) return;
                      const ctrl = new AbortController();
                      aiAbortRef.current = ctrl;
                      setAiBusy("summarize");
                      try {
                        const sum = await aiNote("summarize", note.body);
                        /* aiNote 最长等 45s（AbortSignal.timeout），期间编辑器并未锁死，
                           用户可以继续输入并经 onTaChange 落库。live 取此刻 store 里的最新
                           正文来追加摘要——用点击时的快照回写会把这段编辑整篇抹掉。
                           读 live 前先把源码模式在途的逐键草稿落库：setBody 会丢弃在途草稿，
                           若响应落在最后一次 keystroke 后 350ms 内，live 不含这段尾巴，
                           随后的 setBody(live+摘要) 会把草稿连同屏幕显示一起清掉（丢字回退）。 */
                        flushBodyDraft();
                        const live =
                          useAppStore.getState().knowledge.find((k) => k.id === note.id)?.body ?? note.body;
                        setBody(live + "\n\n## 摘要\n" + sum);
                        toast.success("已追加 AI 摘要");
                      } catch {
                        if (ctrl.signal.aborted) toast("已取消 AI 总结");
                        else toast.error("AI 总结失败，稍后再试");
                      } finally {
                        setAiBusy(null);
                      }
                    }}
                    className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:h-8"
                  >
                    <Sparkles className="mr-0.5 inline size-3" /> {aiBusy === "summarize" ? "总结中…" : "AI 总结"}
                  </button>
                  <button
                    disabled={!!aiBusy || !note}
                    title="AI 润色全文（在文末追加润色稿；原文保留，双链/标签不丢）"
                    onClick={async () => {
                      if (!note) return;
                      /* 文案与行为一致：实现是把润色稿追加在最新正文之后（整篇替换会
                         覆盖等待期的编辑），确认框如实说明「追加」，不再承诺「重写」 */
                      if (!confirm("用 AI 润色全文？将在文末追加一份润色稿（原文保持不变），不满意可整段删除。")) return;
                      const ctrl = new AbortController();
                      aiAbortRef.current = ctrl;
                      setAiBusy("rewrite");
                      try {
                        const rw = await aiNote("rewrite", note.body);
                        /* 同上：润色基于点击时快照，但落库必须合并等待期的编辑——
                           润色结果追加在最新正文之后（而非整篇替换），否则这段编辑静默丢失。
                           读 live 前先 flush 源码模式在途的逐键草稿（同 AI 总结，防丢尾巴）。 */
                        flushBodyDraft();
                        const live =
                          useAppStore.getState().knowledge.find((k) => k.id === note.id)?.body ?? note.body;
                        if (rw.trim()) setBody(live + "\n\n## 润色\n" + rw);
                        toast.success("已在文末追加 AI 润色稿");
                      } catch {
                        if (ctrl.signal.aborted) toast("已取消 AI 润色");
                        else toast.error("AI 润色失败，稍后再试");
                      } finally {
                        setAiBusy(null);
                      }
                    }}
                    className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:h-8"
                  >
                    {aiBusy === "rewrite" ? "润色中…" : "AI 润色"}
                  </button>
                  <button
                    disabled={!!aiBusy}
                    title="LLMWiki 编译：把孤立笔记织进双链网（建链/合并建议/冲突标记）"
                    onClick={async () => {
                      const ctrl = new AbortController();
                      aiAbortRef.current = ctrl;
                      setAiBusy("wiki");
                      try {
                        const { runWikiCompile } = await import("@/lib/wiki-compile");
                        const r = await runWikiCompile(3, ctrl.signal);
                        /* 用户主动取消：已处理完的篇目结果已落库（不回滚），只提示中断 */
                        if (ctrl.signal.aborted) {
                          toast("已取消 wiki 编译" + (r.linked ? `（已建 ${r.linked} 条链接）` : ""));
                          return;
                        }
                        if (r.linked || r.merges.length || r.conflicts.length) {
                          toast.success(
                            `wiki 编译：新建 ${r.linked} 条链接${r.merges.length ? `；建议合并 ${r.merges.length} 处` : ""}${r.conflicts.length ? `；标记冲突 ${r.conflicts.length} 处` : ""}`
                          );
                        } else if (r.failed > 0) {
                          /* runWikiCompile 对每条失败都在内部消化、从不抛出：全失败
                             （failed>0 且无任何结果）时不能落到下面那句「没有孤立笔记」
                             的假空态（wiki-compile.ts 明确要求区分「没活干」和「干不了」）。 */
                          toast.error(
                            `wiki 编译失败（${r.failed} 篇未完成）${r.lastError ? `：${r.lastError}` : ""}`
                          );
                        } else {
                          toast("没有孤立笔记需要编译，或暂无可建联系");
                        }
                      } catch {
                        toast.error("wiki 编译失败，稍后再试");
                      } finally {
                        setAiBusy(null);
                      }
                    }}
                    className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:h-8"
                  >
                    {aiBusy === "wiki" ? "整理中…" : "AI 整理"}
                  </button>
                  {aiBusy && (
                    /* AI 中断态：等待期用户可主动取消，不必干等 45s 自动超时
                       （ctrl.signal.aborted 让各 catch 区分「取消」与「失败」文案） */
                    <button
                      type="button"
                      title="取消正在进行的 AI 操作"
                      onClick={() => aiAbortRef.current?.abort()}
                      className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer md:h-8"
                    >
                      取消
                    </button>
                  )}
                  <button
                    onClick={() => setEditStyle((s) => (s === "live" ? "raw" : "live"))}
                    title={editStyle === "live" ? "切到源码模式（整篇 MD）" : "切回实时预览（点哪段改哪段）"}
                    className="ml-auto grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer md:h-8"
                  >
                    {editStyle === "live" ? "源码" : "实时预览"}
                  </button>
                  <span className="hidden shrink-0 items-center gap-1 pr-1 text-[10px] text-ink-dim/50 md:flex">
                    <ArrowDownUp className="size-3" /> 改动即存
                  </span>
                </div>
              )}

              {/* AI 建联建议（只显示给生成它的那篇笔记） */}
              {mode === "edit" && note && suggests && suggests.forNote === note.id && suggests.links.length > 0 && (
                <div className="border-b border-accent/20 bg-accent/[0.04] px-4 py-2">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-accent">AI 觉得这些笔记和本篇有联系</p>
                    <button onClick={() => setSuggests(null)} aria-label="关闭建议面板" className="text-ink-dim/60 hover:text-ink cursor-pointer">
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {suggests.links.map((s) => {
                      const target = knowledge.find((k) => k.id === s.targetId);
                      if (!target || !note) return null;
                      const already = note.links.includes(s.targetId);
                      return (
                        <div key={s.targetId} className="flex items-center gap-2 text-[12.5px]">
                          <button
                            onMouseDown={(e) => e.preventDefault()}
                            disabled={already}
                            onClick={() => {
                              linkNotes(note.id, s.targetId);
                              setSuggests((p) =>
                                p ? { ...p, links: p.links.filter((x) => x.targetId !== s.targetId) } : null
                              );
                            }}
                            className={cn(
                              "rounded-md border px-1.5 py-0.5 text-[11px] cursor-pointer",
                              already
                                ? "border-border text-ink-dim/50"
                                : "border-accent/40 bg-white text-accent hover:bg-accent/[0.08]"
                            )}
                          >
                            {already ? "已链接" : "＋ 连接"}
                          </button>
                          <span className="font-medium text-ink">{target.title}</span>
                          <span className="truncate text-[11px] text-ink-dim">{s.reason}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <nav aria-label="当前笔记关系链" className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-2/45 px-3 py-1.5">
                <span className="shrink-0 text-xs font-medium text-ink-dim">关系链</span>
                <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain py-0.5">
                  {relatedNotes.length === 0 && <span className="text-xs text-ink-dim">暂无关联笔记</span>}
                  {relatedNotes.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      title={item.title}
                      onClick={() => onOpenNote(item.id)}
                      className="max-w-48 shrink-0 cursor-pointer truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink hover:border-accent/40 hover:text-accent"
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
                <button type="button" onClick={onGraph} className="shrink-0 cursor-pointer rounded-md px-1 py-1 text-xs font-medium text-accent hover:underline">看图谱</button>
              </nav>

              {/* 正文：编辑时自动保存，阅读模式由用户显式切换。 */}
              <div className="relative flex-1 overflow-hidden">
                {mode === "edit" ? (
                  <div className="relative h-full overflow-y-auto">
                    {editStyle === "live" ? (
                      /* key 绑定笔记 id：切笔记时强制重挂载，丢弃上一篇的 text/active/pendingRef。
                         否则同一 JSX 位置复用实例，切到空笔记（blocks=[]）走整篇 textarea 分支，
                         value={text} 会把上一篇残留草稿预填进新笔记，继续输入+失焦就把
                         「残留文本+新键入」整体写成新笔记正文。卸载清理仍按旧 onCommit
                         闭包把未提交草稿写回上一篇（commitRef 保存的是上一帧回调）。 */
                      <LiveBlocks
                        key={note.id}
                        body={note.body}
                        notes={knowledge}
                        onCommit={(b) => {
                          setBody(b);
                          setSuggest(null);
                        }}
                        onOpen={openLinkedNote}
                        onCreate={onCreateWiki}
                        onRewrite={rewriteNoteBlock}
                      />
                    ) : (
                    <textarea
                      ref={taRef}
                      className="min-h-full w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-relaxed text-ink outline-none"
                      /* 显示本地草稿（打字零延迟落屏），落库由 onTaChange 节流 + 失焦/切走 flush */
                      value={bodyDraft ?? note.body}
                      spellCheck={false}
                      placeholder="像聊天一样写就行——内容自动保存。输入 [[ 链接其他笔记，点「阅读」查看排版…"
                      onChange={(e) => onTaChange(e.target.value, e.target.selectionStart ?? 0)}
                      /* 点击只重算 [[ 候选（光标位置变了），不触发一次多余的落库 */
                      onClick={(e) => detectSuggest(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                      onKeyDown={onTaKeyDown}
                      onBlur={(e) => {
                        /* 先把在途草稿落库（下面可能提前 return 留在编辑态，也不能丢字） */
                        flushBodyDraft();
                        /* [[ 补全未关闭时先留在编辑态，避免误跳预览 */
                        if (suggest) {
                          setSuggest(null);
                          return;
                        }
                        /* 焦点移到标题栏/模式切换（页头）时留在编辑态 */
                        const next = e.relatedTarget as Node | null;
                        if (next && headerRef.current?.contains(next)) return;
                        // Keep the chosen editing mode on blur; saving must not change views.
                      }}
                    />
                    )}
                    {/* [[ 补全下拉 */}
                    {suggest && (
                      <div className="absolute left-4 right-4 top-16 z-10 overflow-hidden rounded-xl border border-border bg-white shadow-lg">
                        <p className="border-b border-border bg-surface-2 px-3 py-1 text-[10px] text-ink-dim">
                          ↑↓ 选择 · Enter 插入 · Esc 关闭
                        </p>
                        {suggestCandidates.map((k, i) => (
                          <button
                            key={k.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => applySuggest(k.title)}
                            className={cn(
                              "block w-full px-3 py-1.5 text-left text-[13px] cursor-pointer",
                              i === suggestIdx ? "bg-accent/[0.09] text-accent" : "text-ink hover:bg-black/[0.03]"
                            )}
                          >
                            {k.title}
                            <span className="ml-2 text-[10px] text-ink-dim/60">{k.domain}</span>
                          </button>
                        ))}
                        <button
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={activateNewNoteSuggest}
                          className={cn(
                            "block w-full border-t border-border px-3 py-1.5 text-left text-[13px] cursor-pointer",
                            /* 无候选时它是唯一行恒为选中态（旧条件 suggestIdx===0 会被
                               候选缩到 0 前的 ↑↓ 残留 idx 破坏，行不显选中但 Enter 却激活） */
                            suggestCandidates.length === 0 ? "bg-accent/[0.09] text-accent" : "text-ink-dim hover:text-ink"
                          )}
                        >
                          ＋ 新建「{suggest.fragment.trim() || "…"}」并链接
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="note-reading-area h-full overflow-y-auto px-5 py-4">
                    {note.body.trim() ? (
                      <WikiMarkdown
                        body={note.body}
                        notes={knowledge}
                        onOpen={openLinkedNote}
                        onCreate={onCreateWiki}
                      />
                    ) : (
                      <p className="py-10 text-center text-sm text-ink-dim">
                        空笔记。切到「编辑」开始写，或用工具栏里的 [[双链]] 建立连接。
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 功能面板（移动端=信息 Tab；桌面由 rightOpen 控制） */}
        <div
          className={cn(
            "h-full w-full shrink-0 overflow-hidden border-l border-border p-2.5 @min-[900px]:w-64",
            mobilePane === "info" ? "block" : "hidden",
            rightOpen ? "@min-[900px]:block" : "@min-[900px]:hidden"
          )}
        >
          {rightPane}
        </div>
      </div>

    </div>
  );

  /* AI 建联建议面板见上方编辑区 */
}

/* （原 Ctrl+K 快速切换器已由全局命令面板 components/cmdk.tsx 接管——同键位更强功能，避免双 ⌘K 抢键） */
