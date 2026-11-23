import { describe, expect, it, vi } from "vitest";

/* ============ 修复批次 b14：ai 层回归锁 ============
 *  ① demoInsight 的长单段发言（>200 字、段内无空行）必须能被提炼，不能因量化上限整条丢失；
 *  ② reading-assess-grade 的畸形 qa（[null]）必须容错，不能抛 TypeError 直达客户端；
 *  ③ demoRoundtableHost 的席位数必须封顶（names/takes 由请求体原样透传）；
 *  ④ demoRoundtableTake 的 personaId 走原型链时不得抛 TypeError；
 *  ⑤ user-facts：小数时间（每周3.5小时）与「我是+职业」背景必须提取出内容。 */

vi.mock("server-only", () => ({}));

import { demoInsight, demoReadingSystem, demoRoundtableHost, demoRoundtableTake } from "../ai/demo";
import { extractFactsFromMessage, factsToContext } from "../agent/user-facts";

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

describe("demoInsight：长单段用户发言", () => {
  it("210 字单段（无空行）仍能提炼出洞见", async () => {
    const long = "我觉得这里真正关键的并不是作者举的那个例子本身，而是他隐含的一个前提：" +
      "人在没有外部结构的时候会自然滑向最省力的路径，而这个路径往往不是我们理性上想要的那条。" +
      "所以真正的设计不是靠意志力去对抗，而是把环境改成让正确的行为变成最省力的那个选项。" +
      "这一点在我自己身上反复验证过：我买了很多书放在桌上，但真正读完的都是放在床头的那几本，" +
      "不是因为它们更好，而是因为距离更近、启动成本更低。" +
      "所以我现在更相信结构而不是决心，也更愿意花时间在布置环境上。";
    expect(long.length).toBeGreaterThan(200);
    const out = await drain(demoInsight(`## 对话\n用户：${long}\n\n伙伴：那你会怎么改？`));
    const parsed = JSON.parse(out.replace(/^```json\n|\n```$/g, ""));
    expect(parsed.insights).toHaveLength(1);
    expect(parsed.insights[0].body).toContain("结构");
  });

  it("没有用户实质发言时仍返回空数组", async () => {
    const out = await drain(demoInsight("## 对话\n伙伴：你怎么看？"));
    expect(JSON.parse(out.replace(/^```json\n|\n```$/g, ""))).toEqual({ insights: [] });
  });
});

describe("reading-assess-grade：畸形 qa 不得抛原始 TypeError", () => {
  it("qa='[null]' 被容错成一题空答", async () => {
    const out = await drain(demoReadingSystem("reading-assess-grade", { qa: "[null]" }));
    const parsed = JSON.parse(out.replace(/^```json\n|\n```$/g, ""));
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].level).toBe("not");
  });

  it("qa='[null,{\"answer\":\"状态要放在外部\"}]' 保留合法元素", async () => {
    const out = await drain(demoReadingSystem("reading-assess-grade", { qa: '[null,{"answer":"状态要放在外部"}]' }));
    const parsed = JSON.parse(out.replace(/^```json\n|\n```$/g, ""));
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].evidence).toContain("状态要放在外部");
  });
});

describe("demoRoundtableHost：席位上限与 O(n) 切分", () => {
  it("超长 names 只产出封顶数量的席位行", async () => {
    const names = Array.from({ length: 5000 }, (_, i) => `席${i}`).join("、");
    const takes = Array.from({ length: 5000 }, (_, i) => `【席${i}】发言${i}`).join("\n");
    const out = await drain(demoRoundtableHost(names, takes, "要不要辞职"));
    const rows = out.split("\n").filter((l) => l.startsWith("- **席"));
    expect(rows.length).toBe(6);
    expect(rows[0]).toContain("发言0");
  });

  it("正常席位仍逐人摘录发言", async () => {
    const out = await drain(demoRoundtableHost("纳瓦尔、乔布斯", "【纳瓦尔】先找杠杆\n【乔布斯】砍到一件事", "做什么"));
    expect(out).toContain("**纳瓦尔**：先找杠杆");
    expect(out).toContain("**乔布斯**：砍到一件事");
  });
});

describe("demoRoundtableTake：personaId 走原型链不得抛错", () => {
  it("personaId='constructor' 回落到通用立场模板", async () => {
    const out = await drain(demoRoundtableTake("某人", [{ role: "user", content: "要不要创业" }], "constructor"));
    expect(out.length).toBeGreaterThan(20);
  });
  it("内置 personaId 仍用专属语气", async () => {
    const out = await drain(demoRoundtableTake("纳瓦尔", [{ role: "user", content: "要不要创业" }], "naval"));
    expect(out).toContain("杠杆");
  });
});

describe("user-facts：小数时间与身份型背景", () => {
  const msg = (content: string) => ({ id: "m1", role: "user" as const, content, at: "2026-11-01T00:00:00Z" });

  it("「每周3.5小时」能提取时间事实", () => {
    const facts = extractFactsFromMessage(msg("我每周3.5小时，主要放在周末。"));
    const time = facts.find((f) => f.slot === "time");
    expect(time?.value).toContain("3.5");
  });

  it("「每天1.5h」同样命中", () => {
    const facts = extractFactsFromMessage(msg("每天1.5h 应该够了吧。"));
    expect(facts.find((f) => f.slot === "time")?.value).toContain("1.5");
  });

  it("「我是前端工程师」提取出身份内容，而不是空事实", () => {
    const facts = extractFactsFromMessage(msg("我是前端工程师，想补一下算法。"));
    const bg = facts.find((f) => f.slot === "background");
    expect(bg?.value).toContain("前端工程师");
    const ctx = factsToContext(facts);
    expect(ctx).not.toContain("已有基础（用户自述，原话见来源消息）");
  });
});
