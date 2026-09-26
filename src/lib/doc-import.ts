"use client";

/* 上传文档 → Markdown 笔记：
 * .md/.markdown/.txt 直接读；.docx 用 mammoth→HTML→turndown→MD（懒加载,不进首屏包）。
 * 旧版 .doc/.wps 是二进制格式,浏览器无法可靠解析 → 明确提示另存为 .docx。 */

export async function fileToMarkdown(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".txt")) {
    return await file.text();
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
    };
    const TurndownService = (tdMod.default ?? (tdMod as unknown as new () => { turndown: (h: string) => string }));
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
