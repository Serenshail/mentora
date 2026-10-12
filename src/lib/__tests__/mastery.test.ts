import { describe, expect, it } from "vitest";
import { advanceMastery, masteryFromQuiz, masteryFromReview } from "../mastery";

/* 掌握状态机回归锁（v17 拆纯 + 复习接线）：
 * 评审发现"transferable/durable 两级无任何代码路径可达、复习对掌握零影响"——
 * 本文件把修复钉死：判分能到 transferable，复习能到 durable，且从紧不降级。 */

describe("advanceMastery", () => {
  it("无提示答对只到 independent；apply/build 证据可直达 transferable", () => {
    expect(advanceMastery("unknown", undefined, "correct", 0).next).toBe("independent");
    expect(
      advanceMastery("unknown", undefined, "correct", 0, { applyEvidence: true }).next
    ).toBe("transferable");
  });

  it("提示等级封顶：L1-L4 → guided，L5 → 原题不升级过 exposed", () => {
    expect(advanceMastery("independent", "independent", "correct", 3).next).toBe("independent"); // 不降级历史
    expect(advanceMastery("unknown", undefined, "correct", 2).next).toBe("guided");
    expect(advanceMastery("unknown", undefined, "correct", 5).next).toBe("exposed");
  });

  it("ungradable 不产生任何证据；incorrect 不降级已有证据", () => {
    expect(advanceMastery("guided", "independent", "ungradable", undefined).next).toBe("guided");
    expect(advanceMastery("independent", undefined, "incorrect", undefined).next).toBe("independent");
  });
});

describe("masteryFromQuiz", () => {
  it("取最弱证据（从紧不从松）", () => {
    expect(
      masteryFromQuiz([
        { verdict: "correct", hintLevel: 0, kind: "apply" },
        { verdict: "correct", hintLevel: 0, kind: "explain" },
      ])
    ).toBe("independent"); // 最弱一题封顶 independent
    expect(
      masteryFromQuiz([
        { verdict: "correct", hintLevel: 0, kind: "apply" },
        { verdict: "partially_correct", hintLevel: 0, kind: "explain" },
      ])
    ).toBe("guided");
  });

  it("全 apply 无提示 → transferable（此前不可达的一级）", () => {
    expect(
      masteryFromQuiz([
        { verdict: "correct", hintLevel: 0, kind: "apply" },
        { verdict: "correct", hintLevel: 0, kind: "build" },
      ])
    ).toBe("transferable");
  });

  it("单日永不到 durable", () => {
    expect(masteryFromQuiz([{ verdict: "correct", hintLevel: 0 }])).not.toBe("durable");
  });
});

describe("masteryFromReview（v17 复习→掌握接线）", () => {
  it("通过逐步升级：unknown→guided→independent→durable", () => {
    expect(masteryFromReview("unknown", true, 1, 1)).toBe("guided");
    expect(masteryFromReview("guided", true, 2, 7)).toBe("independent");
    expect(masteryFromReview("independent", true, 4, 21)).toBe("durable");
    expect(masteryFromReview("transferable", true, 5, 30)).toBe("durable");
  });

  it("条件不足不升级：通过数或稳定度未达标", () => {
    expect(masteryFromReview("guided", true, 1, 5)).toBe("guided");
    expect(masteryFromReview("independent", true, 3, 21)).toBe("independent");
    expect(masteryFromReview("independent", true, 4, 10)).toBe("independent");
  });

  it("失败永不降级（遗忘由 FSRS 重排处理，不否定历史证据）", () => {
    expect(masteryFromReview("independent", false, 3, 30)).toBe("independent");
    expect(masteryFromReview("durable", false, 9, 90)).toBe("durable");
  });
});
