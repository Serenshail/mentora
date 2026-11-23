import { describe, expect, it } from "vitest";
import {
  activeFacts,
  correctedSlots,
  extractFactsFromMessage,
  factsToContext,
  mergeFacts,
  type UserFact,
} from "../agent/user-facts";

/* ============ CTX-01 关键事实提取与更正（Q06 / C01 / C02） ============
 * 用户的两个真实抱怨：
 *  1) 早就说过目的/基础/时间，聊十几轮后又问一遍（Q06 forbidden：再次问已知目的/基础/时间）；
 *  2) 把「每周 3 小时」改成「每周 5 小时」后，模型仍按 3 小时排（C02：采用 5 小时，标记旧事实已替代）。
 * 这里锁的是确定性行为，不依赖模型。 */

const msg = (id: string, content: string, at = "2026-11-12T10:00:00.000Z") =>
  ({ id, role: "user" as const, content, at });

describe("从用户原话提取事实", () => {
  it("一句里同时有基础/目的/时间，三类都提取到", () => {
    const facts = extractFactsFromMessage(
      msg("m1", "我会 Python；学线性代数是为了看懂机器学习论文；每周只有3小时。以后给建议时请按这个背景。")
    );
    const slots = facts.map((f) => f.slot).sort();
    expect(slots).toEqual(["background", "purpose", "time"]);
    const time = facts.find((f) => f.slot === "time")!;
    expect(time.quote).toContain("每周只有3小时");
    expect(time.messageId).toBe("m1");
  });

  it("assistant 的复述不算用户事实", () => {
    const facts = extractFactsFromMessage({
      id: "m2",
      role: "assistant",
      content: "你会 Python，每周只有 3 小时。",
      at: "2026-11-12T10:01:00.000Z",
    });
    expect(facts).toEqual([]);
  });

  it("否定句不当正向事实（「我不学 Rust」不是「学 Rust」）", () => {
    const facts = extractFactsFromMessage(msg("m3", "我不学 Rust，也不想学 Go。"));
    expect(facts).toEqual([]);
  });

  it("超长粘贴内容不做事实提取（避免噪声）", () => {
    const facts = extractFactsFromMessage(msg("m4", "我会 Python。".repeat(200)));
    expect(facts).toEqual([]);
  });

  it("每条事实都带来源 messageId 与时间（可追溯）", () => {
    const facts = extractFactsFromMessage(msg("m5", "我是零基础新手，每周能投入 5 个小时。", "2026-11-12T11:00:00.000Z"));
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.messageId).toBe("m5");
      expect(f.at).toBe("2026-11-12T11:00:00.000Z");
    }
  });
});

describe("事实更正：旧值被替代，上下文只出现最新值（C02 核心）", () => {
  it("3 小时 → 5 小时：只保留 5 小时，旧的标 superseded", () => {
    const a = extractFactsFromMessage(msg("m1", "每周只有3小时。", "2026-11-12T10:00:00.000Z"));
    const b = extractFactsFromMessage(msg("m2", "时间更新一下：现在每周可以5小时，旧的3小时不要再用了。", "2026-11-12T10:10:00.000Z"));
    const merged = mergeFacts(mergeFacts([], a), b);

    const timeFacts = merged.filter((f) => f.slot === "time");
    expect(timeFacts.length).toBe(2);
    expect(timeFacts.filter((f) => f.superseded).length).toBe(1);

    const active = activeFacts(merged).filter((f) => f.slot === "time");
    expect(active).toHaveLength(1);
    expect(active[0].value).toContain("5");

    /* 上下文里绝不能同时出现 3 小时与 5 小时 */
    const ctx = factsToContext(merged);
    expect(ctx).toContain("5");
    expect(ctx).not.toMatch(/3\s*小时/);
  });

  it("同一句重复出现不重复记", () => {
    const a = extractFactsFromMessage(msg("m1", "每周只有3小时。"));
    const again = extractFactsFromMessage(msg("m2", "每周只有3小时。"));
    const merged = mergeFacts(mergeFacts([], a), again);
    expect(merged.filter((f) => f.slot === "time")).toHaveLength(1);
  });

  it("同一消息里同 slot 多句只留最后一句", () => {
    const facts = extractFactsFromMessage(msg("m1", "每周只有3小时。现在改成每周5小时。"));
    const merged = mergeFacts([], facts);
    const act = activeFacts(merged).filter((f) => f.slot === "time");
    expect(act).toHaveLength(1);
    expect(act[0].value).toContain("5");
  });

  it("correctedSlots 报出被更正的槽位（供提示模型「旧值已作废」）", () => {
    const merged = mergeFacts(
      mergeFacts([], extractFactsFromMessage(msg("m1", "每周只有3小时。", "2026-11-12T10:00:00.000Z"))),
      extractFactsFromMessage(msg("m2", "现在改成每周5小时。", "2026-11-12T10:10:00.000Z"))
    );
    expect(correctedSlots(merged)).toContain("time");
  });
});

describe("上下文装配", () => {
  it("按重要性排序，且明确告诉模型「不要重复询问」", () => {
    const merged = mergeFacts(
      [],
      extractFactsFromMessage(msg("m1", "我会 Python；学线性代数是为了看懂机器学习论文；每周只有3小时。"))
    );
    const ctx = factsToContext(merged);
    expect(ctx).toMatch(/不要重复询问/);
    const iPurpose = ctx.indexOf("目的");
    const iTime = ctx.indexOf("每周可投入");
    expect(iPurpose).toBeGreaterThan(-1);
    expect(iPurpose).toBeLessThan(iTime); // purpose 排在 time 前
  });

  it("没有事实时返回空串（不塞空标题）", () => {
    expect(factsToContext([])).toBe("");
  });

  it("猜测量/模型建议不会被当成用户事实（只有用户原话进得来）", () => {
    const onlyAssistant = [
      { id: "a1", role: "assistant" as const, content: "你可能每周有 5 小时。", at: "2026-11-12T10:00:00.000Z" },
    ];
    const facts = onlyAssistant.flatMap((m) => extractFactsFromMessage(m));
    expect(facts).toEqual([]);
  });
});
