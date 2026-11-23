import { describe, expect, it } from "vitest";
import { filterCitationsForAnswer, isContentUrl } from "../citation-match";

const ANSWER =
  "推荐两条：https://www.bilibili.com/video/BV1xx411c7mD 和 https://www.bilibili.com/video/BV1yy411c7mE 。其余略。";

describe("P1 引用逐条对应", () => {
  it("只保留正文实际提到的内容页", () => {
    const out = filterCitationsForAnswer(
      [
        { title: "BV1xx", url: "https://www.bilibili.com/video/BV1xx411c7mD" },
        { title: "BV1yy", url: "https://www.bilibili.com/video/BV1yy411c7mE" },
        { title: "Python 官网", url: "https://www.python.org/" },
        { title: "B 站首页", url: "https://www.bilibili.com/" },
      ],
      ANSWER
    );
    expect(out.map((c) => c.url)).toEqual([
      "https://www.bilibili.com/video/BV1xx411c7mD",
      "https://www.bilibili.com/video/BV1yy411c7mE",
    ]);
  });

  it("首页/搜索页即使被正文提到也剔除", () => {
    expect(isContentUrl("https://www.bilibili.com/")).toBe(false);
    expect(isContentUrl("https://www.python.org/search?q=x")).toBe(false);
    expect(isContentUrl("https://www.bilibili.com/video/BV1xx411c7mD")).toBe(true);
  });

  it("正文为空时不给任何引用", () => {
    expect(filterCitationsForAnswer([{ url: "https://a.example.com/p/1" }], "")).toEqual([]);
  });
});