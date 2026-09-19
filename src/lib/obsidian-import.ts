/* Obsidian 库导入：解析 .md 文件 → 第二大脑笔记
 * 纯浏览器端解析，笔记内容不经过任何服务器中转（入库后走既有加密同步）。
 * 支持：frontmatter(title/tags/date)、[[双链]]（含 #锚点 与 |别名）、目录分域。 */

export interface ObsidianNote {
  title: string; // 笔记标题（去 .md，frontmatter title 优先）
  body: string; // 正文（去掉 frontmatter，保留 markdown 与 [[..]]）
  domain: string; // 库内一级目录名（无目录则 "Obsidian"）
  sourceTitle: string; // 库内相对路径
  links: string[]; // 出链目标标题（已去别名/锚点，规范化）
  tags: string[]; // frontmatter tags + 正文行内 #标签
}

export interface ParsedNote extends ObsidianNote {
  skipped: string | null; // 跳过原因（null=有效）
}

/** 递归收集 FileList 里的 markdown（排除 .obsidian/.trash 等系统目录） */
export function collectMarkdownFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((f) => {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (!/\.md$/i.test(f.name)) return false;
    const low = path.toLowerCase();
    return !low.includes("/.obsidian/") && !low.includes("/.trash/") && !low.startsWith(".obsidian/");
  });
}

function relativePath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  // 去掉文件夹选择时带上的库根目录名（第一段）
  const segs = rel.split("/");
  return segs.length > 1 ? segs.slice(1).join("/") : rel;
}

function readAsText(file: File): Promise<string> {
  /* file.text() 浏览器与 Node 通用；非 UTF-8 字节会被替换符兜底不抛错 */
  return file.text();
}

/** 解析 frontmatter（--- ... ---），返回元数据与剥离后的正文 */
function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_\-\u4e00-\u9fa5]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** 抽取 [[双链]] 目标：[[目标|别名]]、[[目标#锚]]、![[嵌入]] 都归一到目标标题 */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  const re = /!?\\?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

/** 抽取行内 #标签（排除标题行与纯数字）；frontmatter tags 另行合并 */
export function extractInlineTags(body: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\s)#([^\s#`~!@#$%^&*()=+{\}[\]|\\:;"'<>,.?/，。！？：（）【】]{2,24})/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const lineStart = m.index === 0 || body[m.index] === "\n";
    if (lineStart && /^#[^#]/.test(m[0].trim()) === false) {
      /* 行首 # 若是标题（# 后紧跟空格）不算标签——上面字符类已排除空格 */
    }
    const t = m[1].replace(/[.,;:!?，。：；！？]+$/, "");
    if (t && !/^\d+$/.test(t)) out.add(t);
  }
  return [...out];
}

/** frontmatter tags 行：`tags: a, b` 或 YAML 数组 `- a` */
function extractMetaTags(metaBlock: string): string[] {
  const out = new Set<string>();
  const lines = metaBlock.split(/\r?\n/);
  let inTags = false;
  for (const line of lines) {
    const kv = line.match(/^tags\s*:\s*(.*)$/i);
    if (kv) {
      inTags = true;
      for (const t of kv[1].replace(/^\[|\]$/g, "").split(",")) {
        const v = t.trim().replace(/^["']|["']$/g, "");
        if (v) out.add(v.replace(/^#/, ""));
      }
      continue;
    }
    if (inTags) {
      const arr = line.match(/^\s*-\s+(.+)$/);
      if (arr) out.add(arr[1].trim().replace(/^#/, ""));
      else if (line.trim()) inTags = false;
    }
  }
  return [...out];
}

/** 批量解析。onProgress(已解析数) 用于进度条 */
export async function parseVault(
  files: File[],
  onProgress?: (done: number, total: number) => void
): Promise<ParsedNote[]> {
  const out: ParsedNote[] = [];
  const titles = new Set<string>();
  let done = 0;

  for (const file of files) {
    const rel = relativePath(file);
    const segs = rel.split("/");
    let skipped: string | null = null;

    if (segs.some((s) => s.startsWith(".") || s === "_templates" || s === "templates")) {
      skipped = "系统/模板目录";
    } else if (file.size > 512 * 1024) {
      skipped = "超过 512KB（疑似导出/日志文件）";
    }

    let title = file.name.replace(/\.md$/i, "");
    let body = "";
    let domain = segs.length > 1 ? segs[0] : "Obsidian";
    let tags: string[] = [];

    if (!skipped) {
      try {
        const raw = await readAsText(file);
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        const { meta, body: md } = splitFrontmatter(raw);
        body = md.trim();
        if (meta.title) title = meta.title;
        tags = [...new Set([...extractMetaTags(fm ? fm[1] : ""), ...extractInlineTags(body)])].slice(0, 12);
      } catch {
        skipped = "读取失败（非 UTF-8？）";
      }
    }

    const t = title.trim();
    if (!skipped && !t) skipped = "空标题";
    if (!skipped && titles.has(t)) skipped = "库内重名";

    if (!skipped) titles.add(t);
    out.push({
      title: t,
      body,
      domain,
      sourceTitle: rel,
      links: skipped ? [] : extractLinks(body),
      tags,
      skipped,
    });

    done += 1;
    if (onProgress && done % 25 === 0) onProgress(done, files.length);
  }
  if (onProgress) onProgress(files.length, files.length);
  return out;
}

/** 把双链目标规范化：与导入清单/已有笔记标题做大小写不敏感匹配 */
export function normalizeTitle(t: string): string {
  return t.trim().toLowerCase();
}
