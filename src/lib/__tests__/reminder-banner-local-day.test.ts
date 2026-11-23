import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { localDayKey } from "../utils";

/* ============ 回归锁：提醒横幅「按天可关闭」必须按本地日、不是 UTC 日 ============
 * 背景（FIX 2026-11-10）：useReminderBanner 的展示判定与关闭写入都用
 * `new Date().toISOString().slice(0, 10)`（UTC 日）。产品受众以 UTC+8 为主：
 * 本地 0:00–8:00 期间 UTC 仍是前一天，用户在本地早上关掉横幅写入的是昨天的
 * key，本地 8 点后重新加载页面又按「新的一天」弹出来——当天关掉不再出现的
 * 承诺失效。修复：两处统一改用 utils.localDayKey()（本地年月日）。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法：纯函数用假 Date 锁定
 * 「取本地字段而非 toISOString」，组件侧用静态扫描锁定两处调用点都换了。 */

describe("localDayKey：按本地日历日取 key（不能用 toISOString 的 UTC 日）", () => {
  it("同一时刻 UTC 与本地跨日时，取本地那一天（UTC+8 早上 7 点的场景）", () => {
    /* 真实对应 UTC+8 的 2026-11-11 07:30，UTC 仍是 2026-11-10。
     * 假 Date 让断言与跑测机器的时区无关：本地字段返回 11 日，toISOString
     * 返回 10 日——谁被读到一目了然。 */
    const fake = {
      getFullYear: () => 2026,
      getMonth: () => 10, // 11 月
      getDate: () => 11,
      toISOString: () => "2026-11-10T23:30:00.000Z",
    } as unknown as Date;
    expect(localDayKey(fake)).toBe("2026-11-11");
    // 锁住反向：UTC 日确实是前一天（防止用例本身失去区分力）
    expect(fake.toISOString().slice(0, 10)).toBe("2026-11-10");
  });

  it("月/日补零，产出稳定 YYYY-MM-DD（localStorage key 不会因位数不同分裂）", () => {
    const fake = {
      getFullYear: () => 2026,
      getMonth: () => 0, // 1 月
      getDate: () => 5,
      toISOString: () => "2026-01-04T17:00:00.000Z",
    } as unknown as Date;
    expect(localDayKey(fake)).toBe("2026-01-05");
  });

  it("真实 Date 与本地字段一致（在任何时区下自洽）", () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    expect(localDayKey(d)).toBe(
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    );
  });
});

describe("app-shell.tsx：useReminderBanner 的判定与关闭都按本地日", () => {
  const SHELL = readFileSync(
    join(process.cwd(), "src/components/app-shell.tsx"),
    "utf8"
  );

  /** 抽出 useReminderBanner 函数体（花括号配平），断言锚在语义上而非行号。 */
  function reminderBannerBody(src: string): string {
    const start = src.indexOf("function useReminderBanner()");
    expect(start, "app-shell.tsx 必须保留 function useReminderBanner()").toBeGreaterThan(-1);
    const open = src.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error("useReminderBanner 函数体未闭合");
  }

  const body = reminderBannerBody(SHELL);

  it("不再用 toISOString() 生成按天 key", () => {
    expect(body).not.toContain("toISOString()");
  });

  it("展示判定与关闭写入两处都用 localDayKey()（漏一处 = 关掉当天又复现）", () => {
    const keyed = body.match(/`rem-banner-\$\{today\}`/g) ?? [];
    expect(keyed.length).toBe(2); // getItem 判定 + setItem 写入
    const localToday = body.match(/const today = localDayKey\(\);/g) ?? [];
    expect(localToday.length).toBe(2);
  });
});
