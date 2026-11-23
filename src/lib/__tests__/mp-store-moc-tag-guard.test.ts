import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store withMoc：只覆盖自动生成的目录（MOC tag 回归锁） ============
 * 事故链（miniprogram/utils/store.js withMoc 修复前）：命中判断只看
 * knowledge[j].title === subject + " · 目录"，不校验该条目是否真是自动生成的
 * （从不看 tags:["MOC"]）。用户或 AI 恰好建过一篇标题为「<科目> · 目录」的
 * 普通笔记（如「React · 目录」这类自然命名），且该科目下又有新笔记入库时，
 * 下一次验收通过/读书沉淀（ingestKnowledge → withMoc）就会把用户笔记原文
 * 无声覆盖（nk.body = body 整份替换），不留副本。
 * 修复：命中条件限定 tags 含 "MOC"；tag 不符时另建一张真正的 MOC，
 * 用户笔记保留原文。Web 端 src/lib/store.ts 同语义同步修复（两端同口径）。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const STORE_PATH = join(ROOT, "miniprogram/utils/store.js");
const API_PATH = join(ROOT, "miniprogram/utils/api.js");

let storage: Map<string, unknown>;
let cloudToReturn: any;
let store: any;

function installWxStub() {
  storage = new Map();
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: (k: string) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k: string, v: unknown) => void storage.set(k, v),
    removeStorageSync: (k: string) => void storage.delete(k),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  };
}

function loadStore() {
  for (const p of [STORE_PATH, API_PATH]) delete requireCjs.cache[p];
  const mod = requireCjs(STORE_PATH);
  const api = requireCjs(API_PATH);
  cloudToReturn = {
    data: { goals: [], knowledge: [], books: [], sessions: [], customPersonas: [] },
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
  api.pushCloud = () => Promise.resolve({ updatedAt: "2026-07-01T00:00:00.000Z" });
  api.pullCloud = () => Promise.resolve(cloudToReturn);
  return mod;
}

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const USER_NOTE_TITLE = "React · 目录";

beforeEach(async () => {
  vi.useFakeTimers();
  installWxStub();
  store = loadStore();
  await store.onLogin("u1");
  await flush();
  // 用户手工建的同名笔记（无 MOC tag）+ 同科目普通笔记
  store.state.knowledge = [
    {
      id: "u1-note",
      title: USER_NOTE_TITLE,
      body: "我的手工目录，别动它",
      domain: "React/react",
      tags: ["手工"],
      links: [],
      version: 1,
    },
    {
      id: "k1",
      title: "Hooks 入门",
      body: "正文",
      domain: "React/react",
      tags: [],
      links: [],
      version: 1,
    },
  ];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("mp-store withMoc 同名笔记保护", () => {
  it("用户手工的同名「React · 目录」不被自动索引覆盖，且另建真正的 MOC", () => {
    store.addKnowledgeItems([{ title: "useEffect 要点", body: "b", domain: "React/react" }], "learn", "T");

    const userNote = store.state.knowledge.find((k: any) => k.title === USER_NOTE_TITLE && k.id === "u1-note");
    expect(userNote).toBeTruthy();
    expect(userNote.body).toBe("我的手工目录，别动它"); // 原文一字不动

    const autoMoc = store.state.knowledge.find(
      (k: any) => k.title === USER_NOTE_TITLE && (k.tags || []).includes("MOC"),
    );
    expect(autoMoc).toBeTruthy();
    expect(autoMoc.body).toContain("[[Hooks 入门]]");
    expect(autoMoc.body).toContain("[[useEffect 要点]]");
    expect(autoMoc.id).not.toBe("u1-note");
  });

  it("真正的自动目录（tags 含 MOC）仍被正常重算（修复不误伤）", () => {
    // 先入库一次生成真 MOC
    store.state.knowledge = [
      { id: "k1", title: "Hooks 入门", body: "正文", domain: "React/react", tags: [], links: [], version: 1 },
    ];
    store.addKnowledgeItems([{ title: "useEffect 要点", body: "b", domain: "React/react" }], "learn", "T");
    let moc = store.state.knowledge.find(
      (k: any) => k.title === USER_NOTE_TITLE && (k.tags || []).includes("MOC"),
    );
    expect(moc).toBeTruthy();
    expect(moc.body).toContain("[[Hooks 入门]]");

    // 再入库：MOC 正文按新成员重算
    store.addKnowledgeItems([{ title: "Context 进阶", body: "b2", domain: "React/react" }], "learn", "T");
    moc = store.state.knowledge.find(
      (k: any) => k.title === USER_NOTE_TITLE && (k.tags || []).includes("MOC"),
    );
    expect(moc.body).toContain("[[Context 进阶]]");
  });
});
