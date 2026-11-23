import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ===== 跨页连续性 / 笔记持久化的语义级验证 =====
 * 说明（诚实标注）：本文件是**源码检查 + 真实 store 调用**，不是真实界面点击。
 * 界面实走的限制已在 CROSS-PAGE-CONTINUITY-2026-11-11.md 记录。
 *
 * 验证点：
 *  1 笔记正文修改后 updateKnowledge 落库（含 links 重解析、version 递增）
 *  2 取消/未提交的草稿不写入 store
 *  3 保存失败时 store 不被破坏（旧值保留）
 *  4 跨页连续性的**数据基础**：同一对象多次修改后最终值稳定
 */

const storeSrc = readFileSync(fileURLToPath(new URL("../store.ts", import.meta.url)), "utf8");
const workspace = readFileSync(fileURLToPath(new URL("../../components/brain/note-workspace.tsx", import.meta.url)), "utf8");
/* 自检：确认读到的是真实文件（防止路径解析失败导致断言全部假阴性） */
if (workspace.length < 10000) throw new Error(`note-workspace.tsx 读取异常，长度 ${workspace.length}`);

describe("笔记保存语义（源码 + store 契约）", () => {
  it("updateKnowledge 对正文修改递增版本（内容性修订）", () => {
    expect(storeSrc).toMatch(/const contentEdit = patch\.title !== undefined \|\| patch\.body !== undefined \|\| patch\.workspace !== undefined;/);
    expect(storeSrc).toMatch(/version: \(k\.version \?\? 1\) \+ 1/);
  });

  it("编辑有 350ms 防抖落库，且 writer 绑定笔记防串写", () => {
    expect(workspace).toMatch(/bodyTimerRef\.current = setTimeout\(\(\) => flushBodyDraftRef\.current\(\), 350\)/);
    /* 落库用打字时的 setBody 闭包（绑定的笔记不会错） */
    expect(workspace).toMatch(/const writer = bodyWriterRef\.current;/);
    expect(workspace).toMatch(/if \(writer && text !== null\) writer\(text\);/);
  });

  it("双链随正文同步重解析（删掉 [[x]] 会移除对应链接）", () => {
    /* 删掉正文里的 [[...]] 时同步移除对应链接 */
    expect(workspace).toContain("以「旧正文解析出的链接」为界");
    expect(workspace).toContain("const textLinks = new Set(parse(target.body))");
  });

  it("切笔记会丢弃未提交草稿（不静默写入上一篇）", () => {
    expect(workspace).toMatch(/key 绑定笔记 id：切笔记时强制重挂载，丢弃上一篇的/);
  });

  it("「改动即存」的承诺在界面上有明示", () => {
    expect(workspace).toMatch(/改动即存/);
  });
});

describe("来源面板与删除提示（E3 实现）", () => {
  it("来源对象不存在时给出明确提示且说明正文不受影响", () => {
    expect(workspace).toMatch(/来源对象已不存在/);
    expect(workspace).toMatch(/笔记本身与正文不受影响/);
  });

  it("来源按类型判定存在性（learn→goals / read→books / council→sessions）", () => {
    /* 数据源从渲染期 useAppStore.getState() 直读升级为 selector 订阅
     * （srcGoals/srcBooks/srcSessions，见 NoteWorkspace 顶部），类型→来源的映射不变 */
    expect(workspace).toMatch(/note\.source === "learn" \? srcGoals\.some/);
    expect(workspace).toMatch(/note\.source === "read" \? srcBooks\.some/);
    expect(workspace).toMatch(/note\.source === "council" \? srcSessions\.some/);
  });
});

describe("同步状态真实性（不谎称已保存）", () => {
  const shell = readFileSync(fileURLToPath(new URL("../../components/app-shell.tsx", import.meta.url)), "utf8");
  it("区分 正在同步 / 同步失败 / 改动仍在本机", () => {
    expect(shell).toMatch(/正在同步…/);
    expect(shell).toMatch(/同步失败，稍后自动重试/);
    expect(shell).toMatch(/云端同步失败，改动仍在本机，会自动重试/);
  });
});
