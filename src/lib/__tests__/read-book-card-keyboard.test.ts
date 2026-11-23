import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 读书伙伴书架：书籍卡片必须键盘可达（回归锁 v2） ============
 * 历史：书卡原先在 read-workspace.tsx（v23.3），2026-11-11 并发重构迁到
 * reading-shelf.tsx 并改进了可达性——整卡 onClick 移除，标题与「打开阅读」
 * 都是原生 <Link>（可聚焦、Enter 跳转、读屏报链接），删除按钮保留独立
 * aria-label。本锁锁定迁移后的语义：
 *   1. 书名链接指向 /read/{id}；
 *   2. 卡内还有显式「打开阅读」链接（带 aria-label）；
 *   3. 卡片本身不占用键盘焦点（无 tabIndex/role=button）；
 *   4. 删除按钮在卡内、带 aria-label、是原生 button。
 *
 * vitest 无 DOM 环境，沿用本仓库既有做法：读源码、剥离注释后按语义锚点
 * 断言，不依赖行号。 */

const PAGE = readFileSync(join(process.cwd(), "src/components/reading-shelf.tsx"), "utf8");

/** 剥离块/行注释（感知字符串与转义），防止把守卫注释掉骗过本锁。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++; // 保留换行
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += src[i];
          i++;
          if (i < n) {
            out += src[i];
            i++;
            continue;
          }
        }
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const SRC = stripComments(PAGE);

/** 从 anchor 起点截出该 <Card ...> 开标签。 */
function cardTagAt(src: string, anchorIndex: number): string {
  const start = src.lastIndexOf("<Card", anchorIndex);
  expect(start).toBeGreaterThan(-1);
  let brace = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === ">" && brace === 0) return src.slice(start, i + 1);
  }
  throw new Error("未找到 Card 开标签的结束尖括号");
}

/** 截出从 anchor 处开始的 <Link ...>…</Link> 片段（含内部文本）。 */
function linkSnippetAt(src: string, anchorIndex: number): string {
  const start = src.lastIndexOf("<Link", anchorIndex);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("</Link>", start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + "</Link>".length);
}

/* 锚点：书卡标题链接（渲染 book.title 的那个 Link） */
const titleAnchor = SRC.indexOf("<Link href={`/read/${book.id}`}");
const card = cardTagAt(SRC, titleAnchor);
const titleLink = linkSnippetAt(SRC, titleAnchor);

describe("读书伙伴书卡键盘可达（reading-shelf v2）", () => {
  it("书名用 next/link 的 Link 指向书籍详情", () => {
    expect(SRC).toMatch(/import Link from "next\/link"/);
    expect(titleLink).toMatch(/href=\{`\/read\/\$\{book\.id\}`\}/);
    expect(titleLink).toContain("{book.title}");
  });

  it("卡内还有显式「打开阅读」链接且带 aria-label（读屏可命名）", () => {
    expect(SRC).toContain("aria-label={`打开${book.title}的阅读工作区`}");
    expect(SRC).toContain("打开阅读");
  });

  it("书名与 CTA 链接可见焦点（focus-visible）", () => {
    expect(titleLink).toContain("focus-visible:outline");
  });

  it("整卡不占用键盘焦点：无 tabIndex、无 role=button", () => {
    expect(card).not.toContain("tabIndex");
    expect(card).not.toContain('role="button"');
    expect(card).not.toContain("onClick");
  });

  it("删除按钮在卡片内、带 aria-label、是原生 button", () => {
    const afterCard = SRC.slice(SRC.indexOf(card) + card.length);
    expect(afterCard).toContain('aria-label={`删除《${book.title}》`}');
    expect(afterCard).toContain("<button");
    /* 删除不再需要 stopPropagation：卡片本身没有 onClick，一次点击不会误导航 */
    expect(card).not.toContain("router.push");
  });
});
