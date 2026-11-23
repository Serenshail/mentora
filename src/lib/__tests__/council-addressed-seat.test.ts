import { describe, expect, it } from "vitest";
import { resolveAddressedSeat } from "../agent/council-engine";

/* 使用应用实际显示名（独立复测给出的真实参与者数据），而不是短名占位。 */
const SEATS = [
  { id: "naval", name: "Naval Ravikant" },
  { id: "jobs", name: "Steve Jobs" },
  { id: "taleb", name: "Nassim Taleb" },
];

describe("P1 圆桌明确点名识别（实际席位数据）", () => {
  it("短名 + 只请 X 回答 → 唯一命中（独立复测 FAIL 的回归）", () => {
    expect(
      resolveAddressedSeat("这轮只请 Naval 回答，其他席位不要发言。把刚才建议压缩成第一天的一个动作", SEATS)
    ).toBe("naval");
  });

  it("全名 → 命中", () => {
    expect(resolveAddressedSeat("只请 Naval Ravikant 回答", SEATS)).toBe("naval");
  });

  it("姓氏 / 短名 + 来回答 → 命中", () => {
    expect(resolveAddressedSeat("让 Jobs 来回答这个问题", SEATS)).toBe("jobs");
    expect(resolveAddressedSeat("Taleb 回答一下风险在哪", SEATS)).toBe("taleb");
  });

  it("普通圆桌问题（未点名）→ null，保持全员发言", () => {
    expect(resolveAddressedSeat("每周只有三小时，学 Python 先做项目还是先看课？", SEATS)).toBeNull();
  });

  it("同时点名多人 → null（歧义不替用户选人）", () => {
    expect(resolveAddressedSeat("只请 Naval 和 Jobs 回答", SEATS)).toBeNull();
  });

  it("短名只是更长词的一部分时不误命中", () => {
    expect(resolveAddressedSeat("只请 Nav 回答", SEATS)).toBeNull();
  });
});