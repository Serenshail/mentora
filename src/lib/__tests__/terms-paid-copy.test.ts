import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 用户协议 §5 与付费实然行为对齐的回归锁 ============
 * 背景：§5 写「免费期间不收取费用；未来如提供付费功能，会提前单独征得同意」，但产品
 * 当前已是付费制：membership 页售卖 ¥9.9/月、¥99/年，注册强制填激活码（一张激活码开
 * 一个账号），到期自动降级为免费档（数据保留、AI 受限）。privacy 页注释明确要求法务页
 * 「与产品实然行为对齐」，terms 页未同步——任何用户读条款 §5 即见失实承诺。 */

const TERMS = readFileSync(join(process.cwd(), "src/app/terms/page.tsx"), "utf8");

describe("terms §5 收费条款与产品实然一致", () => {
  it("不再有「免费期间不收取费用」的失实承诺", () => {
    expect(TERMS).not.toContain("免费期间不收取费用");
    expect(TERMS).not.toContain("未来如提供付费功能");
  });

  it("如实描述激活码付费制与价格（对齐 pricing.ts 9.9/99）", () => {
    expect(TERMS).toContain("付费制");
    expect(TERMS).toContain("激活码");
    expect(TERMS).toContain("¥9.9");
    expect(TERMS).toContain("¥99");
    expect(TERMS).toContain("从当天开始计时");
  });

  it("到期降级与 BYOK 语义与实然行为一致（数据保留 / AI 受限 / 自带 Key 费用自负）", () => {
    expect(TERMS).toContain("降级为免费档");
    expect(TERMS).toContain("数据与导出永远保留");
    expect(TERMS).toContain("模型费用由你自行承担");
  });
});
