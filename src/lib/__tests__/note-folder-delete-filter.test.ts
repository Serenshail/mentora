import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ 搜索/标签筛选态下「删除文件夹」必须按 domain 前缀取全库笔记（回归锁）============
 * 背景：左栏 dirTree 在筛选态下只由 filtered 构建（note-workspace.tsx），dir.notes
 * 只含命中笔记。旧实现的「删除文件夹」用 countNotes(dir) 计数 + delAll(dir) 只遍历
 * 这棵被筛过的树：未命中查询/标签的笔记一篇没删，而 removeFolder(dir.path) 无条件把
 * 文件夹从 folders 移除 → 下一次渲染 dirTree 的 ensure(k.domain) 又把同名文件夹连同
 * 残留笔记重建出来（文件夹删完复活），与确认框「删除文件夹 X 及其中的 N 篇笔记」的
 * 语义不符。修复：按 domain 前缀（含子文件夹）从全库 knowledge 取待删集合。
 *
 * vitest 无 DOM 环境，沿用本仓库既有静态扫描做法。 */

const SRC = readFileSync(join(process.cwd(), "src/components/brain/note-workspace.tsx"), "utf8")
  .replace(/\r\n/g, "\n");

describe("note-workspace：删除文件夹按 domain 前缀取全库笔记", () => {
  const start = SRC.indexOf("const inFolder = knowledge.filter(");

  it("抽到了删除文件夹的处理块", () => {
    expect(start, "找不到 inFolder 计算").toBeGreaterThan(-1);
  });

  it("待删集合覆盖 dir.path 本身与子树（path + '/'）", () => {
    const block = SRC.slice(start, start + 1200);
    expect(block).toMatch(/k\.domain === dir\.path/);
    expect(block).toMatch(/k\.domain\.startsWith\(dir\.path \+ "\/"\)/);
  });

  it("确认框计数与实际删除用同一个集合，不再用筛过的树计数", () => {
    const block = SRC.slice(start, start + 1200);
    expect(block).toMatch(/inFolder\.length > 0/);
    /* 机制从逐篇 removeKnowledge 升级为批量 removeKnowledgeMany（一次 set，
     * 逐篇是 N 次全库重算 + N 次全仓 persist 写盘）；待删集合语义不变 */
    expect(block).toMatch(/removeKnowledgeMany\(inFolder\.map\(\(k\) => k\.id\)\)/);
    expect(block).not.toMatch(/for \(const k of inFolder\) removeKnowledge\(k\.id\)/);
    expect(block).not.toMatch(/countNotes\(dir\)/);
  });

  it("旧的只遍历筛选树的 delAll 已移除", () => {
    expect(SRC).not.toContain("delAll(");
  });

  it("当前打开的是被删笔记时关闭编辑器改用同一集合判定", () => {
    const block = SRC.slice(start, start + 1200);
    expect(block).toMatch(/inFolder\.some\(\(k\) => k\.id === openId\)/);
  });
});
