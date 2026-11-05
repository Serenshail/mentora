"use client";

/* 上传文档 → Markdown 笔记：
 * .md/.markdown/.txt 直接读；.docx 用 mammoth→HTML→turndown→MD（懒加载,不进首屏包）。
 * 旧版 .doc/.wps 是二进制格式,浏览器无法可靠解析 → 明确提示另存为 .docx。 */

export async function fileToMarkdown(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".txt")) {
    /* file.text() 固定按 UTF-8 解码：GBK/GB2312 中文 txt 会整篇变 U+FFFD 乱码。
     * 检出明显乱码占比时用 GBK 二次解码兜底（环境不支持 GBK 则按 UTF-8 原样返回）。 */
    const buf = await file.arrayBuffer();
    const utf8 = new TextDecoder("utf-8").decode(buf);
    const bad = (utf8.match(/\uFFFD/g) ?? []).length;
    if (bad / Math.max(1, utf8.length) > 0.01) {
      try {
        return new TextDecoder("gbk").decode(buf);
      } catch {
        /* 无 GBK 解码能力：返回 UTF-8 结果 */
      }
    }
    return utf8;
  }
  if (name.endsWith(".docx")) {
    const arrayBuffer = await file.arrayBuffer();
    const mod = (await import("mammoth/mammoth.browser")) as unknown as Record<string, unknown>;
    const mammoth = (mod.default ?? mod) as {
      convertToHtml: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
    };
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
    const tdMod = (await import("turndown")) as unknown as {
      default?: new () => { turndown: (h: string) => string };
      TurndownService?: new () => { turndown: (h: string) => string };
    };
    /* interop 三形态兜齐：ESM default / CJS 具名导出 / CJS module.exports=类本身 */
    const TurndownService =
      tdMod.default ?? tdMod.TurndownService ?? (tdMod as unknown as new () => { turndown: (h: string) => string });
    const td = new TurndownService();
    return td.turndown(html);
  }
  if (name.endsWith(".doc") || name.endsWith(".wps")) {
    throw new Error("旧版 .doc/.wps 浏览器无法解析——请在 WPS/Word 里「另存为 .docx」再上传");
  }
  throw new Error("仅支持 .docx / .md / .txt");
}

export function docTitleFromFilename(filename: string): string {
  return filename.replace(/\.(docx|md|markdown|txt)$/i, "").slice(0, 60) || "上传笔记";
}
