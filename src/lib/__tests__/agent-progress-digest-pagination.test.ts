import { describe, expect, it } from "vitest";
import { digestOf } from "../agent/progress-guard";

/* 回归锁：结果指纹必须能区分「分页读取的相邻两页」。
 * 旧 digestOf = 头 120 + 尾 60 + 40 字长度桶：list_goals 这类分页结果首条目重叠、
 * 尾部同为闭合括号，两页会撞成同一指纹，被误判「换了参数但结果相同（无新信息）」，
 * 累计 stalledStreak 让合法的多页读取被提前放弃。 */

function pad(s: string, n: number) {
  return s.repeat(Math.ceil(n / s.length)).slice(0, n);
}

describe("digestOf 不把分页读取误判为同一结果", () => {
  it("短结果按整串比较：任何真实差异都能区分", () => {
    expect(digestOf("没有相关笔记。")).not.toBe(digestOf("找到 1 篇笔记。"));
  });

  it("分页结果（首尾相同、仅中段不同）指纹不同", () => {
    const head = '{"total":60,"allCount":60,"offset":';
    const tail = ',"goals":[]}';
    const page1 = head + '0' + pad("A", 200) + tail;
    const page2 = head + '25' + pad("B", 200) + tail;
    /* 旧实现：两页头 120 相同、尾 60 相同、长度同一 40 字桶 → 指纹相同 */
    expect(digestOf(page1)).not.toBe(digestOf(page2));
  });

  it("长结果长度相差很小但中部内容不同 → 指纹不同", () => {
    const base = pad("x", 400);
    const a = base + "AAA" + pad("y", 400);
    const b = base + "BBB" + pad("y", 400);
    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it("仅空白差异仍视为同一结果（保持既有取舍）", () => {
    const a = pad("内容 ", 100);
    const b = pad("内容\n", 100);
    expect(digestOf(a)).toBe(digestOf(b));
  });
});
