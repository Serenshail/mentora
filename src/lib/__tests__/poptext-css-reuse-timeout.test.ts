import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePopTextCss } from "@/lib/use-poptext";

/* ============ 复用失败残留 CSS link 时不得永久挂起（回归锁） ============
 * 背景：usePopText 的 css 等待原先在「head 里已有 <link data-poptext-css>」分支
 * 只挂 load 监听（if (existing.sheet) resolve(); else addEventListener("load", …)）。
 * 若这条 link 是更早一次挂载中加载失败（404/断网）的残留——它的 onerror 早已
 * 触发过、link 又没被移除——后到的任何实例都收不到 load，await 永久挂起，
 * load() 卡死，setFailed 永不执行；两个调用方（login-form.tsx 与 landing.tsx）
 * 都是 {failed && "Mentora"}，于是品牌 h1 在 failed 置位前没有任何文本子节点，
 * 一次 CSS 失败后同 tab SPA 跳到另一个用 usePopText 的页面即永久空白。
 *
 * 修复：把 css 等待抽成 ensurePopTextCss(doc) —— load / error / 8s 超时三选一
 * 先到先收口，复用分支同样监听 error；新建 link 失败或复用 link 超时即 remove()，
 * 不再把「已错过 error 的残留」留给下一个实例。
 *
 * vitest 无 jsdom：沿用本仓库既有做法，注入最小假 Document/link 真实执行逻辑，
 * 断言行为（是否 resolve、resolve 值、link 是否被摘除），而非只匹配源码字符串。 */

type Listener = () => void;

function makeLink(opts: { sheet?: unknown } = {}) {
  const listeners: Record<string, Listener[]> = {};
  const link = {
    sheet: opts.sheet ?? null,
    removed: false,
    attrs: {} as Record<string, string>,
    rel: "",
    href: "",
    onload: null as null | Listener,
    onerror: null as null | Listener,
    setAttribute(k: string, v: string) {
      link.attrs[k] = v;
    },
    addEventListener(type: string, fn: Listener) {
      (listeners[type] ||= []).push(fn);
    },
    remove() {
      link.removed = true;
    },
    fire(type: string) {
      for (const fn of listeners[type] ?? []) fn();
    },
    listenerCount(type: string) {
      return (listeners[type] ?? []).length;
    },
  };
  return link;
}

function makeDoc(existing: ReturnType<typeof makeLink> | null) {
  const appended: ReturnType<typeof makeLink>[] = [];
  const doc = {
    querySelector(sel: string) {
      expect(sel).toBe('link[data-poptext-css]');
      return existing;
    },
    createElement(tag: string) {
      expect(tag).toBe("link");
      const l = makeLink();
      appended.push(l);
      return l;
    },
    head: {
      appendChild(node: ReturnType<typeof makeLink>) {
        appended.push(node);
      },
    },
  };
  return { doc: doc as unknown as Document, appended };
}

/** 让 ensurePopTextCss 的 promise 落地，返回 { value }；挂起则 value 为 SENTINEL。 */
const PENDING = Symbol("pending");
async function settle(p: Promise<boolean>): Promise<boolean | typeof PENDING> {
  const probe = Promise.resolve(PENDING);
  return Promise.race([p, probe]) as Promise<boolean | typeof PENDING>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ensurePopTextCss", () => {
  it("复用已有且 sheet 就绪的 link：立即 resolve true，不再加监听", async () => {
    const existing = makeLink({ sheet: {} });
    const { doc } = makeDoc(existing);
    await expect(ensurePopTextCss(doc)).resolves.toBe(true);
    expect(existing.listenerCount("load")).toBe(0);
    expect(existing.listenerCount("error")).toBe(0);
  });

  it("复用早先失败残留的 link：收到 error 即 resolve false（不再永久挂起）", async () => {
    const existing = makeLink({ sheet: null });
    const { doc } = makeDoc(existing);
    const p = ensurePopTextCss(doc);
    expect(await settle(p)).toBe(PENDING); // 尚未有事件，确实在等
    existing.fire("error");
    await expect(p).resolves.toBe(false);
    expect(existing.listenerCount("load")).toBe(1);
    expect(existing.listenerCount("error")).toBe(1);
    expect(existing.removed).toBe(true); // 报错的残留不再留给下一个实例
  });

  it("复用 link 但 load 与 error 都不来（残留/弱网卡死）：超时后 resolve false 并摘除该 link", async () => {
    vi.useFakeTimers();
    const existing = makeLink({ sheet: null });
    const { doc } = makeDoc(existing);
    const p = ensurePopTextCss(doc);
    expect(await settle(p)).toBe(PENDING);
    vi.advanceTimersByTime(8000);
    await expect(p).resolves.toBe(false);
    expect(existing.removed).toBe(true);
  });

  it("复用 link 在超时瞬间 sheet 已就绪：resolve true 且不摘除", async () => {
    vi.useFakeTimers();
    const existing = makeLink({ sheet: null });
    const { doc } = makeDoc(existing);
    const p = ensurePopTextCss(doc);
    existing.sheet = {}; // 弱网下刚好加载完
    vi.advanceTimersByTime(8000);
    await expect(p).resolves.toBe(true);
    expect(existing.removed).toBe(false);
  });

  it("复用 link 收到 load：resolve true", async () => {
    const existing = makeLink({ sheet: null });
    const { doc } = makeDoc(existing);
    const p = ensurePopTextCss(doc);
    existing.fire("load");
    await expect(p).resolves.toBe(true);
  });

  it("新建 link：失败时 resolve false 且从 head 摘除（不把残留留给下一个实例）", async () => {
    const { doc, appended } = makeDoc(null);
    const p = ensurePopTextCss(doc);
    const link = appended[0];
    expect(link.href).toContain("/poptext/pop-text.css");
    expect(link.attrs["data-poptext-css"]).toBe("1");
    link.onerror!();
    await expect(p).resolves.toBe(false);
    expect(link.removed).toBe(true);
  });

  it("新建 link：成功时 resolve true 且不移除", async () => {
    const { doc, appended } = makeDoc(null);
    const p = ensurePopTextCss(doc);
    const link = appended[0];
    link.sheet = {};
    link.onload!();
    await expect(p).resolves.toBe(true);
    expect(link.removed).toBe(false);
  });

  it("新建 link 卡死（load/error 都不来）：超时后 resolve false 并摘除自己建的 link", async () => {
    vi.useFakeTimers();
    const { doc, appended } = makeDoc(null);
    const p = ensurePopTextCss(doc);
    const link = appended[0];
    vi.advanceTimersByTime(8000);
    await expect(p).resolves.toBe(false);
    expect(link.removed).toBe(true);
  });
});
