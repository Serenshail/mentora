import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessCloudRestore, countRestoreItems, totalRestoreItems, type RestoreCounts } from "../cloud-restore";

/* ============ 「从云端恢复」二次确认 + 新旧比对回归锁 ============
 * 背景（FIX heavy-f3-pagetsx-1）：settings/page.tsx 的 restoreFromCloud 拉到云端
 * 快照后直接 importData(cloud.data)；store.ts:1742-1746 在快照带全键时用
 * `clean.goals ?? s.goals` 等**整体替换**（auth-client.ts localData() 恒带全键，
 * `??` 兜底不会保留本地）。同页「清空全部数据」有双击确认，这个同等破坏性的
 * 操作却没有：离线工作一段时间后点它（与「登录后自动同步」同卡，极易当手动同步），
 * 本地较新的独有数据被静默覆盖，随后自动同步再把旧快照推上云。
 *
 * 修复：先拉取→比对云端 updatedAt 与本机同步水位、比对条目数→20s 内二次确认
 * 才 importData。这里锁住判定逻辑（纯函数）与页面必须走确认（源码锚点扫描，
 * vitest 无 DOM，沿用仓库既有静态扫描做法）。 */

const SETTINGS_PAGE = readFileSync(join(process.cwd(), "src/app/settings/page.tsx"), "utf8");

const zero: RestoreCounts = { goals: 0, knowledge: 0, books: 0, sessions: 0, customPersonas: 0, agentSessions: 0 };

describe("countRestoreItems / totalRestoreItems", () => {
  it("只统计数组字段，坏字段按 0 计（结构校验仍由 store.sanitizeBackup 负责）", () => {
    const c = countRestoreItems({
      goals: [{}, {}],
      knowledge: "not-an-array",
      books: [{}, {}, {}],
      sessions: [],
      customPersonas: [{}],
      agentSessions: [{}, {}],
    });
    expect(c.goals).toBe(2);
    expect(c.knowledge).toBe(0);
    expect(c.books).toBe(3);
    expect(c.customPersonas).toBe(1);
    expect(c.agentSessions).toBe(2);
    expect(totalRestoreItems(c)).toBe(8);
  });

  it("null/undefined 快照全 0", () => {
    expect(totalRestoreItems(countRestoreItems(null))).toBe(0);
    expect(totalRestoreItems(countRestoreItems(undefined))).toBe(0);
  });
});

describe("assessCloudRestore：云端旧快照不得被当成「更新」", () => {
  const localNewer: RestoreCounts = { ...zero, goals: 2, knowledge: 5, books: 1, sessions: 3 };

  it("云端 updatedAt 不新于本机同步水位 → cloudStale/risky（离线期间的本地改动会被覆盖）", () => {
    const a = assessCloudRestore({
      cloudUpdatedAt: "2026-11-01T10:00:00.000Z",
      localWatermarkTs: Date.parse("2026-11-08T10:00:00.000Z"),
      cloud: { ...zero, goals: 1, knowledge: 2 },
      local: localNewer,
    });
    expect(a.freshnessKnown).toBe(true);
    expect(a.cloudStale).toBe(true);
    expect(a.fewerItems).toBe(true);
    expect(a.risky).toBe(true);
  });

  it("云端明显更新（超过 3s 容差）且条目更多 → 不判风险", () => {
    const a = assessCloudRestore({
      cloudUpdatedAt: "2026-11-09T10:00:00.000Z",
      localWatermarkTs: Date.parse("2026-11-08T10:00:00.000Z"),
      cloud: { ...zero, goals: 3, knowledge: 9, books: 2, sessions: 4, customPersonas: 1, agentSessions: 2 },
      local: localNewer,
    });
    expect(a.cloudStale).toBe(false);
    expect(a.fewerItems).toBe(false);
    expect(a.risky).toBe(false);
  });

  it("容忍 3s 时钟漂移：云端只比水位新 2s 时不算「更新」，新出 10s 才算", () => {
    const pushed = "2026-11-09T10:00:00.000Z";
    const near = assessCloudRestore({
      cloudUpdatedAt: pushed,
      localWatermarkTs: Date.parse(pushed) - 2000,
      cloud: { ...zero, goals: 3 },
      local: { ...zero, goals: 3 },
    });
    expect(near.cloudStale).toBe(true);
    const newer = assessCloudRestore({
      cloudUpdatedAt: pushed,
      localWatermarkTs: Date.parse(pushed) - 10_000,
      cloud: { ...zero, goals: 3 },
      local: { ...zero, goals: 3 },
    });
    expect(newer.cloudStale).toBe(false);
  });

  it("从未同步（水位 0）→ freshnessKnown=false，只有条目变少才判风险", () => {
    const unknown = assessCloudRestore({
      cloudUpdatedAt: "2026-11-09T10:00:00.000Z",
      localWatermarkTs: 0,
      cloud: { ...zero, goals: 3 },
      local: { ...zero, goals: 1 },
    });
    expect(unknown.freshnessKnown).toBe(false);
    expect(unknown.cloudStale).toBe(false);
    expect(unknown.risky).toBe(false);

    const shrinks = assessCloudRestore({
      cloudUpdatedAt: "2026-11-09T10:00:00.000Z",
      localWatermarkTs: 0,
      cloud: { ...zero, goals: 1 },
      local: { ...zero, goals: 3 },
    });
    expect(shrinks.fewerItems).toBe(true);
    expect(shrinks.risky).toBe(true);
  });

  it("非法 updatedAt 不抛错、按未知新鲜度处理", () => {
    const a = assessCloudRestore({
      cloudUpdatedAt: "",
      localWatermarkTs: Number.NaN,
      cloud: { ...zero },
      local: { ...zero },
    });
    expect(a.freshnessKnown).toBe(false);
    expect(a.risky).toBe(false);
  });
});

