import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ util.heatmap/streak：日期索引必须无原型（原型污染回归锁） ============
 * 事故链（miniprogram/utils/util.js 修复前）：quizLog 经本机缓存 JSON.parse 与
 * 云端快照 adoptCloud 进入 state，q.date 无任何校验；heatmap/streak 用普通
 * 对象当日期 map。date 为 "__proto__"（快照损坏或被写入恶意值）时，
 * `byDate[q.date]` 命中继承的 Object.prototype 走过判空，随后
 * `byDate[q.date].total += 1` 变成对 Object.prototype 的写——已用 node 实测
 * Object.prototype.total = NaN，此后全应用任何缺失 .total 属性的普通对象读取
 * 都得到 NaN（"constructor" 同理污染 Object 构造器）。
 * 修复：索引改 Object.create(null)。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();
const UTIL_PATH = join(ROOT, "miniprogram/utils/util.js");

function loadUtil() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
  };
  delete requireCjs.cache[UTIL_PATH];
  return requireCjs(UTIL_PATH) as {
    heatmap: (log: unknown[], weeks?: number) => { date: string; level: number }[][];
    streak: (log: unknown[]) => number;
    todayISO: () => string;
  };
}

describe("mp util heatmap/streak 原型污染防护", () => {
  it("date=\"__proto__\"/\"constructor\" 不写 Object.prototype", () => {
    const util = loadUtil();
    const log = [
      { date: "__proto__", passed: 1 },
      { date: "constructor", passed: 0 },
    ];
    util.heatmap(log, 2);
    util.streak(log);
    expect(({} as Record<string, unknown>).total).toBeUndefined();
    expect(({} as Record<string, unknown>).passed).toBeUndefined();
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });

  it("正常日期统计不回归（全过 → 3，部分过 → 2）", () => {
    const util = loadUtil();
    const today = util.todayISO();
    const full = util
      .heatmap([{ date: today, passed: 1 }], 2)
      .flat()
      .find((c) => c.date === today);
    expect(full && full.level).toBe(3);
    const partial = util
      .heatmap([{ date: today, passed: 1 }, { date: today, passed: 0 }], 2)
      .flat()
      .find((c) => c.date === today);
    expect(partial && partial.level).toBe(2);
  });

  it("streak：今天有记录 → 1；只有 \"__proto__\" 日期 → 0 且不炸", () => {
    const util = loadUtil();
    expect(util.streak([{ date: util.todayISO() }])).toBe(1);
    expect(util.streak([{ date: "__proto__" }])).toBe(0);
  });
});
