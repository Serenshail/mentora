import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* 回归锁：/life 时间线对 quizLog.date / knowledge.masteredAt / session.createdAt 必须做
 * 有效性防护后再 toISOString()。
 * 这些字段正常情况下是 UTC 日/ISO 字符串，但 store.ts 的 sanitizeBackup 对 quizLog 只校验
 * 「是数组」、不校验元素 date（备份文件/云端快照共用该入口），坏日期可原样进 store；
 * new Date(坏值).toISOString() 会抛 RangeError，在渲染期 useMemo 里炸掉整个 /life 页。
 * 与 study-heatmap.tsx 的 dayKey 同口径：取不到合法时间就跳过该条。
 *
 * life-workspace 是客户端组件（依赖 useHydrated/zustand），仓库无 jsdom/@testing-library，
 * 无法运行时渲染——沿用 markdown-memo.test.ts 的源码级锁法：把「守卫存在」与
 * 「三处调用点都过守卫」都钉死，退回裸 toISOString() 立刻红。 */

const SRC = readFileSync(join(process.cwd(), "src/components/life-workspace.tsx"), "utf8");

describe("life-workspace 时间线日期防护", () => {
  it("存在 safeISO 守卫，且用 Number.isFinite 拒绝 Invalid Date", () => {
    expect(SRC).toMatch(/function\s+safeISO\(/);
    expect(SRC).toMatch(/const t = new Date\(raw\)\.getTime\(\)/);
    expect(SRC).toMatch(/Number\.isFinite\(t\)/);
  });

  it("三处时间字段都过 safeISO，不再裸 new Date(...).toISOString()", () => {
    expect(SRC).toContain("safeISO(q.date)");
    expect(SRC).toContain("safeISO(k.masteredAt)");
    expect(SRC).toContain("safeISO(s.createdAt)");
    expect(SRC).not.toMatch(/new Date\(q\.date\)\.toISOString\(\)/);
    expect(SRC).not.toMatch(/new Date\(k\.masteredAt\)\.toISOString\(\)/);
    expect(SRC).not.toMatch(/new Date\(s\.createdAt\)\.toISOString\(\)/);
  });

  it("取不到合法时间就跳过该条（不让单条脏数据毁整页）", () => {
    expect(SRC).toMatch(/const at = safeISO\(q\.date\);\s*\n\s*if \(!at\) continue;/);
    expect(SRC).toMatch(/const at = safeISO\(k\.masteredAt\);\s*\n\s*if \(!at\) continue;/);
  });
});
