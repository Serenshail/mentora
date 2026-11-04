import { describe, expect, it } from "vitest";
import { backfillReviewDates, isReviewCandidate, reviewPatch } from "../review";
import type { KnowledgeItem } from "../types";

const base = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: over.id ?? "k1",
  title: over.title ?? "标题",
  body: "正文",
  domain: "React",
  source: over.source ?? "learn",
  sourceTitle: "",
  masteredAt: "2026-01-01",
  reviewStage: 0,
  links: [],
  ...over,
});

describe("backfillReviewDates（旧数据自愈）", () => {
  const today = "2026-10-26";

  it("learn/read 来源缺 nextReviewAt → 回填今天", () => {
    const items = [base({ id: "a", source: "learn" }), base({ id: "b", source: "read" })];
    const out = backfillReviewDates(items, today);
    expect(out.map((k) => k.nextReviewAt)).toEqual([today, today]);
  });

  it("Obsidian 导入与手写笔记保持原样（用户已决定搁置 Obsidian）", () => {
    const items = [
      base({ id: "o", source: "obsidian" }),
      base({ id: "m", source: "manual" }),
    ];
    const out = backfillReviewDates(items, today);
    expect(out).toBe(items); // 无变化返回原引用
    expect(out.some((k) => k.nextReviewAt)).toBe(false);
  });

  it("已有 nextReviewAt 的不覆盖（尊重 FSRS 排期）", () => {
    const items = [base({ id: "x", nextReviewAt: "2026-12-01" })];
    expect(backfillReviewDates(items, today)[0].nextReviewAt).toBe("2026-12-01");
  });

  it("占位与 MOC 永不回填", () => {
    const items = [
      base({ id: "p", unresolved: true }),
      base({ id: "moc", tags: ["MOC"] }),
    ];
    expect(backfillReviewDates(items, today)).toBe(items);
  });

  it("无变化返回原数组引用（避免多余渲染）", () => {
    const items = [base({ id: "ok", nextReviewAt: "2026-01-01" })];
    expect(backfillReviewDates(items, today)).toBe(items);
  });
});

describe("isReviewCandidate", () => {
  it("普通笔记是候选；占位/MOC 不是", () => {
    expect(isReviewCandidate(base({}))).toBe(true);
    expect(isReviewCandidate(base({ unresolved: true }))).toBe(false);
    expect(isReviewCandidate(base({ tags: ["MOC"] }))).toBe(false);
  });
});

describe("reviewPatch（手动加入/移出）", () => {
  it("加入：今天到期、重置轮次", () => {
    const p = reviewPatch(true, "2026-10-26");
    expect(p.nextReviewAt).toBe("2026-10-26");
    expect(p.reviewStage).toBe(0);
    expect(p.lastReviewOk).toBeUndefined();
  });
  it("移出：清空到期日", () => {
    expect(reviewPatch(false, "2026-10-26").nextReviewAt).toBeUndefined();
  });
});
