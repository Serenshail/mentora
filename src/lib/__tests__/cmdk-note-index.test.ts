import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ cmdk 笔记检索：逐键击全库建串回归锁（perf low） ============
 * 旧实现：items = useMemo(..., [q, ...]) 内对每条 knowledge 构造
 *   `${k.title} ${k.body.slice(0, 400)}` 再 lowercase + includes ——
 *   每次键击（含刚打开面板的空查询）都为数千笔记分配数 MB 临时串并线性扫描。
 * 新实现：noteIndex = useMemo(..., [hasQuery, knowledge]) 仅在有查询时
 *   预建一次小写 hay，逐键击只做 includes；空查询连索引都不建（短路全部命中）。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库静态扫描做法
 * （button-theme-tokens.test.ts / app-shell-nav-partition.test.ts）：按语义锚点
 * 断言组件接线，并另对「旧/新匹配语义」做纯 JS 等价性校验（含边界）。 */

const CMDK = readFileSync(join(process.cwd(), "src/components/cmdk.tsx"), "utf8");

describe("cmdk.tsx 笔记检索索引", () => {
  it("检索串构造已移出逐键击的 items memo，改由缓存的 noteIndex 提供", () => {
    const start = CMDK.indexOf("const items = useMemo<Item[]>");
    expect(start, "必须保留 items useMemo").toBeGreaterThan(-1);
    const itemsBody = CMDK.slice(start, CMDK.indexOf("/* 键盘高亮跟随", start));
    // 逐键击路径不再为每条笔记建串
    expect(itemsBody).not.toContain("slice(0, 400)");
    expect(itemsBody).not.toMatch(/\$\{k\.title\}/);
    // items 依赖 query/noteIndex，而非每次输入都变的原始 q
    expect(itemsBody).toMatch(/\}\s*,\s*\[query,\s*noteIndex,/);
    expect(itemsBody).not.toMatch(/\}\s*,\s*\[q,/);
    // 空查询短路：noteIndex 此时为 []，不能去取 noteIndex[i]
    expect(itemsBody).toMatch(/!query\s*\|\|\s*noteIndex\[i\]\.includes\(query\)/);
  });

  it("noteIndex 仅随 hasQuery/knowledge 重建，空查询不建任何串", () => {
    const start = CMDK.indexOf("const noteIndex = useMemo<string[]>");
    expect(start, "必须保留 noteIndex useMemo").toBeGreaterThan(-1);
    const block = CMDK.slice(start, CMDK.indexOf("const items = useMemo", start));
    expect(block).toMatch(/\[hasQuery,\s*knowledge\]/);
    expect(block).not.toMatch(/\[q,/);
    expect(block).toMatch(/hasQuery\s*\?[\s\S]*:\s*\[\]/);
  });

  it("旧/新匹配语义等价（空查询、大小写、正文 400 截断、空库边界）", () => {
    const longBody = "前".repeat(400) + "尾部关键词";
    const notes = [
      { id: "k1", title: "React Hooks", body: "讲 useState 和 useEffect" },
      { id: "k2", title: "笔记", body: "正文包含 React 关键词" },
      { id: "k3", title: "长文", body: longBody },
      { id: "k4", title: "", body: "" },
    ];
    for (const q of ["", "   ", "react", "REACT", "React", "正文", "useState", "关键词", "尾部关键词", "不存在"]) {
      const query = q.trim().toLowerCase();
      const old = notes
        .filter((k) => !query || `${k.title} ${k.body.slice(0, 400)}`.toLowerCase().includes(query))
        .map((k) => k.id);
      const noteIndex = query.length > 0
        ? notes.map((k) => `${k.title} ${k.body.slice(0, 400)}`.toLowerCase())
        : [];
      const neu = notes
        .filter((_, i) => !query || noteIndex[i].includes(query))
        .map((k) => k.id);
      expect(neu, `q=${JSON.stringify(q)}`).toEqual(old);
    }
    // 第 400 字之后的内容确实不参与匹配（截断语义未被放宽）
    expect(longBody.slice(0, 400)).not.toContain("尾部关键词");
    // 空库：有查询时 noteIndex=[]，filter 迭代 0 次，noteIndex[i] 不会被取到（不抛错）
    const empty: typeof notes = [];
    for (const q of ["", "react"]) {
      const query = q.trim().toLowerCase();
      const idx = query.length > 0
        ? empty.map((k) => `${k.title} ${k.body.slice(0, 400)}`.toLowerCase())
        : [];
      expect(empty.filter((_, i) => !query || idx[i].includes(query))).toEqual([]);
    }
  });
});
