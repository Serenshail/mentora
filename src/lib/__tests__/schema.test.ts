import { describe, expect, it } from "vitest";
import { phasePlanSchema } from "../ai/client";

/* 回归:学习教练"生成天级计划/任务"曾因资源元数据 schema 过严而整体 parse 失败。
 * 模型常把 year 写成字符串/带"年"、kind 自由发挥、evergreen 写成 "true"、验收 kind 写中文——
 * 这些可选/枚举字段必须容错降级,绝不能拖垮整个计划生成。 */
describe("phasePlanSchema 容错解析(脏元数据不炸)", () => {
  const base = (resources: unknown, acceptance: unknown) => ({
    boundary: "只学核心",
    days: [{ title: "Day 1", knowledgePoints: ["kp"], resources, method: "m", acceptance }],
  });

  it("year 为字符串/带年、kind 未知、evergreen 字符串 → 仍解析成功", () => {
    const parsed = phasePlanSchema.parse(
      base(
        [{ title: "t", url: "https://x", why: "w", year: "2025年", kind: "video", evergreen: "true" }],
        [{ kind: "理解", question: "q" }, { kind: "build", question: "q2" }]
      )
    );
    const r = parsed.days[0]!.resources[0]!;
    expect(r.year).toBe(2025);
    expect(r.kind).toBe("video");
    expect(r.evergreen).toBe(true);
    expect(parsed.days[0]!.acceptance[0]!.kind).toBe("apply"); // 未知验收 kind 兜底为 apply
  });

  it("元数据完全缺失 → 也解析成功", () => {
    const parsed = phasePlanSchema.parse(
      base([{ title: "t", why: "w" }], [{ kind: "explain", question: "q" }, { kind: "apply", question: "q2" }])
    );
    expect(parsed.days[0]!.resources[0]!.year).toBeUndefined();
  });
});
