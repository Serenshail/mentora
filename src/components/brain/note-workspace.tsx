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
import {
  ArrowDownUp, Bold, Braces, ChevronRight, Eye, FileText, FolderPlus, Heading2, Heading3,
  PanelRight,
  Link2, List, ListOrdered, Minus, MoreVertical, Pencil, Plus, Quote, RefreshCcw, Search, Sparkles, Tag,
  Trash2, Type, Upload, X, Zap,
} from "lucide-react";

type RightTab = "backlinks" | "outgoing" | "outline" | "tags";

/* ---- 小工具 ---- */

function normTitle(t: string) {
  return t.trim().toLowerCase();
}

/** 大纲：解析正文 1-3 级标题 */
function outlineOf(body: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (m && m[2].trim()) out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}

/** 行内 #标签（排除标题行）；配合 tags 字段一起展示 */
function inlineTags(body: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\s)#([^\s#`~!@#$%^&*()=+{\}[\]|\\:;"'<>,.?/，。！？：（）【】]{2,24})/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (/^#{1,6}\s/.test(m[0].trim())) continue; // 标题行不算
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

  const open = (i: number) => {
    setActive(i);
    setText(blocks[i] ?? "");
  };
  const commit = () => {
    if (active == null) return;
    const next = [...blocks];
    next[active] = text;
    onCommit(next.join("\n\n"));
    setActive(null);
  };

  return (
    <div className="min-h-full px-3 py-3">
      {blocks.length === 0 ? (
        <textarea
          autoFocus
          className="min-h-[40vh] w-full resize-none bg-transparent px-2 font-mono text-[13px] leading-relaxed text-ink outline-none"
          value={text}
          placeholder="像聊天一样写就行——点别处自动排版。输入 [[ 可链接其他笔记…"
          onChange={(e) => setText(e.target.value)}
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
                    onClick={async () => {
                      try {
                        setText(await onRewrite(text));
                      } catch {
                        /* 忽略单次失败 */
                      }
                    }}
                    className="rounded-md px-1.5 py-0.5 text-[10.5px] text-accent transition hover:bg-accent/[0.08] cursor-pointer"
                    title="AI 改写这一段（不改原意）"
                  >
                    ✨ AI 改写这段
                  </button>
                </div>
              )}
              <textarea
              autoFocus
              rows={Math.max(2, text.split("\n").length + 1)}
              className="my-1 w-full resize-none rounded-lg border border-accent/40 bg-white px-3 py-2 font-mono text-[13px] leading-relaxed text-ink outline-none"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Escape") commit();
              }}
              />
            </div>
          ) : (
            <div
              key={i}
              onClick={() => open(i)}
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
  setBody: (b: string) => void;
  onTaChange: (b: string, caret: number) => void;
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
      const body2 = h.note.body.slice(0, pos) + "[[" + h.note.body.slice(pos);
      h.setBody(body2);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(pos + 2, pos + 2);
        h.onTaChange(body2, pos + 2);
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
  const linkNotes = useAppStore((s) => s.linkNotes);
  const folders = useAppStore((s) => s.folders);
  const addFolder = useAppStore((s) => s.addFolder);
  const removeFolder = useAppStore((s) => s.removeFolder);

  const [query, setQuery] = useState("");
  /* 编辑态默认 Obsidian 式实时预览(块级),可切源码 */
  const [editStyle, setEditStyle] = useState<"live" | "raw">("live");
  /* 移动端单栏:列表/笔记/信息 三选一切换(桌面仍多栏并列) */
  const [mobilePane, setMobilePane] = useState<"list" | "editor" | "info">("list");
  const [aiBusy, setAiBusy] = useState(false);

  /* AI 帮改笔记:rewrite 润色 / summarize 总结 / continue 续写(服务端组装提示词) */
  const aiNote = async (mode: "rewrite" | "summarize" | "continue", text: string) => {
    const { streamChat } = await import("@/lib/ai/client");
    return streamChat({
      task: "note-assist",
      args: { mode, text },
      messages: [{ role: "user", content: "执行。" }],
      temperature: 0.3,
      onDelta: () => {},
    });
  };
  const [domain, setDomain] = useState("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("backlinks");
  const [tagEdit, setTagEdit] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [rightOpen, setRightOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  /* 上传文档 → Markdown 笔记（进当前笔记所在科目/笔记,否则 笔记/笔记） */
  const uploadDoc = async (file: File) => {
    try {
      const body = await fileToMarkdown(file);
      const title = docTitleFromFilename(file.name);
      const store = useAppStore.getState();
      const subj = (store.knowledge.find((k) => k.id === openId)?.domain?.split("/")[0] || "笔记");
      const dup = store.knowledge.find((k) => k.title === title);
      if (dup) {
        // 同名文档 = 更新：addKnowledge 按标题去重会把新内容静默丢弃，还提示"已导入"
        store.updateKnowledge(dup.id, { body, domain: `${subj}/笔记` });
        onOpenNote(dup.id);
        onModeChange("preview");
        setMobilePane("editor");
        toast.success(`已更新《${title}》`);
        return;
      }
      store.addKnowledge([{ title, body, domain: `${subj}/笔记` }], "manual", "上传文档");
      // 导入后直接打开这篇,用户立刻看到转换结果(而不是"传了但没反应")
      const created = useAppStore.getState().knowledge.find((k) => k.title === title);
      if (created) {
        onOpenNote(created.id);
        onModeChange("preview");
        setMobilePane("editor");
      }
      toast.success(`已导入《${title}》`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败");
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

  /* 文件夹树 = 用户自建文件夹 ∪ 笔记的一级目录（domain 即文件夹） */
  const treeFolders = useMemo(() => {
    const set = new Set(folders);
    for (const k of knowledge) set.add(k.domain);
    return [...set];
  }, [folders, knowledge]);

  /* ---- 派生 ---- */
  const domains = useMemo(() => Array.from(new Set(knowledge.map((k) => k.domain))), [knowledge]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of knowledge) for (const t of TAGS_OF(k)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
  }, [knowledge]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return knowledge.filter((k) => {
      if (domain !== "all" && k.domain !== domain) return false;
      if (activeTag && !TAGS_OF(k).some((t) => t.toLowerCase() === activeTag.toLowerCase())) return false;
      if (!q) return true;
      return k.title.toLowerCase().includes(q) || k.body.toLowerCase().includes(q);
    });
  }, [knowledge, query, domain, activeTag]);

  const backlinks = useMemo(
    () => (note ? knowledge.filter((k) => k.id !== note.id && k.links.includes(note.id)) : []),
    [knowledge, note]
  );
  const outgoing = useMemo(
    () =>
      note
        ? note.links
            .map((id) => knowledge.find((k) => k.id === id))
            .filter((k): k is KnowledgeItem => !!k)
        : [],
    [knowledge, note]
  );
  const outline = useMemo(() => (note && mode === "preview" ? outlineOf(note.body) : []), [note, mode]);
  const noteTags = note ? TAGS_OF(note) : [];

  /* 未链接提及：正文里写了 [[当前标题]] 但还没建立 id 链接的笔记 */
  const unlinkedMentions = useMemo(() => {
    if (!note) return [];
    const t = note.title.toLowerCase();
    return knowledge.filter(
      (k) => k.id !== note.id && !k.links.includes(note.id) && k.body.toLowerCase().includes(`[[${t}`)
    );
  }, [knowledge, note]);

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

  const createNote = (domain?: string) => {
    const id = createKnowledge({ domain: domain ?? "笔记" });
    onOpenNote(id);
    onModeChange("edit");
    if (!domain) toast.success("已新建，标题点一下就能改。");
    else setExpanded((s) => new Set(s).add(domain));
  };


  /* ---- 编辑器：自动保存 + [[ 补全 + 工具栏 ---- */
  const setBody = (body: string) => {
    if (!note) return;
    /* 敲 [[标题]] 时自动把双链解析进 links（标题→id），反链/图谱即时生效；
       保留手动/AI 建立的 id 链接 */
    const byTitle = new Map(knowledge.map((k) => [normTitle(k.title), k.id]));
    const resolved: string[] = [];
    const re = /!?\\?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const id = byTitle.get(m[1].trim().toLowerCase());
      if (id && id !== note.id) resolved.push(id);
    }
    updateKnowledge(note.id, { body, links: [...new Set([...resolved, ...note.links])] });
  };

  const onTaChange = (body: string, caret: number) => {
    setBody(body);
    /* 检测光标前未闭合的 [[ */
    const before = body.slice(0, caret);
    const m = before.match(/\[\[([^\]\n]*)$/);
    if (m) {
      setSuggest({ fragment: m[1], index: caret });
      setSuggestIdx(0);
    } else {
      setSuggest(null);
    }
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
    const body = note.body;
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

  const onTaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  const renameNote = (title: string) => {
    if (!note) return;
    const t = title.trim();
    if (!t) return;
    if (knowledge.some((k) => k.id !== note.id && normTitle(k.title) === normTitle(t))) {
      toast.error("已有同名笔记");
      return;
    }
    updateKnowledge(note.id, { title: t });
  };

  const deleteNote = () => {
    if (!note) return;
    if (!confirm(`删除《${note.title}》？此操作不可撤销。`)) return;
    removeKnowledge(note.id);
    onOpenNote(null);
    toast.success("已删除");
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
  const [suggests, setSuggests] = useState<{ targetId: string; reason: string }[] | null>(null);

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
        onDelta: () => {},
      });
      const parsed = autolinkSchema.parse(extractJson(full));
      if (parsed.links.length === 0) toast("暂时没有真正有联系的笔记——宁缺毋滥。");
      else setSuggests(parsed.links);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "建联失败");
    } finally {
      setLinking(false);
    }
  };

  const h = {
    note,
    setBody,
    onTaChange,
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
    for (const f of folders) ensure(f); // 自建的空文件夹
    for (const k of knowledge) ensure(k.domain).notes.push(k);
    return root;
  }, [folders, knowledge]);

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
            onClick={(e) => {
              e.stopPropagation();
              setMenuFor(menuFor === dir.path ? null : dir.path);
            }}
            className="hidden shrink-0 rounded p-0.5 text-ink-dim/60 transition hover:text-ink group-hover:block cursor-pointer"
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
              <button
                onClick={() => {
                  const total = countNotes(dir);
                  const msg = total > 0
                    ? `删除文件夹「${dir.name}」及其中的 ${total} 篇笔记？此操作不可撤销。`
                    : `删除空文件夹「${dir.name}」？`;
                  if (!confirm(msg)) return;
                  // 先删光里面的笔记（含子文件夹），再移除文件夹本身
                  const delAll = (d: TreeDir) => {
                    for (const k of d.notes) removeKnowledge(k.id);
                    for (const c of d.dirs.values()) delAll(c);
                  };
                  delAll(dir);
                  removeFolder(dir.path);
                  setExpanded((s) => {
                    const next = new Set(s);
                    next.delete(dir.path);
                    return next;
                  });
                  setMenuFor(null);
                  if (openId && dir.notes.some((k) => k.id === openId)) onOpenNote(null);
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
              onClick={() => {
                onOpenNote(k.id);
                onModeChange("preview");
                setMobilePane("editor");
              }}
              className="min-w-0 flex-1 cursor-grab px-2 py-1.5 text-left active:cursor-grabbing"
            >
              <p className={cn("truncate text-[12.5px]", active ? "font-semibold text-accent" : "text-ink")}>
                {k.title}
              </p>
              <p className="mt-0.5 truncate text-[10.5px] text-ink-dim/70">
                {k.body.replace(/\[\[([^\[\]]+)\]\]/g, "$1").replace(/[#*`>-]/g, "").slice(0, 40) ||
                  (TAGS_OF(k).length ? TAGS_OF(k).slice(0, 3).map((t) => "#" + t).join(" ") : "（空笔记）")}
              </p>
            </button>
            <button
              title="删除这篇笔记"
              onClick={(e) => {
                e.stopPropagation();
                if (!confirm(`删除《${k.title}》？此操作不可撤销。`)) return;
                removeKnowledge(k.id);
                if (openId === k.id) onOpenNote(null);
                toast.success("已删除");
              }}
              className="mr-1 mt-1.5 hidden shrink-0 rounded p-1 text-ink-dim/50 transition hover:text-bad group-hover:block cursor-pointer"
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
          className="w-full rounded-lg border border-border bg-white py-1.5 pl-8 pr-2 text-[13px] outline-none transition focus:border-accent/50"
          placeholder="搜索笔记…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {/* 标签筛选（默认收起：导入大库时标签会堆成一片，展开才显示） */}
      {allTags.length > 0 && (
        <div className="mb-1.5">
          <button
            onClick={() => setShowTags((v) => !v)}
            className="flex w-full items-center gap-1 text-left text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-dim/70 hover:text-ink cursor-pointer"
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
                    "rounded-full border px-2 py-0.5 text-[10.5px] transition cursor-pointer",
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
            title="上传文档（.docx / .md / .txt → 笔记；旧 .doc/.wps 请先另存为 .docx）"
            aria-label="上传文档"
            onClick={() => docInputRef.current?.click()}
            className="rounded-md p-1 text-ink-dim/70 transition hover:text-ink cursor-pointer"
          >
            <Upload className="size-3.5" />
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
                  setExpanded((s) => new Set(s).add(newFolder.trim()));
                  setNewFolder(null);
                }
                if (e.key === "Escape") setNewFolder(null);
              }}
              onBlur={() => {
                if (newFolder && newFolder.trim()) {
                  addFolder(newFolder.trim());
                  setExpanded((s) => new Set(s).add(newFolder.trim()));
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
              onClick={() => {
                onOpenNote(k.id);
                onModeChange("preview");
                setMobilePane("editor");
              }}
              className="min-w-0 flex-1 cursor-grab px-2 py-1.5 text-left active:cursor-grabbing"
            >
              <p className={cn("truncate text-[12.5px]", k.id === openId ? "font-semibold text-accent" : "text-ink")}>
                <Highlight text={k.title} q={query.trim().toLowerCase()} />
              </p>
              {/* Obsidian 式：标题未命中但正文命中时,给出命中上下文片段 */}
              {query.trim() &&
                !k.title.toLowerCase().includes(query.trim().toLowerCase()) &&
                (() => {
                  const sn = matchSnippet(k.body, query.trim().toLowerCase());
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
              onClick={(e) => {
                e.stopPropagation();
                if (!confirm(`删除《${k.title}》？此操作不可撤销。`)) return;
                removeKnowledge(k.id);
                if (openId === k.id) onOpenNote(null);
                toast.success("已删除");
              }}
              className="mr-1 mt-1 hidden shrink-0 rounded p-1 text-ink-dim/50 transition hover:text-bad group-hover:block cursor-pointer"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        ))}
      </div>
      <p className="pt-1.5 text-[10px] text-ink-dim/60">
        {knowledge.length} 篇 · {filtered.length} 篇可见 · 拖动笔记到文件夹即可移动
      </p>
    </div>
  );


  const rightPane = (
    <div className="flex h-full flex-col">
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
            onClick={() => setRightTab(t)}
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
                <p
                  key={i}
                  className={cn(
                    "truncate rounded px-1.5 py-0.5 text-ink",
                    h.level === 1 && "font-semibold",
                    h.level === 2 && "pl-4",
                    h.level === 3 && "pl-7 text-ink-dim"
                  )}
                >
                  {h.text}
                </p>
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
                    <button onClick={() => removeTag(t)} className="text-ink-dim/60 hover:text-bad cursor-pointer">
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
    <div>
      {/* 工作台：左缘 ribbon + 文件夹树 + 编辑器 + 功能面板（可收起） */}
      {/* 移动端单栏切换 Tab（桌面隐藏）；命中盒 ≥44px（M3-1） */}
      <div className="mb-2 flex gap-1 md:hidden">
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
        <div className="hidden h-full w-11 shrink-0 flex-col items-center gap-1.5 border-r border-border py-3 lg:flex">
          <button title="新建笔记" onClick={() => createNote()} className="rounded-lg p-2 text-ink transition hover:bg-black/[0.05] cursor-pointer">
            <Plus className="size-4.5" />
          </button>
          {importSlot}
          <button title="开始复习" onClick={onReview} disabled={dueCount === 0} className="rounded-lg p-2 text-ink transition hover:bg-black/[0.05] disabled:opacity-30 cursor-pointer">
            <RefreshCcw className="size-4.5" />
          </button>
          <button title="关系图谱" onClick={onGraph} className="rounded-lg p-2 text-ink transition hover:bg-black/[0.05] cursor-pointer">
            <Zap className="size-4.5" />
          </button>
          <div className="mt-auto flex flex-col items-center gap-1">
            <button
              title={rightOpen ? "收起功能面板" : "展开功能面板"}
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
            "h-full w-full shrink-0 overflow-hidden border-r border-border p-2.5 md:w-60",
            mobilePane === "list" ? "block" : "hidden md:block"
          )}
        >
          {leftPane}
        </div>

        {/* 中栏：编辑器 / 预览（移动端=笔记 Tab） */}
        <div className={cn("h-full min-w-0 flex-1 overflow-hidden", mobilePane === "editor" ? "block" : "hidden md:block")}>
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
              <div ref={headerRef} className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <input
                  className="min-w-0 flex-1 bg-transparent text-[17px] font-bold tracking-[-0.01em] text-ink outline-none"
                  value={note.title}
                  onChange={(e) => renameNote(e.target.value)}
                  spellCheck={false}
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
                  className="shrink-0 rounded-md p-1 text-ink-dim/50 transition hover:text-bad cursor-pointer"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>

              {/* 工具栏（编辑态）：手机可横向滚动，每个工具命中盒 ≥44px（M3-1/M5-2） */}
              {mode === "edit" && (
                <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-surface-2/60 px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:px-3 md:py-1.5">
                  {TOOLBAR.map((b) => (
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
                  ))}
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
                    disabled={aiBusy || !note}
                    title="AI 生成本篇要点摘要并追加到文末"
                    onClick={async () => {
                      if (!note) return;
                      setAiBusy(true);
                      try {
                        const sum = await aiNote("summarize", note.body);
                        setBody(note.body + "\n\n## 摘要\n" + sum);
                        toast.success("已追加 AI 摘要");
                      } catch {
                        toast.error("AI 总结失败，稍后再试");
                      } finally {
                        setAiBusy(false);
                      }
                    }}
                    className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:h-8"
                  >
                    <Sparkles className="mr-0.5 inline size-3" /> {aiBusy ? "AI 中…" : "AI 总结"}
                  </button>
                  <button
                    disabled={aiBusy || !note}
                    title="AI 润色全文（不改原意，保留双链/标签）"
                    onClick={async () => {
                      if (!note) return;
                      if (!confirm("用 AI 润色全文？原意与双链/标签保留，但措辞会重写。")) return;
                      setAiBusy(true);
                      try {
                        const rw = await aiNote("rewrite", note.body);
                        if (rw.trim()) setBody(rw);
                        toast.success("已 AI 润色全文");
                      } catch {
                        toast.error("AI 润色失败，稍后再试");
                      } finally {
                        setAiBusy(false);
                      }
                    }}
                    className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:h-8"
                  >
                    {aiBusy ? "AI 中…" : "AI 润色"}
                  </button>
                  <button
                    disabled={aiBusy}
                    title="LLMWiki 编译：把孤立笔记织进双链网（建链/合并建议/冲突标记）"
                    onClick={async () => {
                      setAiBusy(true);
                      try {
                        const { runWikiCompile } = await import("@/lib/wiki-compile");
                        const r = await runWikiCompile(3);
                        if (r.linked || r.merges.length || r.conflicts.length) {
                          toast.success(
                            `wiki 编译：新建 ${r.linked} 条链接${r.merges.length ? `；建议合并 ${r.merges.length} 处` : ""}${r.conflicts.length ? `；标记冲突 ${r.conflicts.length} 处` : ""}`
                          );
                        } else {
                          toast("没有孤立笔记需要编译，或暂无可建联系");
                        }
                      } catch {
                        toast.error("wiki 编译失败，稍后再试");
                      } finally {
                        setAiBusy(false);
                      }
                    }}
                    className="grid h-11 shrink-0 place-items-center rounded-md px-2.5 text-[11px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink cursor-pointer disabled:opacity-40 md:h-8"
                  >
                    {aiBusy ? "AI 中…" : "AI 整理"}
                  </button>
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

              {/* AI 建联建议 */}
              {mode === "edit" && suggests && suggests.length > 0 && (
                <div className="border-b border-accent/20 bg-accent/[0.04] px-4 py-2">
                  <div className="mb-1 flex items-center justify-between">
                    <p className="text-[11px] font-semibold text-accent">AI 觉得这些笔记和本篇有联系</p>
                    <button onClick={() => setSuggests(null)} className="text-ink-dim/60 hover:text-ink cursor-pointer">
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {suggests.map((s) => {
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
                              setSuggests((p) => (p ? p.filter((x) => x.targetId !== s.targetId) : null));
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

              {/* 正文：编辑（单栏沉浸写，写完点别处自动转排版文档）/ 预览 */}
              <div className="relative flex-1 overflow-hidden">
                {mode === "edit" ? (
                  <div className="relative h-full overflow-y-auto">
                    {editStyle === "live" ? (
                      <LiveBlocks
                        body={note.body}
                        notes={knowledge}
                        onCommit={(b) => {
                          setBody(b);
                          setSuggest(null);
                        }}
                        onOpen={(id) => onOpenNote(id)}
                        onCreate={(title) => openByTitle(title, true)}
                        onRewrite={(t) => aiNote("rewrite", t)}
                      />
                    ) : (
                    <textarea
                      ref={taRef}
                      className="min-h-full w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-relaxed text-ink outline-none"
                      value={note.body}
                      spellCheck={false}
                      placeholder="像聊天一样写就行——写完点一下别处，自动变成排版好的文档。输入 [[ 可以链接其他笔记…"
                      onChange={(e) => onTaChange(e.target.value, e.target.selectionStart ?? 0)}
                      onClick={(e) => onTaChange(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                      onKeyDown={onTaKeyDown}
                      onBlur={(e) => {
                        /* [[ 补全未关闭时先留在编辑态，避免误跳预览 */
                        if (suggest) {
                          setSuggest(null);
                          return;
                        }
                        /* 焦点移到标题栏/模式切换（页头）时留在编辑态 */
                        const next = e.relatedTarget as Node | null;
                        if (next && headerRef.current?.contains(next)) return;
                        onModeChange("preview");
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
                          onClick={() => {
                            const t = suggest.fragment.trim();
                            if (t) applySuggest(t);
                          }}
                          className={cn(
                            "block w-full border-t border-border px-3 py-1.5 text-left text-[13px] cursor-pointer",
                            suggestCandidates.length === 0 && suggestIdx === 0 ? "bg-accent/[0.09] text-accent" : "text-ink-dim hover:text-ink"
                          )}
                        >
                          ＋ 新建「{suggest.fragment.trim() || "…"}」并链接
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full overflow-y-auto px-5 py-4">
                    {note.body.trim() ? (
                      <WikiMarkdown
                        body={note.body}
                        notes={knowledge}
                        onOpen={(id) => onOpenNote(id)}
                        onCreate={(title) => openByTitle(title, true)}
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
            "h-full w-full shrink-0 overflow-hidden border-l border-border p-2.5 md:w-64",
            mobilePane === "info" ? "block" : "hidden",
            rightOpen ? "md:block" : "md:hidden"
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
