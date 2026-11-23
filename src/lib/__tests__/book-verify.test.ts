import { describe, expect, it } from "vitest";
import { judgeBookEvidence, type BookSearchHit } from "../book-verify";

const hit = (title: string, url = "https://book.douban.com/subject/1/", snippet = ""): BookSearchHit => ({
  title,
  url,
  snippet,
});

describe("judgeBookEvidence（V26.2-H2 书籍真实性判定）", () => {
  it("可信来源 + 标题含书名前 8 字 → verified", () => {
    const r = judgeBookEvidence("思考，快与慢", "丹尼尔·卡尼曼", [
      hit("思考，快与慢 (豆瓣)", "https://book.douban.com/subject/6515968/", "丹尼尔·卡尼曼"),
    ]);
    expect(r.status).toBe("verified");
    expect(r.credible).toHaveLength(1);
  });

  it("只有无关结果（无图书类来源）→ insufficient", () => {
    const r = judgeBookEvidence("思考快与慢", "", [
      hit("某博客的读书笔记", "https://blog.example.com/si-kao"),
      hit("论坛讨论帖", "https://bbs.example.com/t/123"),
    ]);
    expect(r.status).toBe("insufficient");
    expect(r.credible).toHaveLength(0);
  });

  it("搜索空结果 → insufficient（不判『不存在』，由调用方决定话术）", () => {
    expect(judgeBookEvidence("不存在的书名", "", []).status).toBe("insufficient");
  });

  it("编造作者：真实书名+作者不符 → insufficient（C3/C4 同名不同作者拦截）", () => {
    const r = judgeBookEvidence("活着", "张三三", [
      hit("活着 (豆瓣)", "https://book.douban.com/subject/2763/", "余华"),
    ]);
    expect(r.status).toBe("insufficient");
    expect(r.credible).toHaveLength(1); // 证据在，但与作者不符 → 交弹窗确认
  });

  it("书名带书名号/标点/空格归一化后仍可匹配", () => {
    const r = judgeBookEvidence("《  思考，快与慢！》", "", [hit("思考，快与慢-京东图书")]);
    expect(r.status).toBe("verified");
  });

  it("不能凭前八字相同核实另一本长书名", () => {
    const r = judgeBookEvidence("高性能MySQL第三版完整指南", "", [
      hit("高性能MySQL第三版（图书音像）", "https://item.jd.com/1.html"),
    ]);
    expect(r.status).toBe("insufficient");
  });

  it("可信来源标题不含书名 → insufficient（防止同名无关页面放行）", () => {
    const r = judgeBookEvidence("量子力学导论", "", [
      hit("量子力学发展史 - 百度百科", "https://baike.baidu.com/item/量子力学史"),
    ]);
    expect(r.status).toBe("insufficient");
  });

  it("作者信息在 snippet 里命中也算匹配", () => {
    const r = judgeBookEvidence("影响力", "罗伯特·西奥迪尼", [
      hit("影响力 [图书] 豆瓣", "https://book.douban.com/subject/1/", "罗伯特·西奥迪尼 著"),
    ]);
    expect(r.status).toBe("verified");
  });
});

/* 2026-11-11 搜索链路排查后新增：查询必须是书名单 token（多词查询触发 Bing 反爬降级） */
import { buildVerifyQuery } from "../book-verify";

describe("buildVerifyQuery（EVAL-01 §8：Bing 多词降级规避）", () => {
  it("中文书名单 token", () => {
    expect(buildVerifyQuery("影响力")).toBe("影响力");
  });
  it("去掉书名号与空白", () => {
    expect(buildVerifyQuery("《思考，快与慢》")).toBe("思考，快与慢");
    expect(buildVerifyQuery("Thinking Fast and Slow")).toBe("ThinkingFastandSlow");
  });
  it("不再拼接作者与「书 书籍」后缀（那是多词降级根因）", () => {
    expect(buildVerifyQuery("影响力")).not.toContain("西奥迪尼");
    expect(buildVerifyQuery("影响力")).not.toContain("书");
  });
});

describe("拒绝把笑声和搜索页当图书", () => {
  it("百科笑声不是同名图书", () => expect(judgeBookEvidence("哈哈", "", [hit("哈哈", "https://baike.baidu.com/item/哈哈", "表示笑声")]).status).toBe("insufficient"));
  it("豆瓣搜索结果不是书目条目", () => expect(judgeBookEvidence("哈哈", "", [hit("哈哈", "https://www.douban.com/search?q=哈哈")]).status).toBe("insufficient"));
});
