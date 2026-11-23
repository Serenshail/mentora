import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ AssistantWidget 悬浮球位置 SSR 水合不匹配的回归锁 ============
 * 背景：assistant-widget.tsx 原先用 useState(loadPos) 作为初值。loadPos 在服务端
 * render 期执行，localStorage 失败被 try/catch 吞掉后落到 defaultPos() 的固定
 * {x:600,y:600}；客户端水合读到真实 localStorage 位置或按真实视口计算 defaultPos，
 * 两者几乎必然不同 → React 19 对按钮 style left/top 报水合属性不匹配，并把子树
 * 回退为客户端渲染，悬浮球从 (600,600) 闪跳到真实位置。挂载链无 SSR 门控
 * （app/layout.tsx 静态渲染 AppShell → app-shell.tsx 渲染 <AssistantWidget />）。
 *
 * 修复：初值换为 SSR 安全固定值 SSR_POS，首帧（ready=false）两端都返回 null，
 * 挂载后的 effect 才 setPos(loadPos()) 并放行渲染；持久化 effect 用 ready 门控，
 * 避免占位帧用 SSR_POS 覆盖用户已存位置。
 *
 * vitest 无 DOM 环境（无 jsdom/@testing-library），沿用本仓库既有做法：
 *  A) 行为锁：react-dom/server 的 renderToString 真渲染组件（mock 掉全部子依赖），
 *     断言 SSR 首帧既不含带 left/top 的悬浮球按钮、也不读 localStorage/window；
 *  B) 源码护栏：静态扫描，防止有人把 useState 初值改回 loadPos 或删掉 ready 门控
 *     （同 auth-submit-timeout.test.ts / seats.test.ts 既有做法）。 */

/* 用 vi.hoisted 提供可在 vi.mock 工厂与断言里共享的探针 */
const probe = vi.hoisted(() => ({
  lsGet: vi.fn(),
  lsSet: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  MessageCircleQuestion: () => null,
  Send: () => null,
  Square: () => null,
  X: () => null,
}));
vi.mock("@/lib/use-chat", () => ({
  useChat: () => ({
    messages: [], pending: "", streaming: false, error: null,
    stop: () => {}, send: () => Promise.resolve(""),
  }),
  useHydrated: () => false,
}));
vi.mock("@/lib/utils", () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(" ") }));
vi.mock("@/lib/store", () => ({ useAppStore: { getState: () => ({ addKnowledge: () => {} }) } }));
vi.mock("sonner", () => ({ toast: { success: () => {} } }));

/* SSR render 期若有人读 localStorage，探针会记录；这里故意让它抛错，
 * 模拟服务端无 localStorage 的真实情形（修复前的 loadPos 会 try/catch 吞掉，
 * 但探针仍留下"渲染期访问过浏览器 API"的证据）。 */
vi.stubGlobal("localStorage", {
  getItem: (k: string) => { probe.lsGet(k); return null; },
  setItem: (k: string, v: string) => { probe.lsSet(k, v); },
  removeItem: () => {},
});

import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { AssistantWidget } from "@/components/assistant-widget";

const SRC = readFileSync(
  join(process.cwd(), "src/components/assistant-widget.tsx"),
  "utf8"
);

describe("AssistantWidget 悬浮球位置 SSR 水合一致性（行为锁）", () => {
  it("SSR renderToString 首帧不渲染悬浮球（不含带 left/top 的按钮）", () => {
    probe.lsGet.mockClear();
    probe.lsSet.mockClear();
    const html = renderToString(createElement(AssistantWidget));
    /* 修复后首帧返回 null，服务端输出空串；修复前会输出 <button ... style="left:600px;top:600px..."> */
    expect(html).not.toContain("<button");
    expect(html).not.toContain("left:");
    expect(html).not.toContain("top:");
  });

  it("SSR render 期绝不读取 localStorage（位置改由挂载后的 effect 注入）", () => {
    probe.lsGet.mockClear();
    renderToString(createElement(AssistantWidget));
    expect(probe.lsGet, "渲染期不得读 localStorage").not.toHaveBeenCalled();
    expect(probe.lsSet, "渲染期不得写 localStorage").not.toHaveBeenCalled();
  });
});

describe("assistant-widget.tsx 源码护栏（防手改漂移）", () => {
  it("pos 的 useState 初值必须是 SSR 安全固定值，不得回到 useState(loadPos)", () => {
    const posInit = SRC.match(/const \[pos, setPos\] = useState\(([^)]*)\)/);
    expect(posInit, "找不到 pos 的 useState 初始化").not.toBeNull();
    const initExpr = posInit![1];
    expect(initExpr).not.toMatch(/loadPos/);
    /* 初值必须是常量表达式：SSR_POS 或对象字面量，不含函数/浏览器 API */
    expect(initExpr).not.toMatch(/defaultPos|localStorage|window|document/);
  });

  it("存在 SSR 安全固定占位常量，且逐字为 { x: 600, y: 600 }", () => {
    const m = SRC.match(/const SSR_POS\s*=\s*\{[^}]*\}/);
    expect(m, "找不到 SSR_POS 常量").not.toBeNull();
    expect(m![0]).toMatch(/x:\s*600/);
    expect(m![0]).toMatch(/y:\s*600/);
  });

  it("存在挂载后 effect：setPos(loadPos()) 且用空依赖数组（只跑一次）", () => {
    expect(SRC).toMatch(/setPos\(loadPos\(\)\)/);
    const initEffect = SRC.match(/useEffect\(\(\) => \{[\s\S]*?setPos\(loadPos\(\)\)[\s\S]*?\}, \[\]\)/);
    expect(initEffect, "找不到挂载后注入真实位置的 effect([])").not.toBeNull();
  });

  it("渲染有 ready 门控：首帧返回 null，SSR 与水合两端标记一致", () => {
    expect(SRC).toMatch(/if \(!ready\) return null/);
    expect(SRC).toMatch(/const \[ready, setReady\] = useState\(false\)/);
    expect(SRC).toMatch(/setReady\(true\)/);
  });

  it("持久化 effect 有 ready 门控，占位帧不得用 SSR_POS 覆盖用户已存位置", () => {
    const persistEffect = SRC.match(
      /useEffect\(\(\) => \{[\s\S]*?localStorage\.setItem\(POS_KEY[\s\S]*?\}, \[pos, ready\]\)/
    );
    expect(persistEffect, "找不到持久化 effect").not.toBeNull();
    expect(persistEffect![0]).toMatch(/if \(!ready\) return/);
  });

  it("loadPos 仍在挂载后路径被调用（修复不得顺手删掉位置记忆功能）", () => {
    expect(SRC).toContain("function loadPos()");
    expect(SRC).toContain("setPos(loadPos())");
  });
});
