import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 落地页 hero 视频：不可见时不得继续 seek 的回归锁 ============
 * 背景：HeroVideo 的 mousemove 监听挂在 window 上并存活整个 Landing 生命周期，
 * 原先没有任何「hero 是否可见」的判断。hero 以下的实底产品区
 * （landing.tsx 的 `relative z-[1] … bg-bg` 容器）完全盖住 fixed inset-0 的视频，
 * 用户在定价/FAQ 区横向移动鼠标仍会不断改 video.currentTime 触发 seek；
 * preload="metadata" 下多数区段未缓冲，每次 seek 都可能发起媒体 range 请求 + 解码，
 * 全是给看不见的画面白耗带宽与电量（自托管部署纯浪费）。
 *
 * 修复：Landing 已有 pastHero（实底容器 rect.top <= 0 即完全盖住 hero）的滚动感知，
 * 直接把它作为 HeroVideo 的 active 开关；active=false 时 onMove 不累计位移、
 * applySeek 直接返回（onSeeked 的重试路径也被它挡住），onLoaded 也不补初始 seek。
 * 同时仍同步 prevX，滚回首屏后第一次移动不会因为旧起点算出一个大跳。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法（learn-enter-ime-guard.test.ts
 * 的静态扫描 + assistant-widget-ssr-pos.test.ts 的行为锁）：把源码里 HeroVideo 的
 * 擦洗 useEffect 函数体原样抽出来，注入假 video/window 真实执行，断言 seek 行为，
 * 而不是只断言源码里出现过某个字符串。 */

const SRC = readFileSync(join(process.cwd(), "src/components/landing.tsx"), "utf8");

/** 抽出 HeroVideo 组件源码段：从函数声明起按花括号配平（源码是 CRLF，不能按 \n}\n 切）。 */
function heroVideoSource(src: string): string {
  const start = src.indexOf("function HeroVideo(");
  expect(start, "landing.tsx 必须保留 function HeroVideo(...)").toBeGreaterThan(-1);
  const open = src.indexOf("{", src.indexOf(")", start));
  expect(open, "HeroVideo 必须有函数体").toBeGreaterThan(start);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    const ch = src[end];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) break;
  }
  expect(depth, "HeroVideo 函数体必须闭合").toBe(0);
  return src.slice(start, end + 1);
}

/** 从 `useEffect(() => {` 起按花括号配平抽出函数体。 */
function extractEffectBodies(src: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("useEffect(() => {");
  while (idx !== -1) {
    const open = src.indexOf("{", idx);
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    out.push(src.slice(open + 1, end));
    idx = src.indexOf("useEffect(() => {", end);
  }
  return out;
}

const HERO = heroVideoSource(SRC);
const SCRUB_BODY = extractEffectBodies(HERO).find((b) => b.includes('addEventListener("mousemove"'));

/** 剥掉 effect 体里的 TS 注解（new Function 只认 JS）。只覆盖本段实际出现的
 *  简单注解；若以后加了更复杂的类型，这里会 SyntaxError 报错，提醒更新测试。 */
function stripTypes(js: string): string {
  return js.replace(/:\s*(number|string|boolean|void|MouseEvent)\b(\s*\|\s*null\b)?/g, "");
}

/** 从源码读 SENSITIVITY，避免测试里硬编码的灵敏度与实现漂移。 */
function sensitivity(src: string): number {
  const m = src.match(/const SENSITIVITY = ([\d.]+)/);
  expect(m, "landing.tsx 必须保留 const SENSITIVITY = <数字>").toBeTruthy();
  return Number(m![1]);
}

type FakeWindow = {
  innerWidth: number;
  addEventListener: (t: string, h: (e: { clientX: number }) => void) => void;
  removeEventListener: (t: string, h: (e: { clientX: number }) => void) => void;
};

