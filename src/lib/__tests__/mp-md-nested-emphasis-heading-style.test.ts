import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 md 渲染：嵌套强调 + 标题不注入内联字重/颜色（回归锁） ============
 * 事故一（utils/md.js TOKEN_RE 粗体分支旧写法 \*\*([^*]+)\*\*）：粗体里嵌斜体时
 * 整体匹配失败、只剩内层斜体命中，外层星号以纯文本泄漏到渲染文本
 * （md.parse('**加粗里含 *斜体* 的写法**') 首块无任何 b:true span，输出两个
 * 字面 ** 的空文本 span）；plain() 气泡摘要同样残留星号。
 * 修复：粗体内部允许单个 *（\*(?!\*)），命中的粗体内容递归 tokenize 后统一盖
 * b:true（粗体套斜体 → b+i 的 span）；plain() 粗体剥离改惰性匹配。
 *
 * 事故二（md.js 标题注入内联 font-weight:600;color:var(--ink)）：md.wxml 把标题
 * 包在 class="md-h md-h{{level}}" 里，app.wxss 的 .md-h1/.md-h2(700)、
 * .md-h4(--ink-2) 才是设计系统档位；内联样式压过父级类继承，标题层级被塌平。
 * 修复：标题 baseStyle 置空（与 .md-p 相同的「外层类 + 继承」机制）。
 *
 * 两处共享的隐患一并钉住：粗体递归 tokenize 会重置共享正则的 lastIndex，
 * 外层扫描位置必须恢复——否则多处粗体的行会重复扫头/死循环。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const MD_PATH = join(ROOT, "miniprogram/utils/md.js");

type Dict = Record<string, unknown>;

function loadMd() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  };
  delete requireCjs.cache[MD_PATH];
  return requireCjs(MD_PATH) as {
    parse: (t: string) => { blocks: any[]; links: unknown[] };
    plain: (t: string) => string;
  };
}

const spanText = (n: Dict) => String((n.children as Dict[])[0].text);
const hasStyle = (n: Dict, frag: string) => String((n.attrs as Dict).style).includes(frag);

describe("mp md 嵌套强调", () => {
  it("粗体含斜体：产出粗体 span 与粗斜体 span，星号不再泄漏", () => {
    const md = loadMd();
    const nodes = md.parse("**加粗里含 *斜体* 的写法**").blocks[0].nodes as Dict[];
    expect(nodes.some((n) => hasStyle(n, "font-weight:600"))).toBe(true);
    expect(nodes.some((n) => hasStyle(n, "font-weight:600") && hasStyle(n, "font-style:italic"))).toBe(true);
    expect(nodes.some((n) => spanText(n).includes("**"))).toBe(false);
    expect(nodes.map(spanText).join("")).toBe("加粗里含 斜体 的写法");
  });

  it("plain() 摘要不残留星号", () => {
    const md = loadMd();
    expect(md.plain("**加粗里含 *斜体* 的写法**")).toBe("加粗里含 斜体 的写法");
  });

  it("常规单层粗体/斜体/代码/链接不回归", () => {
    const md = loadMd();
    const bold = md.parse("**纯粗体**").blocks[0].nodes as Dict[];
    expect(bold).toHaveLength(1);
    expect(hasStyle(bold[0], "font-weight:600")).toBe(true);

    const italic = md.parse("*纯斜体*").blocks[0].nodes as Dict[];
    expect(italic).toHaveLength(1);
    expect(hasStyle(italic[0], "font-style:italic")).toBe(true);

    const mixed = md.parse("前 **b** 中 *i* 后").blocks[0].nodes as Dict[];
    expect(mixed.map(spanText).join("")).toBe("前 b 中 i 后");
    expect(mixed.filter((n) => hasStyle(n, "font-weight:600"))).toHaveLength(1);
    expect(mixed.filter((n) => hasStyle(n, "font-style:italic"))).toHaveLength(1);
  });

  it("一行里多处粗体：递归后共享正则状态被恢复，不重复不吞段", () => {
    const md = loadMd();
    const nodes = md.parse("**a** ok **b** 也 *c* 完").blocks[0].nodes as Dict[];
    expect(nodes.map(spanText).join("")).toBe("a ok b 也 c 完");
    expect(nodes.filter((n) => hasStyle(n, "font-weight:600"))).toHaveLength(2);
    expect(nodes.filter((n) => hasStyle(n, "font-style:italic"))).toHaveLength(1);
  });
});

describe("mp md 标题样式", () => {
  it("标题 span 不注入内联字重/颜色，档位交给 .md-h1/.md-h2/.md-h4", () => {
    const md = loadMd();
    const blocks = md.parse("# 一\n## 二\n#### 四").blocks;
    expect(blocks.map((b: Dict) => b.level)).toEqual([1, 2, 4]);
    for (const b of blocks) {
      for (const n of b.nodes as Dict[]) {
        expect(hasStyle(n, "font-weight")).toBe(false);
        expect(hasStyle(n, "color")).toBe(false);
      }
    }
  });
});
