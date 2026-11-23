import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 store：读书页的记录类数组必须有上限 ============
 * 事故链（utils/store.js addChapterAssessment / addBookDeposit / markChapterMastered
 * 以及 createBookFromPlan 的 pastedText）：
 *   同步是**全量快照**，服务端 4.2MB 硬拒（src/app/api/sync/route.ts
 *   MAX_BODY_BYTES），微信 setStorageSync 单 key 还有 1MB 上限。上面这些数组都是
 *   无界 concat，重度使用读书伙伴/粘贴长材料后迟早撞穿 → saveLocal 抛错被吞、
 *   本机缓存静默停写，此后所有编辑只活在内存里（quizLog / 消息数组已因同一原因修过）。
 * 修法：记录数组按 BOOK_RECORD_MAX 裁剪，pastedText 落库前截断。
 *
 * 本测试真执行 store.js（stub wx 存储）。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

let storage: Map<string, unknown>;
let store: any;

function loadStore() {
  storage = new Map();
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: (k: string) => (storage.has(k) ? storage.get(k) : ""),
    setStorageSync: (k: string, v: unknown) => void storage.set(k, v),
    removeStorageSync: (k: string) => void storage.delete(k),
    showToast: () => {},
  };
  const utils = join(ROOT, "miniprogram/utils");
  for (const f of ["store.js", "util.js", "api.js", "mastery.js"]) {
    delete requireCjs.cache[join(utils, f)];
  }
  return requireCjs(join(utils, "store.js"));
}

function newBook(store: any, pasted = "") {
  return store.createBookFromPlan("书", "作者", pasted, { chapters: [{ title: "第一章" }] }, "verified");
}

beforeEach(() => {
  store = loadStore();
});

describe("mp-store 记录数组上限", () => {
  it("addChapterAssessment 超过上限只保留最近 N 条（最新一条一定在）", () => {
    const id = newBook(store);
    for (let i = 0; i < 260; i++) {
      store.addChapterAssessment(id, {
        chapterId: "c0-0",
        kind: "explain",
        question: "第" + i + "题",
        answer: "答",
        level: "partial",
      }, i % 3 === 0 ? { concept: "概念" + i, note: "n" } : null);
    }
    const b = store.bookById(id);
    expect(b.assessments.length).toBeLessThanOrEqual(200);
    expect(b.assessments[0].question).toBe("第259题");
    expect(b.assessments[0].question).not.toBe("第0题");
    // 学习档案同步受限
    expect(b.learning.misconceptions.length).toBeLessThanOrEqual(200);
  });

  it("addBookDeposit 同样受限，unresolvedQuestions 也不无界增长", () => {
    const id = newBook(store);
    for (let i = 0; i < 260; i++) {
      store.addBookDeposit(id, { type: "question", text: "问题" + i });
    }
    const b = store.bookById(id);
    expect(b.deposits.length).toBeLessThanOrEqual(200);
    expect(b.deposits[0].text).toBe("问题259");
    expect(b.learning.unresolvedQuestions.length).toBeLessThanOrEqual(200);
  });

  it("markChapterMastered 的 evidence 数组受限", () => {
    const id = newBook(store);
    const chapterId = store.bookById(id).chapters[0].id;
    for (let i = 0; i < 260; i++) {
      store.markChapterMastered(id, chapterId, "证据" + i);
    }
    const b = store.bookById(id);
    expect(b.learning.evidence.length).toBeLessThanOrEqual(200);
    // 追加型数组必须保尾部（最新证据），不能把最新的一批裁掉只留最早的
    expect(b.learning.evidence[b.learning.evidence.length - 1].text).toBe("证据259");
  });

  it("建档时粘贴的原文落库前截断（页面已限 6000 字，但接口本身不能无界）", () => {
    const huge = "x".repeat(60000);
    const id = newBook(store, huge);
    const b = store.bookById(id);
    expect(b.pastedText.length).toBeLessThan(60000);
    expect(b.pastedText.length).toBeLessThanOrEqual(20000);
    expect(b.pastedText.startsWith("xxx")).toBe(true);
  });
});
