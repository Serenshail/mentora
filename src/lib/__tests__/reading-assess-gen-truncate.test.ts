import { describe, expect, it } from "vitest";
import { readingAssessGenSchema } from "../ai/client";

/* 回归锁：验收出题「多了截断少了报错」。
 * 注释一直这么写，但此前实现是 .min(2).max(5)——模型给 6 条**题面都有效**的题会被整体拒绝，
 * 页面 catch 回退到与章节内容无关的本地通用三题（比截断更差的降级）。
 * 现在 schema 内部截到 3 题；少于 2 题仍视为无效输出。 */

const q = (kind: string, question: string) => ({ kind, question });

describe("readingAssessGenSchema：多给题就截断", () => {
  it("6 条有效题不再整体失败，截到 3 条", () => {
    const parsed = readingAssessGenSchema.parse({
      questions: [q("explain", "a"), q("connect", "b"), q("apply", "c"), q("explain", "d"), q("connect", "e"), q("apply", "f")],
    });
    expect(parsed.questions).toHaveLength(3);
    expect(parsed.questions.map((x) => x.question)).toEqual(["a", "b", "c"]);
  });

  it("4-5 条同样截到 3 条", () => {
    expect(
      readingAssessGenSchema.parse({ questions: [q("explain", "a"), q("connect", "b"), q("apply", "c"), q("apply", "d")] }).questions
    ).toHaveLength(3);
  });

  it("少于 2 条仍报错（无效输出不硬凑）", () => {
    expect(() => readingAssessGenSchema.parse({ questions: [q("explain", "a")] })).toThrow();
    expect(() => readingAssessGenSchema.parse({ questions: [] })).toThrow();
  });

  it("kind 非法回落 explain", () => {
    const parsed = readingAssessGenSchema.parse({ questions: [q("random", "a"), q("connect", "b")] });
    expect(parsed.questions[0].kind).toBe("explain");
  });
});
