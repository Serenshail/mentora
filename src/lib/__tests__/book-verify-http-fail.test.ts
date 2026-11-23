import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBook, type BookSearchHit } from "../book-verify";

/* 回归锁：/api/search 的 HTTP 失败（401/429/502）不得折进「无可信来源」。
 * 修复前 verifyBook 不查 res.ok，错误响应 {error} 被解析成 results undefined →
 * hits=[] → judgeBookEvidence 判 insufficient，调用方把服务故障包装成
 * 「我们搜索了…没有找到可信的图书来源」——429 配额用尽/502 上游故障时用户
 * 看到的是「书不存在」话术，违反 book-verify.ts:11 的自述纪律
 * （搜索失败 ≠ 书不存在）。修复后 HTTP 失败向上抛，由调用方 catch 走
 * unsearchable 话术（「核查服务暂时不可用」，read-workspace.tsx 与
 * tool-executors.ts 的既有 catch 分支）。 */

const okResults = {
  results: [
    { title: "思考，快与慢 (豆瓣)", url: "https://book.douban.com/subject/6515968/", snippet: "丹尼尔·卡尼曼" },
  ] as BookSearchHit[],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyBook：HTTP 失败向上抛（不折进 insufficient）", () => {
  it("429 配额用尽 → throw（旧实现会返回 insufficient）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "今日搜索次数已用完，明天恢复。" }, { status: 429 })
      )
    );
    await expect(verifyBook("思考，快与慢", "丹尼尔·卡尼曼")).rejects.toThrow(
      /429[\s\S]*今日搜索次数已用完/
    );
  });

  it("502 上游不可用 → throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "搜索上游不可用（bing 403）" }, { status: 502 }))
    );
    await expect(verifyBook("活着", "余华")).rejects.toThrow(/502/);
  });

  it("401 未登录 → throw（错误体解析失败时也要抛）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 }))
    );
    await expect(verifyBook("活着的意义", "")).rejects.toThrow(/404/);
  });

  it("200 有可信结果 → 正常 verified（不被误伤）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(okResults)));
    const r = await verifyBook("思考，快与慢", "丹尼尔·卡尼曼");
    expect(r.status).toBe("verified");
    expect(r.credible).toHaveLength(1);
  });

  it("200 空结果 → 仍 insufficient（真「无可信来源」语义保留）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: [] })));
    const r = await verifyBook("不存在的书名", "");
    expect(r.status).toBe("insufficient");
  });
});
