import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序笔记页「脏条目缺 title」渲染回归锁 ============
 * 事故链（miniprogram/pages/note/note.js render）：
 *  1. store.adoptCloud（miniprogram/utils/store.js:176-187）把云端快照的
 *     knowledge 数组原样收下，不做逐条校验；历史版本/脏快照可能带来没有
 *     title 的条目。
 *  2. render() 里 k.body / k.domain / k.tags 都有 `|| ""` 兜底，唯独
 *     `wx.setNavigationBarTitle({ title: k.title.slice(0, 12) })` 直接调用
 *     k.title.slice —— title 为 undefined 时抛 TypeError，整页渲染中断。
 *  3. 这行本来也是无效调用：app.json 全局 navigationStyle: custom，标题由
 *     note.wxml:3 的自绘 <nav-bar title="{{note ? note.title : '笔记'}}"/> 展示。
 * 修法：删掉这行无效且会崩的调用；setData 的 title 与同对象其它字段一样兜底。
 *
 * 这里不扫源码文本，而是把真实 CommonJS 页面模块加载进来跑：stub 掉
 * wx / Page，用 store.state 直接摆出脏条目。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

interface MpKnowledge {
  id: string;
  title?: string;
  body?: string;
  domain?: string;
  tags?: string[];
  links?: string[];
  masteryStatus?: string;
}

interface StoreMod {
  state: { knowledge: MpKnowledge[] };
}

interface PageCtx {
  data: Record<string, unknown> & { note?: { id: string; title: string } | null };
  setData: (patch: Record<string, unknown>) => void;
  render: () => void;
}

type PageConfig = PageCtx & Record<string, unknown>;

let navTitles: string[] = [];
let pageCfg: PageConfig;
let store: StoreMod;

function installWxStub() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    setNavigationBarTitle: (o: { title: string }) => {
      navTitles.push(String(o.title));
    },
    showToast: () => {},
    setClipboardData: () => {},
    redirectTo: () => {},
  };
}

function loadNotePage() {
  if (!store) store = requireCjs(join(ROOT, "miniprogram/utils/store.js")) as StoreMod;
  const notePath = requireCjs.resolve(join(ROOT, "miniprogram/pages/note/note.js"));
  delete requireCjs.cache[notePath];
  let captured: PageConfig | null = null;
  (globalThis as unknown as Record<string, unknown>).Page = (cfg: PageConfig) => {
    captured = cfg;
  };
  requireCjs(notePath);
  if (!captured) throw new Error("note.js 未调用 Page()");
  pageCfg = captured;
}

function makePage(noteId: string): PageCtx {
  const page = Object.assign({}, pageCfg) as PageCtx;
  page.data = JSON.parse(JSON.stringify(pageCfg.data)) as PageCtx["data"];
  page.setData = function (patch: Record<string, unknown>) {
    Object.assign(this.data, patch);
  };
  (page as unknown as { noteId: string }).noteId = noteId;
  return page;
}

beforeEach(() => {
  navTitles = [];
  installWxStub();
  loadNotePage();
  store.state.knowledge = [];
});

afterEach(() => {
  store.state.knowledge = [];
});

describe("mp-note-render: 知识条目缺 title 不再让整页渲染崩溃", () => {
  it("脏条目（无 title）：render 不抛异常，笔记照常渲染出来", () => {
    store.state.knowledge = [{ id: "k1", body: "正文", tags: ["a"] }];
    const page = makePage("k1");

    expect(() => page.render()).not.toThrow();
    expect(page.data.note).not.toBeNull();
    expect(page.data.note?.id).toBe("k1");
    // 与同 setData 对象里 domain/sourceTitle/tags/body 一致：缺失即空串，不留 undefined
    expect(page.data.note?.title).toBe("");
    expect(page.data.chips).toEqual([{ text: "#a", tone: "dim" }]);
  });

  it("脏条目（无 title）作为出链目标：同样不崩，链接仍按 id 列出", () => {
    store.state.knowledge = [
      { id: "k1", title: "有标题", body: "", links: ["k2"] },
      { id: "k2", body: "" },
    ];
    const page = makePage("k1");

    expect(() => page.render()).not.toThrow();
    const outLinks = page.data.outLinks as { id: string; title?: string }[];
    expect(outLinks.map((l) => l.id)).toEqual(["k2"]);
  });

  it("正常条目：标题原样进入 data，且不再调用无效的 wx.setNavigationBarTitle", () => {
    store.state.knowledge = [{ id: "k1", title: "费曼学习法", body: "# 正文" }];
    const page = makePage("k1");
    page.render();

    expect(page.data.note?.title).toBe("费曼学习法");
    // 全局自定义导航（app.json navigationStyle: custom）：这行调用没有可见效果，已删
    expect(navTitles).toEqual([]);
  });

  it("笔记不存在：仍走空态（note=null），行为未被改动", () => {
    const page = makePage("nope");
    page.render();
    expect(page.data.note).toBeNull();
  });
});
