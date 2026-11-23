import { describe, expect, it } from "vitest";
import { relevantSearchResults } from "../search-relevance";

describe("search relevance", () => {
  const results = [
    { title: "2026年节假日安排", snippet: "国务院办公厅通知" },
    { title: "2026年世界杯", snippet: "足球赛事" },
    { title: "2026 PUBG UNITED", snippet: "电竞比赛" },
    { title: "英语四级听力真题", snippet: "CET-4 考试练习" },
    { title: "英语六级听力", snippet: "CET-6 考试练习" },
  ];
  it("rejects irrelevant year results and a different exam", () => {
    expect(relevantSearchResults("2026年英语四级听力", results).map((result) => result.title)).toEqual(["英语四级听力真题"]);
  });
  it("rejects queries with only a year", () => {
    expect(relevantSearchResults("2026年", results)).toEqual([]);
  });
});
