import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* E3 验收锁：笔记页与全局状态（源码语义锚定，仓库无 DOM 环境） */

const workspace = readFileSync(fileURLToPath(new URL("../../components/brain/note-workspace.tsx", import.meta.url)), "utf8");
const brain = readFileSync(fileURLToPath(new URL("../../app/brain/page.tsx", import.meta.url)), "utf8");
const shell = readFileSync(fileURLToPath(new URL("../../components/app-shell.tsx", import.meta.url)), "utf8");

describe("笔记列表（E3 验收 1：查找闭环）", () => {
  it("搜索覆盖标题与正文，且有无障碍标签", () => {
    expect(workspace).toMatch(/k\.title\.toLowerCase\(\)\.includes\(q\) \|\| k\.body\.toLowerCase\(\)\.includes\(q\)/);
    expect(workspace).toMatch(/aria-label="搜索笔记（标题或正文）"/);
  });

  it("区分「没有搜索结果」与「还没有笔记」两种空态", () => {
    expect(workspace).toMatch(/没有匹配的笔记/);
    expect(workspace).toMatch(/还没有笔记——点「新建笔记」开始记/);
    /* 无结果时给出当前筛选条件 + 清除入口 */
    expect(workspace).toMatch(/清除筛选/);
  });

  it("搜索条件在返回列表后保留（query 是组件态，不随选中清空）", () => {
    /* 选中笔记只改 note/activeId，不清 query —— 断言没有把 setQuery("") 绑在选中逻辑上 */
    const selectHandlers = workspace.match(/onOpenNote|setActiveId/g) ?? [];
    expect(selectHandlers.length).toBeGreaterThan(0);
    expect(workspace).not.toMatch(/setActiveId\([^)]*\);\s*setQuery\(""\)/);
  });
});

describe("笔记来源（E3 验收 3：来源与关联）", () => {
  it("详情右栏常显来源（人话标签 + 出处）", () => {
    expect(workspace).toMatch(/SOURCE_LABELS/);
    expect(workspace).toMatch(/学习产出/);
    expect(workspace).toMatch(/阅读产出/);
    expect(workspace).toMatch(/圆桌\/人生伙伴/);
  });

  it("来源对象已删除时如实提示，不留空白不误跳", () => {
    expect(workspace).toMatch(/来源对象已不存在/);
    expect(workspace).toMatch(/笔记本身与正文不受影响/);
  });
});

describe("复习入口（E3 验收 4：不自动通过）", () => {
  it("查看/作答后必须经判分才记录，且判分要有原文依据", () => {
    expect(brain).toMatch(/复习通过必须有笔记原文依据/);
    expect(brain).toMatch(/recordReview\(id, g\.verdict === "pass"\)/);
  });

  it("判分服务失败不记录、不默认通过，且保留用户回答", () => {
    expect(brain).toMatch(/评分服务暂不可用，你的回答没有丢/);
    expect(brain).toMatch(/废除"评分异常默认通过"/);
  });

  it("关窗/换会话后旧判卷作废（gen 守卫）", () => {
    expect(brain).toMatch(/if \(gen !== reviewGenRef\.current\) return;/);
  });
});

describe("全局状态（E3 验收 5/6）", () => {
  it("同步状态区分 正在同步 / 同步失败（失败不谎称已保存）", () => {
    expect(shell).toMatch(/正在同步…/);
    expect(shell).toMatch(/同步失败，稍后自动重试/);
    expect(shell).toMatch(/云端同步失败，改动仍在本机，会自动重试/);
  });

  it("额度事件与存储异常有用户可见提示", () => {
    expect(shell).toMatch(/mentora:quota/);
    expect(shell).toMatch(/mentora:store-warning/);
    expect(shell).toMatch(/本地数据读写异常/);
  });

  it("会员到期说明额度受限但数据保留（不吓唬用户）", () => {
    expect(shell).toMatch(/AI 按月度免费额度受限，学习记录与笔记全部保留/);
  });
});

describe("排版一致（沿用前两轮规范）", () => {
  it("笔记正文使用统一 prose 排版（不另建视觉体系）", () => {
    expect(workspace).toMatch(/prose-mentora|Markdown/);
  });
});
