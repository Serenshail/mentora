import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 extractJson：候选必须覆盖全部括号平衡区与全部围栏块 ============
 * 事故链（miniprogram/utils/chat.js extractJson 修复前，与 Web json.ts 旧算法同病）：
 * 每类括号只从首个出现位置扫一个候选、围栏只取第一个 ``` 块。模型在真 JSON 之前
 * 输出过任何含大括号的示例/说明（「示例：{...}，正式输出如下：{...}」、或第一个
 * 围栏是坏 JSON）时，首个候选 parse 失败后，后面真正的 JSON 永远进不了候选列表，
 * 整体抛「无法从模型输出中解析 JSON」——master plan / 单日细节 / 判分等任务在弱模型
 * 输出下误报失败并要求用户重试。
 * 修复：扫描全部顶层括号平衡区（命中后跳过整块，未闭合则从下一位置重试）+ 全部
 * 围栏块，候选按原文出现位置排序逐一尝试 parse（封顶 CAND_MAX/SCAN_MAX 防病态输入）。
 * Web 端 src/lib/ai/json.ts 是插件 codegen 单一真源，本次未同步增强（小程序端先行），
 * chat.js 头注释已注明两端算法自此分叉。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const CHAT_PATH = join(ROOT, "miniprogram/utils/chat.js");

type Dict = Record<string, unknown>;

function loadChat() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  };
  delete requireCjs.cache[CHAT_PATH];
  return requireCjs(CHAT_PATH) as { extractJson: (t: string) => unknown };
}

describe("mp extractJson 多候选扫描", () => {
  it("真 JSON 前有含大括号的示例：不再整体解析失败", () => {
    const chat = loadChat();
    // 首个大括号区是合法 JSON 但不是任务要的卡：它 parse 成功就直接命中（旧实现亦然）；
    // 关键回归点是「首个候选非法」时后面的真 JSON 仍能被捞到
    expect(chat.extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("首个大括号区非法（示例/说明伪 JSON）+ 后面真 JSON：解析出真 JSON", () => {
    const chat = loadChat();
    const text = '说明：{"badKey": oops} 正式输出如下：{"topic":"T"}';
    expect(chat.extractJson(text)).toEqual({ topic: "T" });
  });

  it("坏对象块里的合法子数组也能被捞到（按原文位置首个合法候选命中）", () => {
    const chat = loadChat();
    const text = '结果：{"list": [1,2], 注意：3} 修正：[{"good":1}]';
    // 旧实现整体抛错；现在按位置逐个试：坏对象之后首个合法候选是子数组 [1,2]
    expect(chat.extractJson(text)).toEqual([1, 2]);
  });

  it("前缀括号未闭合：从未闭合位置重试能捞到真 JSON", () => {
    const chat = loadChat();
    const text = '说明：{oops 没有闭合 修正：{"good":1}';
    expect(chat.extractJson(text)).toEqual({ good: 1 });
  });

  it("第一个围栏块非法、第二个合法：取第二个", () => {
    const chat = loadChat();
    const text = "下面是结果：\n```json\n{oops\n```\n```\n{\"ok\":42}\n```";
    expect(chat.extractJson(text)).toEqual({ ok: 42 });
  });

  it("空围栏不影响后面的裸 JSON", () => {
    const chat = loadChat();
    expect(chat.extractJson("```\n```\n{\"afterFence\":1}")).toEqual({ afterFence: 1 });
  });

  it("裸数组整体优先于首个对象（原有口径不回归）", () => {
    const chat = loadChat();
    expect(chat.extractJson('[{"a":1},{"b":2}]')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("完全没有 JSON：仍抛同一句错误", () => {
    const chat = loadChat();
    expect(() => chat.extractJson("完全没有 JSON")).toThrow("无法从模型输出中解析 JSON");
  });

  it("病态输入（60k 未闭合大括号）在扫描封顶内完成，不死循环", () => {
    const chat = loadChat();
    const text = "{".repeat(60000);
    const t0 = Date.now();
    expect(() => chat.extractJson(text)).toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
