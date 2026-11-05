"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@/components/ui";
import { collectMarkdownFiles, parseVault, type ParsedNote } from "@/lib/obsidian-import";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { FolderUp } from "lucide-react";

/* 从 Obsidian 库导入笔记：文件夹选择 → 浏览器本地解析 → 按标题去重入库。
   笔记内容不经过服务器，入库后走既有的加密云同步。
   大库提示：localStorage 有 ~5MB 上限，支持按目录勾选与「仅结构」导入。 */

const SOFT_LIMIT_KB = 2500;

export function ObsidianImport({
  onDone,
  iconOnly,
}: {
  onDone?: () => void;
  iconOnly?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const importKnowledge = useAppStore((s) => s.importKnowledge);
  /* safeStorage 把 QuotaExceededError 吞掉并派发 mentora:quota（这是有意的：写满不崩）。
   * 所以导入的 catch 根本等不到配额异常——必须监听这个事件，否则「已导入 N 篇」是假成功。 */
  const quotaHitRef = useRef(false);
  useEffect(() => {
    const onQuota = () => {
      quotaHitRef.current = true;
    };
    window.addEventListener("mentora:quota", onQuota);
    return () => window.removeEventListener("mentora:quota", onQuota);
  }, []);
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [parsed, setParsed] = useState<ParsedNote[] | null>(null);
  const [pickedDomains, setPickedDomains] = useState<Set<string>>(new Set());
  const [structureOnly, setStructureOnly] = useState(false);
  const [importing, setImporting] = useState(false);

  const pick = () => inputRef.current?.click();

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = collectMarkdownFiles(e.target.files ?? []);
    e.target.value = ""; // 允许重复选同一个文件夹
    if (files.length === 0) {
      toast.error("所选文件夹里没有 .md 笔记。");
      return;
    }
    setParsing(true);
    setProgress({ done: 0, total: files.length });
    try {
      const notes = await parseVault(files, (done, total) => setProgress({ done, total }));
      setParsed(notes);
      /* 默认勾选：体积小的目录全选；超大目录（如书籍 3.4MB）留给用户决定 */
      const agg = new Map<string, number>();
      for (const n of notes) if (!n.skipped) agg.set(n.domain, (agg.get(n.domain) ?? 0) + n.body.length);
      const picked = new Set<string>();
      for (const [d, chars] of agg) if ((chars * 2) / 1024 <= SOFT_LIMIT_KB / 4) picked.add(d);
      setPickedDomains(picked);
    } catch {
      toast.error("解析失败，请重试。");
    } finally {
      setParsing(false);
    }
  };

  const valid = parsed?.filter((n) => !n.skipped) ?? [];

  const domainStats = () => {
    const m = new Map<string, { n: number; kb: number }>();
    for (const n of valid) {
      const e = m.get(n.domain) ?? { n: 0, kb: 0 };
      e.n += 1;
      e.kb += structureOnly ? 0.1 : (n.body.length * 2) / 1024;
      m.set(n.domain, e);
    }
    return [...m.entries()].sort((a, b) => b[1].kb - a[1].kb);
  };

  const selected = valid.filter((n) => pickedDomains.has(n.domain));
  const selectedKb = Math.round(
    selected.reduce((a, n) => a + (structureOnly ? 0.1 : (n.body.length * 2) / 1024), 0)
  );
  const skipReasons = () => {
    const m = new Map<string, number>();
    for (const n of parsed ?? []) if (n.skipped) m.set(n.skipped, (m.get(n.skipped) ?? 0) + 1);
    return [...m.entries()];
  };

  const confirm = async () => {
    if (selected.length === 0 || importing) return;
    setImporting(true);
    /* importKnowledge 是同步重活：先让一帧把 loading 画出来，否则 true/false
     * 同批合并、importing 永不渲染，按钮 loading 与 Modal 守卫都是死状态 */
    await new Promise((r) => setTimeout(r, 30));
    try {
      const { added, skipped } = importKnowledge(
        selected.map((n) => ({
          title: n.title,
          body: structureOnly ? "" : n.body,
          domain: n.domain,
          sourceTitle: n.sourceTitle,
          linkTitles: n.links,
          tags: n.tags,
        }))
      );
      if (quotaHitRef.current) {
        quotaHitRef.current = false;
        toast.error(
          `已导入 ${added} 篇，但本机存储已满——本地快照没写全，请先「导出备份」或改用「仅结构」再试。`
        );
      } else {
        toast.success(
          `已导入 ${added} 篇（跳过 ${skipped} 篇重复）${structureOnly ? " · 仅结构" : ""}`
        );
      }
      setParsed(null);
      onDone?.();
    } catch {
      toast.error("导入失败——笔记超出本地存储上限，取消勾选大目录或改用「仅结构」再试。");
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        // @ts-expect-error 非标准但 Chrome/Edge/Safari 均支持：选择整个文件夹
        webkitdirectory=""
        className="hidden"
        onChange={onFiles}
      />
      <Button
        variant="outline"
        size="sm"
        onClick={pick}
        disabled={parsing}
        title={parsing ? `解析中 ${progress.done}/${progress.total}` : "从 Obsidian 导入"}
        className={cn(iconOnly && "px-2.5")}
      >
        <FolderUp className="size-4" />
        {!iconOnly && (parsing ? `解析中 ${progress.done}/${progress.total}` : "从 Obsidian 导入")}
      </Button>

      <Modal open={!!parsed} onClose={() => !importing && setParsed(null)} title="从 Obsidian 导入" wide>
        {parsed && (
          <div className="space-y-4">
            <p className="text-sm text-ink-dim">
              解析 <b className="text-ink">{parsed.length}</b> 篇，可导入{" "}
              <b className="text-ink">{valid.length}</b> 篇（{parsed.length - valid.length} 篇因重名跳过）。
              按目录勾选要带正文的部分；[[双链]] 会自动连成网。
            </p>

            <div className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-border bg-surface-2 p-3">
              {domainStats().map(([d, s]) => (
                <label
                  key={d}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-1 text-[13px] hover:bg-black/[0.03]"
                >
                  <input
                    type="checkbox"
                    checked={pickedDomains.has(d)}
                    onChange={(e) => {
                      const next = new Set(pickedDomains);
                      if (e.target.checked) next.add(d);
                      else next.delete(d);
                      setPickedDomains(next);
                    }}
                    className="size-3.5 accent-accent"
                  />
                  <span className="flex-1 text-ink">{d}</span>
                  <span className="tabular text-ink-dim">{s.n} 篇</span>
                  <span className="tabular w-16 text-right text-ink-dim/70">
                    {structureOnly ? "—" : `${Math.round(s.kb)}KB`}
                  </span>
                </label>
              ))}
            </div>

            <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-dim">
              <input
                type="checkbox"
                checked={structureOnly}
                onChange={(e) => setStructureOnly(e.target.checked)}
                className="mt-0.5 size-3.5 accent-accent"
              />
              <span>
                <b className="text-ink">仅导入结构</b>（全部标题 + 双链关系，不含正文）——
                想把整座库变成图谱时用这个，几乎不占存储；之后想补哪篇的正文，单篇再导。
              </span>
            </label>

            <p className={cn("text-[11.5px] leading-relaxed", selectedKb > SOFT_LIMIT_KB ? "text-warn" : "text-ink-dim/70")}>
              预计写入 {selected.length} 篇 · 约 {selectedKb}KB
              {selectedKb > SOFT_LIMIT_KB && " —— 超过本地存储安全线，建议取消大目录勾选或改用「仅导入结构」"}
              。导入的 Obsidian 笔记默认不进复习队列。
            </p>
            {skipReasons().length > 0 && (
              <p className="text-[11.5px] text-ink-dim/70">
                跳过：{skipReasons().map(([r, n]) => `${r} ${n} 篇`).join("，")}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setParsed(null)} disabled={importing}>
                取消
              </Button>
              <Button onClick={confirm} loading={importing} disabled={selected.length === 0}>
                导入 {selected.length} 篇{structureOnly ? "（仅结构）" : ""}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