/** 在假环境里执行真实的擦洗 effect，返回 mousemove 派发器与清理函数。 */
function runScrub(active: boolean) {
  expect(SCRUB_BODY, "HeroVideo 必须保留挂 window mousemove 的擦洗 effect").toBeTruthy();
  const handlers: Record<string, ((e: { clientX: number }) => void)[]> = {};
  const win: FakeWindow = {
    innerWidth: 1000,
    addEventListener: (t, h) => {
      (handlers[t] ||= []).push(h);
    },
    removeEventListener: (t, h) => {
      handlers[t] = (handlers[t] || []).filter((x) => x !== h);
    },
  };
  let currentTime = 0;
  let writes = 0;
  const videoEvents: Record<string, (() => void)[]> = {};
  const video = {
    duration: 10,
    readyState: 0,
    addEventListener: (t: string, h: () => void) => {
      (videoEvents[t] ||= []).push(h);
    },
    removeEventListener: (t: string, h: () => void) => {
      videoEvents[t] = (videoEvents[t] || []).filter((x) => x !== h);
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(v: number) {
      currentTime = v;
      writes++;
    },
  };
  const activeRef = { current: active };
  /* effect 体首行是 `const video = ref.current;`，所以注入 ref 而不是 video */
  const ref = { current: video };
  expect(SCRUB_BODY, "擦洗 effect 体必须抽到").toBeTypeOf("string");
  const effect = new Function("ref", "activeRef", "window", "SENSITIVITY", stripTypes(SCRUB_BODY!)) as (
    r: unknown,
    a: { current: boolean },
    w: FakeWindow,
    s: number
  ) => () => void;
  const cleanup = effect(ref, activeRef, win, sensitivity(SRC));
  const move = (clientX: number) => {
    for (const h of handlers.mousemove || []) h({ clientX });
  };
  return { video, activeRef, move, cleanup, writes: () => writes };
}

describe("landing.tsx HeroVideo：hero 不可见时停止擦洗 seek", () => {
  it("抽取器确实拿到了擦洗 effect（防止重构后扫描悄悄变空）", () => {
    expect(SCRUB_BODY).toBeTruthy();
    expect(SCRUB_BODY).toContain("addEventListener(\"mousemove\"");
  });

  it("HeroVideo 接受 active 开关，且 Landing 用 pastHero 反向驱动它", () => {
    expect(HERO).toMatch(/function HeroVideo\(\{\s*active\s*\}/);
    expect(SRC).toContain("<HeroVideo active={!pastHero} />");
    /* pastHero 必须仍是「实底容器 top <= 0」的判定，否则开关语义会漂移 */
    expect(SRC).toContain("getBoundingClientRect().top <= 0");
  });

  it("不可见（active=false）时横向移动鼠标不写 currentTime", () => {
    const h = runScrub(false);
    h.move(100);
    h.move(400);
    h.move(900);
    expect(h.video.currentTime).toBe(0);
    expect(h.writes()).toBe(0);
  });

  it("可见（active=true）时横向移动鼠标仍会擦洗（修复没有把功能关死）", () => {
    const h = runScrub(true);
    h.move(100);
    h.move(400);
    expect(h.writes()).toBeGreaterThan(0);
    expect(h.video.currentTime).toBeGreaterThan(0);
  });

  it("不可见期间仍同步 prevX：滚回首屏后首帧移动只按 1px 增量擦洗，不会大跳", () => {
    const h = runScrub(false);
    h.move(100);
    h.move(900); // 不可见期间移动 800px，不得累计
    h.activeRef.current = true;
    h.move(901); // 可见后 1px
    /* 1px / 1000px * 0.8 * 10s = 0.008s，远小于按 800px 计算的 6.4s */
    expect(h.video.currentTime).toBeGreaterThan(0);
    expect(h.video.currentTime).toBeLessThan(0.1);
  });

  it("清理函数仍会移除 window 上的 mousemove（防重复注册）", () => {
    const h = runScrub(true);
    h.cleanup();
    h.move(500);
    expect(h.writes()).toBe(0);
  });
});
