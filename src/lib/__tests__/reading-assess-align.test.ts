import { describe, expect, it } from "vitest";
import { alignAssessResults, type AssessQuestion } from "../reading-assess";

/* 回归锁：三重验收判分结果与出题的逐题对齐。
 * 缺陷：readingAssessGradeSchema 只保证 results ≥1 条，页面旧实现 slice(0, questions.length)，
 * 少回时通过阈值失真（回 1 条恒不过）、回 2 条要求全 mastered、kind 错序时 question/answer 张冠李戴。 */

const Q3: AssessQuestion[] = [
  { kind: "explain", question: "解释核心主张" },
  { kind: "connect", question: "和前面什么关系" },
  { kind: "apply", question: "哪里用得上" },
];

const r = (kind: AssessQuestion["kind"], level: "mastered" | "partial" | "not" | "ungradable", feedback = "") => ({
  kind,
  level,
  evidence: "",
  feedback,
});

describe("alignAssessResults", () => {
  it("完整三题、顺序打乱 → 按 kind 对齐回出题顺序（question/answer 不串）", () => {
    const out = alignAssessResults(Q3, [r("apply", "mastered", "应用好"), r("explain", "partial", "解释一般"), r("connect", "mastered", "联系好")]);
    expect(out.map((x) => x.kind)).toEqual(["explain", "connect", "apply"]);
    expect(out[0].feedback).toBe("解释一般");
    expect(out[2].feedback).toBe("应用好");
  });

  it("模型少回一条 → 缺失题记 ungradable，长度仍等于题数（不再让阈值失真）", () => {
    const out = alignAssessResults(Q3, [r("explain", "mastered")]);
    expect(out).toHaveLength(3);
    expect(out.map((x) => x.level)).toEqual(["mastered", "ungradable", "ungradable"]);
    // 对齐后长度=3 → 阈值 max(2, ceil(3*0.66)) = 2，与「三题 2/3」口径一致
    expect(Math.max(2, Math.ceil(out.length * 0.66))).toBe(2);
  });

  it("只回两条且都 mastered → 第三条 ungradable，不因少回而被算作全通过", () => {
    const out = alignAssessResults(Q3, [r("explain", "mastered"), r("connect", "mastered")]);
    expect(out).toHaveLength(3);
    expect(out[2].level).toBe("ungradable");
    expect(out.some((x) => x.level === "ungradable")).toBe(true);
  });

  it("模型多回 / kind 不在出题里 → 丢弃，长度不超题数", () => {
    const out = alignAssessResults(Q3, [r("explain", "mastered"), r("connect", "mastered"), r("apply", "mastered"), r("apply", "not")]);
    expect(out).toHaveLength(3);
    // 第二个 apply 被丢弃，第一条 apply 保留
    expect(out[2].level).toBe("mastered");
  });

  it("两题同 kind → first-unused 分别匹配，不共用一个结果", () => {
    const qs: AssessQuestion[] = [
      { kind: "explain", question: "q1" },
      { kind: "explain", question: "q2" },
    ];
    const out = alignAssessResults(qs, [r("explain", "mastered", "第一"), r("explain", "not", "第二")]);
    expect(out.map((x) => x.level)).toEqual(["mastered", "not"]);
    expect(out.map((x) => x.feedback)).toEqual(["第一", "第二"]);
  });

  it("结果全缺失 → 全部 ungradable（不会假装通过）", () => {
    const out = alignAssessResults(Q3, []);
    expect(out.every((x) => x.level === "ungradable")).toBe(true);
    expect(out.every((x) => x.kind === "explain" || x.kind === "connect" || x.kind === "apply")).toBe(true);
  });
});
