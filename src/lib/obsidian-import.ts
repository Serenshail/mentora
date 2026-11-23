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

/** 解析 frontmatter（--- ... ---），返回元数据、剥离后的正文与原始 meta 块（调用方抽 tags 用，避免再 match 一遍） */
function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string; metaBlock: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw, metaBlock: "" };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_\-\u4e00-\u9fa5]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(m[0].length), metaBlock: m[1] };
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
    /* 行首 # 若是标题（# 后紧跟空格）不算标签——上面的字符类已排除空格，无需额外判断 */
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

/** 单次解析的硬上限（篇数 + 已读字节）。
 * 为什么必须有：按目录勾选与「仅结构」都发生在 parseVault 之后，而解析会把每个 .md 的
 * 正文 file.text() 读进 ParsedNote 常驻内存（out + setParsed 的 React state）。单文件
 * 512KB 上限只管单篇、管不住篇数与总量：移动端选一个几万篇的库，会在看到任何降级选项
 * 之前先把数百 MB 字符串拉进内存，崩标签页。因此解析阶段自己兜一层总预算，超出即停止
 * 读取并把未解析篇数回报给调用方（由 UI 提示分批导入），而不是读完再让用户选。 */
export const PARSE_MAX_FILES = 20000;
export const PARSE_MAX_BYTES = 32 * 1024 * 1024;

export interface ParseVaultResult {
  notes: ParsedNote[];
  /** 因超出 PARSE_MAX_FILES / PARSE_MAX_BYTES 而未读取的文件数（0 = 全部已解析） */
  truncated: number;
}

/** 批量解析。onProgress(已解析数) 用于进度条；limits 仅供测试注入小预算 */
export async function parseVault(
  files: File[],
  onProgress?: (done: number, total: number) => void,
  limits: { maxFiles?: number; maxBytes?: number } = {}
): Promise<ParseVaultResult> {
  const maxFiles = limits.maxFiles ?? PARSE_MAX_FILES;
  const maxBytes = limits.maxBytes ?? PARSE_MAX_BYTES;
  const out: ParsedNote[] = [];
  const titles = new Set<string>();
  let done = 0;
  let bytes = 0; // 已读文件的字节数（file.size；内存占用约 ≤2 倍）
  let truncated = 0;

  for (const file of files) {
    /* 预算在读取之前判定：out 的篇数与已读字节都不再无界增长 */
    if (out.length >= maxFiles || bytes >= maxBytes) {
      truncated = files.length - done;
      break;
    }
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
    /* domain = 完整相对目录路径（如 WorkBuddy/学习/agent项目），保留 Obsidian 的嵌套结构 */
    const domain = segs.length > 1 ? segs.slice(0, -1).join("/") : "Obsidian";
    let tags: string[] = [];

    if (!skipped) {
      try {
        bytes += file.size;
        const raw = await readAsText(file);
        /* metaBlock 由 splitFrontmatter 一并带回：旧实现先手动 match 再调函数再 match，
         * 同一正则跑两遍（报告 3.2 登记）。 */
        const { meta, body: md, metaBlock } = splitFrontmatter(raw);
        body = md.trim();
        if (meta.title) title = meta.title;
        tags = [...new Set([...extractMetaTags(metaBlock), ...extractInlineTags(body)])].slice(0, 12);
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
  /* 截断时 done < files.length：进度按实际解析数收尾，不谎报已全量读完 */
  if (onProgress) onProgress(done, files.length);
  return { notes: out, truncated };
}

/** 把双链目标规范化：与导入清单/已有笔记标题做大小写不敏感匹配 */
export function normalizeTitle(t: string): string {
  return t.trim().toLowerCase();
}
