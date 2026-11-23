import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.node";

/* ============ 部署后旧 HTML 白屏自愈：监听器必须随 HTML 解析即注册 ============
 * 背景（FIX heavy-f43）：chunk-recovery.tsx 原先用 useEffect 注册 window error
 * 监听器，但组件自己就打在初始 entry chunk 里——「页面 HTML 引用的 JS chunk
 * 在新部署下 404，hydration 永不发生」这个注释点名的冷启动场景下 React 根本
 * 不执行，handler 永远不注册，白屏无人自愈。next/script beforeInteractive 也
 * 不行：app 目录下它只 push 到 self.__next_s，由 app-bootstrap 在 entry chunk
 * 跑起来后才加载（node_modules/next/dist/client/script.js:274）。
 *
 * 修复：组件改为服务端渲染的内联 <script>，HTML 一解析就注册监听器，不依赖
 * 任何 chunk。本文件同时锁三件事：
 *  A) SSR 输出里确实带内联脚本，且组件不再依赖 "use client"/useEffect；
 *  B) 脚本行为（命中 _next/static 才刷新、TTL 内不重复、TTL 后可再自愈一次、
 *     隐私模式下 sessionStorage 抛错仍能自愈、重复执行只挂一个监听器）；
 *  C) layout.tsx 把它放进 <head>、早于 <AppShell>（实测：body 首节点在慢 CSS 下
 *     会被样式表阻塞，12/13 个 chunk error 先于注册而漏掉；head 版为 0）。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法：A/C 用 renderToStaticMarkup
 * 与源码锚点断言（见 assistant-widget-ssr-pos.test.ts），B 用 new Function 把
 * 脚本正文注入受控假环境求值。 */

const SRC = readFileSync(
  join(process.cwd(), "src/components/chunk-recovery.tsx"),
  "utf8"
);
const LAYOUT = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");

import { ChunkRecovery, CHUNK_RECOVERY_SCRIPT } from "@/components/chunk-recovery";

const KEY = "mentora-chunk-retry";

type Env = {
  listeners: Array<{ type: string; fn: (e: unknown) => void; capture: boolean }>;
  reloads: number;
  store: Map<string, string>;
  throwOnStorage: boolean;
  run: () => void;
};

/** 受控假环境：window / sessionStorage / location 全部由测试掌控。 */
function makeEnv(opts: { throwOnStorage?: boolean; store?: Map<string, string> } = {}): Env {
  const listeners: Env["listeners"] = [];
  const store = opts.store ?? new Map<string, string>();
  const env: Env = {
    listeners,
    reloads: 0,
    store,
    throwOnStorage: opts.throwOnStorage ?? false,
    run: () => {},
  };
  const win = {
    addEventListener(type: string, fn: (e: unknown) => void, capture: boolean) {
      listeners.push({ type, fn, capture });
    },
  };
  const sessionStorage = {
    getItem(k: string) {
      if (env.throwOnStorage) throw new Error("SecurityError");
      return store.has(k) ? store.get(k)! : null;
    },
    setItem(k: string, v: string) {
      if (env.throwOnStorage) throw new Error("SecurityError");
      store.set(k, v);
    },
  };
  const location = {
    reload() {
      env.reloads++;
    },
  };
  // 输入是本仓库源码里导出的脚本字面量（非外部输入）
  const fn = new Function("window", "sessionStorage", "location", CHUNK_RECOVERY_SCRIPT);
  env.run = () => fn(win, sessionStorage, location);
  return env;
}

/** 派发一次「脚本资源加载失败」：资源错误事件不冒泡，用捕获阶段监听。 */
function fireScriptError(env: Env, src: string) {
  const errs = env.listeners.filter((l) => l.type === "error");
  expect(errs.length, "必须已注册 error 监听器").toBeGreaterThan(0);
  for (const l of errs) l.fn({ target: { src } });
}

describe("chunk-recovery：监听器随 HTML 解析注册（冷启动白屏自愈）", () => {
  it("SSR 输出即含内联脚本，不依赖客户端 hydration", () => {
    const html = renderToStaticMarkup(createElement(ChunkRecovery));
    expect(html).toMatch(/^<script>/);
    expect(html).toContain("_next/static/");
    expect(html).toContain('addEventListener("error"');
  });

  it("组件不再用 useEffect / \"use client\"（那两条在 entry chunk 404 时都不执行）", () => {
    // 去掉注释再断言：说明文字里提到 useEffect 是解释，不是实现。
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("useEffect");
    expect(code).not.toContain("use client");
    expect(code).not.toContain("react");
  });

  it("layout.tsx 把它放进 <head>、早于 <AppShell>（尽早注册，减少被慢 CSS 阻塞的窗口）", () => {
    const head = LAYOUT.indexOf("<head>");
    const headEnd = LAYOUT.indexOf("</head>");
    const recovery = LAYOUT.indexOf("<ChunkRecovery />");
    const body = LAYOUT.indexOf("<body");
    const shell = LAYOUT.indexOf("<AppShell>");
    expect(head, "layout 必须有 <head>").toBeGreaterThan(-1);
    expect(headEnd, "layout 必须有 </head>").toBeGreaterThan(head);
    expect(recovery, "layout 必须挂载 <ChunkRecovery />").toBeGreaterThan(head);
    expect(recovery, "必须在 </head> 之前").toBeLessThan(headEnd);
    expect(recovery).toBeLessThan(body);
    expect(shell, "layout 必须有 <AppShell>").toBeGreaterThan(recovery);
  });

  it("命中 _next/static 的脚本失败 → 刷新一次并记时间戳", () => {
    const env = makeEnv();
    env.run();
    fireScriptError(env, "https://x.test/_next/static/chunks/abc.js");
    expect(env.reloads).toBe(1);
    expect(Number(env.store.get(KEY))).toBeGreaterThan(0);
  });

  it("非 _next/static 的失败（图片等）不刷新", () => {
    const env = makeEnv();
    env.run();
    fireScriptError(env, "https://x.test/logo.png");
    fireScriptError(env, "");
    expect(env.reloads).toBe(0);
    expect(env.store.has(KEY)).toBe(false);
  });

  it("TTL 内不重复刷新，TTL 后可再自愈一次（同会话第二次 404 有人管）", () => {
    const env = makeEnv();
    env.run();
    const t0 = Date.now();
    env.store.set(KEY, String(t0));
    fireScriptError(env, "https://x.test/_next/static/chunks/a.js");
    expect(env.reloads).toBe(0);

    env.store.set(KEY, String(t0 - 121_000)); // 超过 2 分钟
    fireScriptError(env, "https://x.test/_next/static/chunks/b.js");
    expect(env.reloads).toBe(1);
  });

  it("隐私模式 sessionStorage 抛错时仍自愈一次（不因防循环而放弃刷新）", () => {
    const env = makeEnv({ throwOnStorage: true });
    env.run();
    expect(() => fireScriptError(env, "https://x.test/_next/static/chunks/c.js")).not.toThrow();
    expect(env.reloads).toBe(1);
  });

  it("脚本被执行两次也只挂一个监听器（幂等）", () => {
    const env = makeEnv();
    env.run();
    env.run();
    expect(env.listeners.filter((l) => l.type === "error")).toHaveLength(1);
    fireScriptError(env, "https://x.test/_next/static/chunks/d.js");
    expect(env.reloads).toBe(1); // 若挂了两份，会 set 时间戳后第二次被 TTL 拦住，仍为 1；
    // 故额外断言监听器数量，确保没有重复注册。
  });
});
