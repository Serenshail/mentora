import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 智能体提示词里的侧栏 IA vs app-shell 的 NAV：回归锁 ============
 * 背景：AGENT_CHAT 的「# 界面」小节把侧栏导航结构写死进提示词
 * （"- 首页是对话；侧栏有「学习人生」…「学习」…「人生伙伴」"），而用户可见的
 * 真实 IA 来自 src/components/app-shell.tsx 的 const NAV。两处手写同一套入口名，
 * 改一处漏一处就会让左下角智能体报出过时的入口名（v22/v23 该 IA 已多次重构）。
 * 本仓库既有做法（见 seats.test.ts / app-shell-nav-partition.test.ts）：静态扫描
 * 源码做一致性守护。这里断言提示词里出现的「」入口名与 NAV 的 label 集合逐一对应。
 * 断言按锚点而非行号，后续重排换行不误报。 */

const PROMPTS = readFileSync(join(process.cwd(), "src/lib/ai/prompts.ts"), "utf8");
const SHELL = readFileSync(join(process.cwd(), "src/components/app-shell.tsx"), "utf8");

type NavEntry = { href: string; label: string; icon: string };

function parseNav(src: string): NavEntry[] {
  const start = src.indexOf("const NAV = [");
  expect(start, "app-shell.tsx 必须保留顶层 const NAV = [...]").toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  let depth = 0;
  let literal = "";
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) {
      literal = src.slice(open, i + 1);
      break;
    }
  }
  expect(literal, "NAV 数组字面量未闭合").not.toBe("");
  const normalized = literal.replace(
    /icon:\s*([A-Z][A-Za-z0-9_]*)/g,
    (_m, name: string) => `icon: ${JSON.stringify(name)}`
  );
  // 输入是本仓库源码的顶层常量字面量，已归一化 icon 标识符
  return eval(normalized) as NavEntry[];
}

/** prompts.ts 的「# 界面」小节里那一行侧栏 IA 描述。 */
function extractIaLine(src: string): string {
  const m = src.match(/^- 首页是对话；侧栏有[^\n]*$/m);
  expect(m, "prompts.ts 必须保留 AGENT_CHAT「# 界面」的侧栏 IA 描述行（- 首页是对话；侧栏有…）").not.toBeNull();
  return m![0];
}

describe("AGENT_CHAT 提示词的侧栏 IA 必须与 app-shell NAV 一致", () => {
  const nav = parseNav(SHELL);
  const home = nav.find((e) => e.href === "/");
  const sidebarLabels = nav.filter((e) => e.href !== "/").map((e) => e.label);
  const iaLine = extractIaLine(PROMPTS);
  const quoted = [...iaLine.matchAll(/「([^」]+)」/g)].map((m) => m[1]);

  it("NAV 有唯一首页 + 若干侧栏入口，锚点可用", () => {
    expect(home, "NAV 必须有一个 href=\"/\" 的首页项").toBeDefined();
    expect(sidebarLabels.length).toBeGreaterThan(0);
  });

  it("提示词「」里列出的每个入口名都是真实 NAV label（没有编造/过时入口）", () => {
    const navLabels = new Set(nav.map((e) => e.label));
    for (const q of quoted) {
      expect(navLabels.has(q), `提示词里的入口「${q}」在 NAV 中不存在（改名后提示词未同步）`).toBe(true);
    }
  });

  it("NAV 的每个侧栏入口都在提示词里出现（新增入口后提示词未同步会红）", () => {
    for (const label of sidebarLabels) {
      expect(
        quoted.includes(label),
        `NAV 侧栏入口「${label}」未出现在 AGENT_CHAT「# 界面」提示词里——新增/改名后需同步该行`
      ).toBe(true);
    }
  });

  it("「」入口集合恰好是 NAV 除首页外的全部入口（不多不少）", () => {
    expect(new Set(quoted)).toEqual(new Set(sidebarLabels));
  });
});
