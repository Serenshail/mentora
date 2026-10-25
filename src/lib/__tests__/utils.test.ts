import { describe, expect, it } from "vitest";
import { rankResources, KIND_LABEL, addDays, daysBetween, streakFrom, todayISO } from "../utils";
import type { Resource } from "../types";

describe("rankResources（新近+实用优先、经典降权）", () => {
  const rs: Resource[] = [
    { title: "经典旧书", why: "", kind: "classic", year: 1990, evergreen: true },
    { title: "新官方文档", why: "", kind: "doc", year: 2025 },
    { title: "旧教程", why: "", kind: "tutorial", year: 2016 },
  ];
  it("官方/新资料排前,经典沉底", () => {
    const out = rankResources(rs);
    expect(out[0].title).toBe("新官方文档");
    expect(out[out.length - 1].title).toBe("经典旧书");
  });
  it("evergreen 一律最后", () => {
    const out = rankResources([rs[0], { title: "新视频课", why: "", kind: "course", year: 2024 }]);
    expect(out[out.length - 1].evergreen).toBe(true);
  });
  it("KIND_LABEL 覆盖主要类型", () => {
    expect(KIND_LABEL.doc).toBeTruthy();
    expect(KIND_LABEL.repo).toBeTruthy();
  });
});

describe("addDays/daysBetween（纯 UTC 日历运算，时区无关）", () => {
  it("任意时区下 +1 天就是下一个日历日（旧实现东八区会原地踏步/跳天）", () => {
    expect(addDays(1, "2026-10-24")).toBe("2026-10-25");
    expect(addDays(-1, "2026-10-24")).toBe("2026-10-23");
    // 跨月/跨年滚动
    expect(addDays(-1, "2026-01-01")).toBe("2025-12-31");
    expect(addDays(1, "2026-02-28")).toBe("2026-03-01");
  });
  it("加减互逆", () => {
    const d = "2026-06-15";
    expect(addDays(-1, addDays(1, d))).toBe(d);
  });
  it("daysBetween 按日历日算差", () => {
    expect(daysBetween("2026-10-24", "2026-10-25")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2026-10-25", "2026-10-24")).toBe(-1);
  });
  it("非法日期不炸，返回今天/0", () => {
    expect(daysBetween("abc", "2026-10-24")).toBe(0);
    expect(addDays(1, "not-a-date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("streakFrom（连续学习天数）", () => {
  const today = todayISO();
  it("连续三天 = 3（旧实现东八区只在隔日链上匹配，3 天显示 2）", () => {
    const dates = [today, addDays(-1, today), addDays(-2, today)];
    expect(streakFrom(dates)).toBe(3);
  });
  it("昨天断了就断链", () => {
    const dates = [today, addDays(-2, today), addDays(-3, today)];
    expect(streakFrom(dates)).toBe(1);
  });
  it("今天没学不打断连击，从昨天起数", () => {
    const dates = [addDays(-1, today), addDays(-2, today)];
    expect(streakFrom(dates)).toBe(2);
  });
  it("空记录 = 0", () => {
    expect(streakFrom([])).toBe(0);
  });
});
