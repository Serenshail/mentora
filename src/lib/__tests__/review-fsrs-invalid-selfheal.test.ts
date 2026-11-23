import { beforeEach, describe, expect, it } from "vitest";

if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
    configurable: true,
  });
}

import { DEFAULT_SETTINGS, useAppStore } from "../store";
import type { FsrsState, KnowledgeItem } from "../types";

/* ============ fsrs 脏数据必须自愈，不能让单笔记复习永久坏死 ============
 * 旧实现 toFsrsCard 直接 `new Date(k.fsrs.due)`：非法日期 → Invalid Date 送进 ts-fsrs，
 * recordReview 在 `c.due.toISOString()` 抛 RangeError，set 不执行、异常被调用方
 * （brain/page.tsx）catch 吞成「评分服务暂不可用」，该笔记重试永远失败、无自愈。
 * 现在：非法 fsrs 一律视为「无 fsrs」回落 createEmptyCard + reviewStage 预热；
 * sanitizeBackup 也丢掉非法 fsrs 字段。 */

const seed = (over: Partial<KnowledgeItem>) =>
  useAppStore.setState({
    knowledge: [
      {
        id: "k1",
        title: "测试笔记",
        body: "",
        domain: "数学",
        source: "manual",
        sourceTitle: "",
        masteredAt: "2026-01-01",
        reviewStage: 0,
        links: [],
        ...over,
      },
    ],
    settings: { ...DEFAULT_SETTINGS },
  });

const badFsrs = (over: Partial<FsrsState>): FsrsState =>
  ({
    st: 2,
    dif: 5,
    stb: 3,
    elapsed: 0,
    scheduled: 0,
    reps: 1,
    lapses: 0,
    due: "不是日期",
    last: null,
    ...over,
  }) as FsrsState;

beforeEach(() => {
  useAppStore.setState({ knowledge: [], goals: [], customPersonas: [] });
});

describe("recordReview 对非法 fsrs 自愈", () => {
  it("due 为垃圾串时不抛异常，且写回合法的 fsrs/nextReviewAt", () => {
    seed({ fsrs: badFsrs({}) });
    expect(() => useAppStore.getState().recordReview("k1", true)).not.toThrow();
    const k = useAppStore.getState().knowledge.find((x) => x.id === "k1")!;
    expect(k.fsrs).toBeTruthy();
    expect(Number.isFinite(new Date(k.fsrs!.due).getTime())).toBe(true);
    expect(typeof k.nextReviewAt).toBe("string");
    expect(k.nextReviewAt!.length).toBeGreaterThan(0);
  });

  it("数值字段为 NaN/Infinity 时同样不抛异常", () => {
    seed({ fsrs: badFsrs({ stb: Number.NaN, dif: Number.POSITIVE_INFINITY }) });
    expect(() => useAppStore.getState().recordReview("k1", false)).not.toThrow();
    const k = useAppStore.getState().knowledge.find((x) => x.id === "k1")!;
    expect(Number.isFinite(new Date(k.fsrs!.due).getTime())).toBe(true);
  });

  it("非法 last 也不会污染 last_review", () => {
    seed({ fsrs: badFsrs({ due: "2026-02-01T00:00:00.000Z", last: "坏值" }) });
    expect(() => useAppStore.getState().recordReview("k1", true)).not.toThrow();
    const k = useAppStore.getState().knowledge.find((x) => x.id === "k1")!;
    expect(Number.isFinite(new Date(k.fsrs!.due).getTime())).toBe(true);
  });
});

describe("sanitizeBackup 丢掉非法 fsrs、保留合法 fsrs", () => {
  it("非法 fsrs 被丢弃", () => {
    expect(
      useAppStore.getState().importData({
        knowledge: [
          { id: "k1", title: "n", body: "", links: [], fsrs: badFsrs({}) },
        ],
      })
    ).toBe(true);
    const k = useAppStore.getState().knowledge.find((x) => x.id === "k1")!;
    expect(k.fsrs).toBeUndefined();
  });

  it("合法 fsrs 原样保留", () => {
    const valid: FsrsState = {
      st: 2,
      dif: 5,
      stb: 3,
      elapsed: 0,
      scheduled: 5,
      reps: 3,
      lapses: 0,
      due: "2026-02-01T00:00:00.000Z",
      last: "2026-01-01T00:00:00.000Z",
    };
    expect(
      useAppStore.getState().importData({
        knowledge: [{ id: "k1", title: "n", body: "", links: [], fsrs: valid }],
      })
    ).toBe(true);
    const k = useAppStore.getState().knowledge.find((x) => x.id === "k1")!;
    expect(k.fsrs).toEqual(valid);
  });
});
