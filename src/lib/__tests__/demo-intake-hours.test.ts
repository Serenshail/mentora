import { describe, expect, it, vi } from "vitest";

/* demo.ts 已加 server-only 护栏（防演示脚本误进浏览器包），测试里豁免 */
vi.mock("server-only", () => ({}));

import { demoIntake } from "../ai/demo";
import { goalCardSchema, splitGoalReply } from "../ai/client";

/* 回归锁：demoIntake 的「轮次账」必须与它自己发问的节奏一致。
 * 事实：userTurns[0] 是开场白（「我想学X」），服务端据此发第 1 问；
 * 第 i 问（INTAKE_QUESTIONS[i]）的用户回答因此落在 userTurns[i+1]。
 * 旧实现读 userTurns[2]（= 第 2 问「基础」的回答）提取每周小时数，
 * 第 3 问（INTAKE_QUESTIONS[2]）的回答永远不被读取——用户答「每周5小时」，
 * 目标卡 weeklyHours 却落到默认 8，或误抓基础回答里的「每天学2小时」。
 * 这里把该偏移钉死：任何一端（提问推进 / 小时数取值）错位都会红。 */

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

const u = (content: string) => ({ role: "user" as const, content });

/* 走完 6 问所需的用户轮：开场白 + 6 个回答 = 7 轮（第 7 轮触发目标卡）。
 * 第 2 问（基础）的回答里故意放一个「每天学2小时」——旧实现会把它抓成 weeklyHours=2。 */
const FULL_FLOW = [
  u("我想学Python"),
  u("为了做一个数据分析的小工具"),
  u("零基础，之前卡在循环，每天学2小时"),
  u("每周5小时"),
  u("三个月后"),
  u("能独立做出一个能跑的小工具"),
  u("跟着一个完整项目边做边学"),
];

function cardOf(text: string) {
  const { card } = splitGoalReply(text);
  expect(card).not.toBeNull();
  return goalCardSchema.parse(card);
}

describe("demoIntake 每周小时数：读第 3 问那一轮的回答（不是第 2 问）", () => {
  it("提问推进与回答偏移一致：3 个用户轮后问的是第 3 问（每周小时数）", async () => {
    const out = await drain(demoIntake(FULL_FLOW.slice(0, 3)));
    expect(out).toContain("每周能稳定投入几个小时");
  });

  it("用户答「每周5小时」→ 目标卡 weeklyHours = 5（不是 8，也不是基础回答里的 2）", async () => {
    const out = await drain(demoIntake(FULL_FLOW));
    const card = cardOf(out);
    expect(card.weeklyHours).toBe(5);
    expect(out).toContain("每周 5 小时");
  });

  it("第 3 问回答缺失时回退首句，仍输出 schema 合法的卡（不炸演示链路）", async () => {
    const flow = [u("我想学Python"), u("做小工具"), u("零基础"), u("随便"), u("三个月"), u("能跑"), u("跟项目")];
    const card = cardOf(await drain(demoIntake(flow)));
    expect(card.weeklyHours).toBe(8);
  });

  it("越界数字夹到 schema 边界（[1,80]），否则 splitGoalReply 整卡解析失败、用户看不到卡", async () => {
    const flow = [...FULL_FLOW.slice(0, 3), u("每周200小时"), ...FULL_FLOW.slice(4)];
    const card = cardOf(await drain(demoIntake(flow)));
    expect(card.weeklyHours).toBe(80);

    const zero = [...FULL_FLOW.slice(0, 3), u("每周0小时"), ...FULL_FLOW.slice(4)];
    expect(cardOf(await drain(demoIntake(zero))).weeklyHours).toBe(1);
  });
});
