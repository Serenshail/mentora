import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 小程序状态点 tone → WXSS 类必须存在（回归锁） ============
 * 事故：miniprogram/pages/goal/goal.js 的 STATUS_META 把 locked 映射为 tone:"dim"，
 * goal.wxml:44 渲染 class="dot dot-{{ph.tone}}"；但 app.wxss 的 .dot 基类只给尺寸
 * 不给背景色，tone 类在重构（48f8602 把 .dot-dim 改名 .dot-idle）后只剩
 * .dot-ok/-warn/-bad/-accent/-idle。于是最常见的「未解锁」阶段渲染成一个透明圆点，
 * 状态点在视觉上完全消失（learn.wxml:52 的 dim 目标卡同病）。
 * 这里锁两件事：数据层产出的每个 tone 都有 .dot-<tone> 背景色；.dot 基类保持无背景，
 * 防止有人用「给基类兜底色」的方式掩盖漏定义。 */

const root = join(process.cwd(), "miniprogram");
const appWxss = readFileSync(join(root, "app.wxss"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出某选择器规则体的声明文本；未定义返回 null */
function ruleBody(selector: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`
  );
  const m = appWxss.match(re);
  return m ? m[1] : null;
}

/** 从数据文件里抓 tone: "xxx" 的字面量（STATUS_META / tone 三元分支） */
function tonesIn(rel: string): Set<string> {
  const src = readFileSync(join(root, rel), "utf8");
  const out = new Set<string>();
  for (const m of src.matchAll(/tone:\s*"([\w-]+)"/g)) out.add(m[1]);
  // learn.js:157 的三元写法 `tone: g.status === "active" ? "accent" : ... : "dim"`
  for (const m of src.matchAll(/\?\s*"([\w-]+)"\s*:\s*[\w.]+ === "[\w-]+"\s*\?\s*"([\w-]+)"\s*:\s*"([\w-]+)"/g)) {
    out.add(m[1]);
    out.add(m[2]);
    out.add(m[3]);
  }
  return out;
}

describe("小程序状态点 tone 与 WXSS 类一致", () => {
  it(".dot 基类不给背景色（tone 类缺失时必须暴露出来，而不是被兜底掩盖）", () => {
    const base = ruleBody(".dot");
    expect(base).not.toBeNull();
    expect(base).not.toMatch(/background/);
  });

  it("goal.js STATUS_META 的每个 tone 都有 .dot-<tone> 且带背景色", () => {
    const tones = tonesIn("pages/goal/goal.js");
    // STATUS_META 四态：locked/active/passed/skipped
    expect([...tones].sort()).toEqual(["accent", "dim", "ok", "warn"]);
    for (const tone of tones) {
      const body = ruleBody(`.dot-${tone}`);
      expect(body, `缺少 .dot-${tone}（goal.wxml:44 会渲染透明圆点）`).not.toBeNull();
      expect(body).toMatch(/background\s*:/);
    }
  });

  it("learn.js 目标卡 tone 也有对应 .dot 类（learn.wxml:52 同时渲染 badge 与 dot）", () => {
    const tones = tonesIn("pages/learn/learn.js");
    // 目标状态映射：active→accent / done→ok / 其余(draft,paused)→dim
    expect(tones.has("accent")).toBe(true);
    expect(tones.has("ok")).toBe(true);
    expect(tones.has("dim")).toBe(true);
    for (const tone of tones) {
      expect(ruleBody(`.dot-${tone}`), `缺少 .dot-${tone}`).not.toBeNull();
    }
  });

  it("dim 点使用 --faint 灰（与 .badge-dim / 网页 StatusDot 的浅灰同口径）", () => {
    expect(ruleBody(".dot-dim")).toMatch(/var\(--faint\)/);
  });
});
