import { describe, expect, it } from "vitest";
import { buildVerifyQuery, explainBookCandidates, isCredibleSource, judgeBookEvidence } from "../book-verify";

const TPP = {
  title: "The Pragmatic Programmer: Your Journey to Mastery",
  url: "https://www.pragprog.com/titles/tpp20/",
  snippet: "by David Thomas and Andrew Hunt. The Pragmatic Programmer, 20th Anniversary Edition.",
};

describe("P1 真实书目核验：出版社官网准入", () => {
  it("pragprog.com 被识别为可信来源", () => {
    expect(isCredibleSource("https://pragprog.com/titles/tpp20/")).toBe(true);
    expect(isCredibleSource("https://www.pragprog.com/titles/tpp20/")).toBe(true);
    expect(isCredibleSource("https://evil-pragprog.com/titles/tpp20/")).toBe(false);
  });

  it("出版社官网 + 英文书名 + 多作者 → verified", () => {
    const r = judgeBookEvidence("The Pragmatic Programmer", "David Thomas and Andrew Hunt", [TPP]);
    expect(r.status).toBe("verified");
    expect(r.credible).toHaveLength(1);
  });

  it("作者写法差异（逗号分隔）仍可 verified", () => {
    const r = judgeBookEvidence("The Pragmatic Programmer", "David Thomas and Andrew Hunt", [
      { ...TPP, snippet: "David Thomas, Andrew Hunt. 20th Anniversary Edition." },
    ]);
    expect(r.status).toBe("verified");
  });

  it("虚构书没有任何可信来源 → insufficient", () => {
    const r = judgeBookEvidence("如何用三天学会量子引力", "张三", [
      { title: "如何用三天学会量子引力 - 某博客", url: "https://blog.example.com/post/1", snippet: "张三" },
    ]);
    expect(r.status).toBe("insufficient");
  });

  it("真实书名 + 编造作者 → insufficient（不放宽）", () => {
    const r = judgeBookEvidence("The Pragmatic Programmer", "John Doe", [TPP]);
    expect(r.status).toBe("insufficient");
  });

  it("单 token 查询去空格与书名号（保留既有 Bing 规避策略）", () => {
    expect(buildVerifyQuery("《The Pragmatic Programmer》")).toBe("ThePragmaticProgrammer");
    expect(buildVerifyQuery("Thinking Fast and Slow")).toBe("ThinkingFastandSlow");
  });
});
describe("P1 书目候选逐条拒绝原因（独立复测要求）", () => {
  it("豆瓣标题匹配但作者不符 → author-mismatch；知乎/镜像 → 非可信来源", () => {
    const reasons = explainBookCandidates("The Pragmatic Programmer", "David Thomas and Andrew Hunt", [
      { title: "The Pragmatic Programmer (豆瓣)", url: "https://book.douban.com/subject/1417047/", snippet: "作者：某人" },
      { title: "The Pragmatic Programmer 中文镜像", url: "https://daabin.github.io/The-Pragmatic-Programmer/zh-CN/", snippet: "David Thomas" },
      { title: "《The Pragmatic Programmer》解读", url: "https://zhuanlan.zhihu.com/p/697291893", snippet: "Andrew Hunt" },
      { ...TPP },
    ]);
    expect(reasons.map((r) => r.reason)).toEqual(["author-mismatch", "not-credible-host", "not-credible-host", "accepted"]);
  });

  it("虚构书：所有候选都被拒，无 accepted", () => {
    const reasons = explainBookCandidates("如何用三天学会量子引力", "张三", [
      { title: "如何用三天学会量子引力", url: "https://blog.example.com/p/1", snippet: "张三" },
    ]);
    expect(reasons.every((r) => r.reason !== "accepted")).toBe(true);
  });
});
