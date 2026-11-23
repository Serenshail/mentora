import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：读书对话的 mode 直接来自客户端 args（任意字符串），
 * 旧实现在 api/chat/route.ts:151 用 `s("mode") as never` 断言绕过 ReadingMode 联合类型，
 * 只剩 prompts.ts 的 `MODE_RULES[mode] ?? MODE_RULES.socratic` 兜底。但 MODE_RULES 是
 * 普通对象，索引会走原型链：mode="constructor"/"toString" 取到继承的函数对象，
 * `??` 拦不住 undefined 以外的情况——系统提示词里会拼进
 * `function Object() { [native code] }`，且 modeSwitchNote 还会把原样 mode 插进提示词。
 *
 * 修复：白名单收窄（reading-modes.ts normalizeReadingMode）+ prompts.ts 侧
 * Object.hasOwn 纵深防御（与 ai-config.ts:58 同一纪律）。本文件钉住三件事：
 *  A) 非法 mode 一律 null，绝不放行到提示词；
 *  B) 五个合法 id 原样通过；
 *  C) 即使调用方漏了白名单，READING_MODE_CHAT 也不会把原型链函数拼进提示词。 */

import { normalizeReadingMode, READING_MODES } from "../ai/reading-modes";
import { READING_MODE_CHAT, READING_RAG_BLOCK } from "../ai/prompts";

describe("normalizeReadingMode 白名单", () => {
  it("五个合法模式原样通过", () => {
    for (const m of READING_MODES) {
      expect(normalizeReadingMode(m.id)).toBe(m.id);
    }
  });

  it("原型链键与非字符串一律 null", () => {
    for (const bad of ["constructor", "toString", "__proto__", "hasOwnProperty", "", "苏格拉底", 1, null, undefined, {}]) {
      expect(normalizeReadingMode(bad)).toBeNull();
    }
  });
});

describe("READING_MODE_CHAT 纵深防御：原型链键不得拼进系统提示词", () => {
  it("mode=constructor 回落到 socratic 规则，不出现原生函数源码", () => {
    const sys = READING_MODE_CHAT("constructor" as never, "本书档案");
    expect(sys).not.toContain("[native code]");
    expect(sys).toContain("【模式一 · 苏格拉底引导】");
  });

  it("合法模式仍取到自己的规则", () => {
    expect(READING_MODE_CHAT("feynman", "ctx")).toContain("【模式二 · 费曼讲桌】");
    expect(READING_MODE_CHAT("recall-check", "ctx")).toContain("【模式五 · 复盘检验】");
  });
});

describe("READING_RAG_BLOCK 与共享证据纪律同源", () => {
  it("含 EVIDENCE_DISCIPLINE 的五条纪律（含「绝不说你笔记里提到过」）", () => {
    const block = READING_RAG_BLOCK("笔记正文");
    expect(block).toContain("笔记正文");
    expect(block).toContain("绝不说");
    expect(block).toContain("你笔记里提到过");
    expect(block).toContain("证据互相矛盾时明确说出矛盾点");
  });
});
