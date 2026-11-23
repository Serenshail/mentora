import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { isCredibleSource, judgeBookEvidence, type BookSearchHit } from "../book-verify";

/* ============ 可信书目来源必须按域名判定，不能按标题/URL 关键词（回归锁） ============
 * 旧实现用 /豆瓣|百科|…|book|douban|…/i 对 r.title + " " + r.url 做子串匹配：
 * "facebook.com"、"booking.com"、"notebook.example.com" 一律命中裸 `book`；
 * 一条标题含书名前 8 字的 Facebook 读书会帖（"《思考，快与慢》读书会"）即可同时
 * 满足 CREDIBLE_SOURCE 与 normalizeTitle 前缀匹配 → 零真实书目证据（无出版社/
 * 百科/馆藏）也被判 verified。而 verified 是唯一允许"正式生成"并打标的路径
 * （book-verify.ts:8-10），被穿透的恰是代价更高的一侧。
 * 修复：改为 URL host 白名单（含子域），文本关键词不再参与判定。 */

const hit = (title: string, url: string, snippet = ""): BookSearchHit => ({ title, url, snippet });

describe("isCredibleSource：域名白名单（不做文本关键词匹配）", () => {
  it("facebook/booking/notebook 等无关域即使标题含书名也不是可信来源", () => {
    expect(isCredibleSource("https://www.facebook.com/groups/123/")).toBe(false);
    expect(isCredibleSource("https://www.booking.com/hotel/cn/x.html")).toBe(false);
    expect(isCredibleSource("https://notebook.example.com/a")).toBe(false);
    expect(isCredibleSource("https://blog.example.com/si-kao")).toBe(false);
  });

  it("图书平台和馆藏可以核实书目，百科与维基不能", () => {
    expect(isCredibleSource("https://book.douban.com/subject/1/")).toBe(true);
    expect(isCredibleSource("https://item.jd.com/1.html")).toBe(true);
    expect(isCredibleSource("https://baike.baidu.com/item/x")).toBe(false);
    expect(isCredibleSource("https://zh.wikipedia.org/wiki/x")).toBe(false);
    expect(isCredibleSource("https://openlibrary.org/works/OL1W")).toBe(true);
    expect(isCredibleSource("https://www.worldcat.org/title/1")).toBe(true);
  });

  it("后缀伪装域不算可信来源（evil-douban.com / douban.com.evil.example）", () => {
    expect(isCredibleSource("https://evil-douban.com/subject/1/")).toBe(false);
    expect(isCredibleSource("https://douban.com.evil.example/subject/1/")).toBe(false);
    expect(isCredibleSource("https://notdouban.com/subject/1/")).toBe(false);
  });

  it("大小写/www/端口不影响判定；非 http(s) 与空 URL 一律不可信", () => {
    expect(isCredibleSource("HTTPS://BOOK.DOUBAN.COM:443/subject/1/")).toBe(true);
    expect(isCredibleSource("https://www.douban.com/subject/1/")).toBe(true);
    expect(isCredibleSource("javascript:alert(1)")).toBe(false);
    expect(isCredibleSource("")).toBe(false);
  });
});

describe("judgeBookEvidence：UGC 页面不得穿透 verified", () => {
  it("Facebook 读书会帖（标题含书名）+ 无真实书目证据 → insufficient", () => {
    const r = judgeBookEvidence("思考，快与慢", "", [
      hit("《思考，快与慢》读书会", "https://www.facebook.com/groups/123/"),
    ]);
    expect(r.status).toBe("insufficient");
    expect(r.credible).toHaveLength(0);
  });

  it("booking.com / notebook 页即便标题含书名也不计入 credible", () => {
    const r = judgeBookEvidence("思考快与慢", "", [
      hit("思考快与慢", "https://www.booking.com/hotel/cn/x.html"),
      hit("思考快与慢笔记", "https://notebook.example.com/a"),
    ]);
    expect(r.status).toBe("insufficient");
    expect(r.credible).toHaveLength(0);
  });

  it("真实书目来源仍判 verified（不被收紧误伤）", () => {
    const r = judgeBookEvidence("思考，快与慢", "丹尼尔·卡尼曼", [
      hit("思考，快与慢 (豆瓣)", "https://book.douban.com/subject/6515968/", "丹尼尔·卡尼曼"),
    ]);
    expect(r.status).toBe("verified");
  });
});

describe("小程序端同判据（双端一致，不能只修 Web）", () => {
  /* 小程序 pages/learn/learn.js 复制了一份同样的过滤逻辑（CommonJS + wx 环境，
   * 无法 import TS），因此用静态扫描锁住：裸关键词正则不得复活，且必须走
   * isCredibleSource(r.url) 的域名判定。 */
  const MP = readFileSync(join(process.cwd(), "miniprogram/pages/learn/learn.js"), "utf8");

  it("小程序不再用标题/URL 关键词正则判定可信来源", () => {
    expect(MP).not.toMatch(/\|book\|/);
    expect(MP).not.toContain("豆瓣|百科|出版社");
    expect(MP).toContain("function isCredibleSource(url)");
    expect(MP).toContain("isCredibleSource(r.url)");
  });
});
