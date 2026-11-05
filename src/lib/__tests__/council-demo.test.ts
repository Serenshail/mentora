import { describe, expect, it, vi } from "vitest";

/* demo.ts 已加 server-only 护栏（防演示脚本误进浏览器包），测试里豁免 */
vi.mock("server-only", () => ({}));

import { demoRoundtableTake, demoRoundtableHost } from "../ai/demo";

/* 圆桌 Demo 同语义回归锁（R1）：无 API Key 时三席必须立场可辨，
 * 主持人必须真正引用席位并输出七节结构——不许退化为 demoCouncil 单人回答 */

async function drain(gen: AsyncGenerator<string>) {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

describe("demoRoundtableTake（席位差异化）", () => {
  const msgs = [{ role: "user" as const, content: "要不要辞职去做独立产品" }];

  it("内置席位按本人语言指纹发言（不是通用模板）", async () => {
    const naval = await drain(demoRoundtableTake("Naval", msgs, "naval"));
    const jobs = await drain(demoRoundtableTake("Steve Jobs", msgs, "jobs"));
    const taleb = await drain(demoRoundtableTake("Nassim Taleb", msgs, "taleb"));
    expect(naval).toContain("不需要许可");
    expect(jobs).toContain("说不");
    expect(taleb).toContain("最坏");
    expect(new Set([naval, jobs, taleb]).size).toBe(3);
    // 发言引用本轮问题
    expect(naval).toContain("要不要辞职去做独立产品");
  });

  it("自建/未知席位回退立场模板，同桌立场仍互异", async () => {
    const takes = await Promise.all(
      ["王阳明", "苏格拉底", "达芬奇"].map((n) => drain(demoRoundtableTake(n, msgs, "custom:x")))
    );
    expect(new Set(takes).size).toBe(3);
    for (const t of takes) expect(t).toContain("前提");
  });
});

describe("demoRoundtableHost（真综合）", () => {
  it("逐席引用 + 七节结构齐全", async () => {
    const out = await drain(
      demoRoundtableHost(
        "Naval、乔布斯、塔勒布",
        "【Naval】可以做，但先把账算清……\n\n【乔布斯】现在别做……\n\n【塔勒布】取决于缓冲……",
        "要不要辞职去做独立产品"
      )
    );
    for (const n of ["Naval", "乔布斯", "塔勒布"]) expect(out).toContain(n);
    for (const sec of [
      "问题重构",
      "逐人立场",
      "共识",
      "真分歧",
      "遗漏的视角",
      "条件化建议",
      "改判信号",
    ]) {
      expect(out).toContain(sec);
    }
  });
});
