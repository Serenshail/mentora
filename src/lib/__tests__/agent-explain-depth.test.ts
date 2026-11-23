import { describe, expect, it } from "vitest";
import { decideExplainDepth, wantsDeepExplanation } from "../ai/prompts-lite";

/* ============ ANS-01 讲解深度适配（Q01–Q05） ============
 * 用户的两种相反抱怨必须同时被满足：
 *  「回答不够透彻」（Q01/Q03）与「我只要两句话」（Q05）；
 *  以及「还是不懂」必须换讲法（Q04），不能原样重复。 */

describe("深度判定", () => {
  it("Q05「只用两句话回答，不要出题」→ brief，且指令明确禁止出题/建目标", () => {
    const d = decideExplainDepth("C 里的 malloc 和 calloc 有什么区别？只用两句话回答，不要出题。");
    expect(d.depth).toBe("brief");
    expect(d.instruction).toMatch(/严格按用户给的篇幅上限/);
    expect(d.instruction).toMatch(/不要套讲解骨架、不要出题、不要建目标/);
  });

  it("Q01「请详细讲解…解释为什么这样写」→ deep，要求因果与中间状态", () => {
    const d = decideExplainDepth("请详细讲解下面的代码，解释为什么这样写，不要只翻译代码。");
    expect(d.depth).toBe("deep");
    expect(d.instruction).toMatch(/核心因果/);
    expect(d.instruction).toMatch(/中间状态/);
  });

  it("Q04「还是不懂…别再重复 realloc 那句，换个具体例子」→ reteach（不是 deep）", () => {
    const d = decideExplainDepth("还是不懂。扩容是不是就等于插入？能不能别再重复 realloc 那句，换个具体例子？");
    expect(d.depth).toBe("reteach");
    expect(d.instruction).toMatch(/不要重复上一轮的说法/);
    expect(d.instruction).toMatch(/不要断言用户已经掌握/);
  });

  it("「还是不懂」优先于「详细」——要换讲法而不是写更长", () => {
    const d = decideExplainDepth("还是不懂，请详细一点再讲一遍");
    expect(d.depth).toBe("reteach");
  });

  it("只问概念（是什么/有什么区别）→ standard，不强行推进项目", () => {
    const d = decideExplainDepth("协程和线程有什么区别？");
    expect(d.depth).toBe("standard");
    expect(d.instruction).toMatch(/不要强行推进到项目/);
  });

  it("带图 → deep", () => {
    expect(decideExplainDepth("这图里是什么", { hasImage: true }).depth).toBe("deep");
  });

  it("普通闲聊 → standard（不套骨架）", () => {
    const d = decideExplainDepth("今天天气不错");
    expect(d.depth).toBe("standard");
    expect(d.instruction).toMatch(/不套骨架/);
  });

  it("「别太长」也算 brief（用户嫌啰嗦）", () => {
    expect(decideExplainDepth("给我讲讲闭包，别太长").depth).toBe("brief");
  });
});

describe("与既有 wantsDeepExplanation 的关系", () => {
  it("brief 场景不应被判成 deep（否则 Q05 会套骨架）", () => {
    const q = "C 里的 malloc 和 calloc 有什么区别？只用两句话回答，不要出题。";
    /* 既有函数是「是否进入深讲」的粗判定，用于温度等；新判定负责收束方式 */
    expect(typeof wantsDeepExplanation(q)).toBe("boolean");
    expect(decideExplainDepth(q).depth).toBe("brief");
  });
});