describe("settings/page.tsx 源码护栏：恢复必须二次确认", () => {
  /** 抽出 restoreFromCloud 函数体（花括号配平），避免误扫同文件其它 importData 调用。 */
  function restoreBody(src: string): string {
    const start = src.indexOf("const restoreFromCloud = async () => {");
    expect(start, "settings/page.tsx 必须保留 const restoreFromCloud = async () => {").toBeGreaterThan(-1);
    const open = src.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error("restoreFromCloud 函数体未闭合");
  }

  const body = restoreBody(SETTINGS_PAGE);

  it("不再把 pullCloud 的结果直接交给 importData（必须先进待确认态）", () => {
    expect(body).not.toMatch(/importData\(\s*cloud\.data\s*\)/);
    expect(body).toMatch(/setPendingRestore\(/);
    expect(body).toContain("importData(p.data)");
  });

  it("确认窗口内本机被再次写入 → 作废待确认，不按过时判断覆盖", () => {
    expect(body).toContain("localSnapshot");
    expect(body).toMatch(/JSON\.stringify\(localRestoreCounts\(\)\) !== JSON\.stringify\(p\.localSnapshot\)/);
    expect(body).toContain("clearPendingRestore();");
  });

  it("确认前先比对云端与本机（updatedAt 水位 + 条目数）", () => {
    expect(body).toContain("assessCloudRestore(");
    expect(body).toContain("getSyncWatermarkTs()");
    expect(body).toContain("countRestoreItems(cloud.data)");
    expect(body).toContain("local: localSnapshot");
  });

  it("待确认态有超时自动失效，且成功后对齐同步水位", () => {
    expect(body).toMatch(/restoreTimerRef\.current = setTimeout\(/);
    expect(body).toMatch(/20_000/);
    expect(body).toContain("markSyncWatermark(p.updatedAt)");
  });

  it("连点不会并发拉取两次云端（ref 同步互斥，不依赖 setState 重渲染时序）", () => {
    expect(body).toContain("restoreInFlightRef.current = true");
    expect(body).toContain("restoreInFlightRef.current = false");
    expect(body).toMatch(/if \(restoring \|\| restoreInFlightRef\.current\) return;/);
  });

  it("按钮文案在待确认时切到「确认覆盖本机？」，并给出取消入口", () => {
    expect(SETTINGS_PAGE).toContain("确认覆盖本机？");
    expect(SETTINGS_PAGE).toContain("clearPendingRestore");
    expect(SETTINGS_PAGE).toContain("取消");
  });
});
