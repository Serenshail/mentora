import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 三重验收作答草稿持久化的回归锁 ============
 * 背景：同页把 transfer/recheck/hintShown 落 localStorage（practiceKey）并在下次进入时
 * 恢复，说明团队把「作答无声丢失」当作要防的损失（openAssess 覆盖未提交作答还专门
 * confirm）；但三重验收的作答只存在组件 state——三道 Textarea 写完长答案后误触
 * PageBackBar / 刷新 / 路由切换，三题作答全部丢失，只能对照可复用的题目重写。
 * 修复：assess 纳入同一份 practiceKey 草稿（写入 + 恢复），指向已不存在章节
 * （路线重排换 id）的僵尸草稿不恢复。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");
const draftBlock = PAGE.slice(PAGE.indexOf("const practiceKey"), PAGE.indexOf("const scrollToPractice"));

describe("assess 草稿与 transfer/recheck 同等待遇", () => {
  it("恢复分支：读回 assess 且校验章节仍存在（僵尸草稿不占位）", () => {
    expect(draftBlock).toMatch(/if \(draft\?\.assess\) \{/);
    expect(draftBlock).toMatch(/chapters\.some\(\(c\) => c\.id === draft\.assess!\.chapterId\)/);
    expect(draftBlock).toMatch(/if \(chapterExists\) setAssess\(draft\.assess\)/);
  });

  it("写入分支：assess 参与持久化条件与载荷，三者皆空才清 key", () => {
    expect(draftBlock).toMatch(/if \(transfer \|\| recheck \|\| assess\) localStorage\.setItem\(practiceKey, JSON\.stringify\(\{ transfer, recheck, hintShown, assess \}\)\)/);
    expect(draftBlock).toMatch(/else localStorage\.removeItem\(practiceKey\)/);
  });

  it("assess 的 effect 依赖包含 assess（否则提交/放弃后残留旧草稿）", () => {
    expect(draftBlock).toMatch(/\}, \[draftLoaded, practiceKey, transfer, recheck, hintShown, assess\]\)/);
  });

  it("放弃作答路径有确认保护（草稿非空时），不再静默丢弃", () => {
    // 验收卡「以后再说」
    expect(PAGE).toMatch(/!assess\.answers\.some\(\(a\) => a\.trim\(\)\) \|\| confirm\("放弃这次验收的作答\？"\)/);
    // 迁移卡「暂不做」与独立复验同口径
    expect(PAGE).toMatch(/!transfer\.answer\.trim\(\) \|\| confirm\("放弃已经写好的应用方案\？"\)/);
  });
});
