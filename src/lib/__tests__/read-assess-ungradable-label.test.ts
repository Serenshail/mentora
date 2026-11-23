import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 验收四级判定展示口径的回归锁 ============
 * 背景：submitAssess 专门实现了 PRD 3.5 的四态语义（ungradable 不计入通过——无法判定
 * 必须换题重考），但渲染层把四态压回三态：结果卡与右栏「最近验收」都只认 mastered/partial、
 * 其余（含 ungradable）一律红色「未过」。用户看到的判定与 toast「有一题无法判定」互相矛盾，
 * 无法判定（题目歧义，责任在出题方）和答错（责任在用户）被同等标红。
 * 修复：结果卡 / 最近验收摘要共用 ASSESS_LEVEL_LABELS（ungradable=「无法判定」）与
 * ASSESS_LEVEL_STYLES（ungradable 用 warn 色，not 才是红色）。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");

describe("ungradable 四态展示", () => {
  it("共用映射里 ungradable=「无法判定」，配色 warn（不与答错同等标红）", () => {
    expect(PAGE).toMatch(/const ASSESS_LEVEL_LABELS: Record<AssessLevel, string> = \{\s*mastered: "通过",\s*partial: "部分",\s*not: "未过",\s*ungradable: "无法判定",\s*\}/);
    expect(PAGE).toMatch(/ungradable: "border-warn\/30 bg-warn\/\[0\.05\]",\s*\n\s*not: "border-bad\/25 bg-bad\/\[0\.04\]",/);
  });

  it("结果卡逐题判定走映射（不再内联三元把 ungradable 压成「未过」）", () => {
    expect(PAGE).toMatch(/\{ASSESS_KIND_LABELS\[r\.kind\]\} · \{ASSESS_LEVEL_LABELS\[r\.level\]\}/);
    expect(PAGE).toMatch(/"rounded-lg border p-2",\s*\n\s*ASSESS_LEVEL_STYLES\[r\.level\]/);
  });

  it("最近验收摘要同样走映射", () => {
    expect(PAGE).toMatch(/最近验收：\$\{ASSESS_KIND_LABELS\[last\.kind\]\} · \$\{ASSESS_LEVEL_LABELS\[last\.level\]\}/);
  });

  it("旧的三态内联写法不再出现", () => {
    expect(PAGE).not.toMatch(/r\.level === "mastered" \? "通过" : r\.level === "partial" \? "部分" : "未过"/);
    expect(PAGE).not.toMatch(/last\.level === "mastered" \? "通过" : last\.level === "partial" \? "部分" : "未过"/);
  });
});
