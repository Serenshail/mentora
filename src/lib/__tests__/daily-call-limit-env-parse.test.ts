import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ============ AI_DAILY_CALL_LIMIT 畸形值回归锁（quota.ts fail-open） ============
 * 修复前 quota.ts:21 是
 *   `Math.max(1, Number(process.env.AI_DAILY_CALL_LIMIT || 60))`
 * Number("60/day") / Number("1,000") 都是 NaN，Math.max(1, NaN) 仍是 NaN；
 * checkAndCountServerKey 里 `n >= NaN` 恒为 false，于是每日配额护栏对每个
 * 走服务端 Key 的用户永远 ok:true —— 部署者把限额写成带单位/带逗号的值时，
 * 成本护栏（防烧钱）静默整体失效，且零告警。chat/route.ts:617 的兜底表达式
 * 重算同一个 env，把同一个 NaN 混进 q.limit 的 429 文案。
 * 修复口径与 usage.ts parseTokenBudget / rate-limit.ts trustedProxyHops 同源：
 * 畸形值绝不透传，回落默认 60。 */

vi.mock("server-only", () => ({}));

/* 存储替身：hasHealthyRemoteDb 恒 true（走真实计量分支），日键记录可打桩 */
let stored: { n: number } | null = null;
const puts: { n: number }[] = [];
vi.mock("../server/db", () => ({
  hasHealthyRemoteDb: () => true,
  dbGet: vi.fn(async () => (stored ? { ...stored } : null)),
  dbPut: vi.fn(async (_p: string, v: { n: number }) => {
    puts.push({ ...v });
    stored = { ...v };
    return { sha: "s" };
  }),
  dbList: vi.fn(async () => []),
  dbDelete: vi.fn(async () => {}),
}));

import { dailyCallLimit, checkAndCountServerKey } from "../server/quota";

const ENV_KEY = "AI_DAILY_CALL_LIMIT";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_KEY];
  stored = null;
  puts.length = 0;
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

describe("dailyCallLimit()：env 解析恒为有限正整数", () => {
  it("未配置 → 默认 60", () => {
    delete process.env[ENV_KEY];
    expect(dailyCallLimit()).toBe(60);
  });

  it("纯数字照常解析", () => {
    process.env[ENV_KEY] = "120";
    expect(dailyCallLimit()).toBe(120);
  });

  it("带单位的 '60/day' 回落 60，且旧表达式确实是 NaN（本次修复的主诉）", () => {
    process.env[ENV_KEY] = "60/day";
    const limit = dailyCallLimit();
    expect(Number.isFinite(limit)).toBe(true);
    expect(limit).toBe(60);
    /* 旧实现的确定性失效点，防止回退成裸 Number() */
    expect(Math.max(1, Number("60/day"))).toBeNaN();
  });

  it("千分位写法 '1,000' / '1_000' 按 1000 解析", () => {
    process.env[ENV_KEY] = "1,000";
    expect(dailyCallLimit()).toBe(1000);
    process.env[ENV_KEY] = "1_000";
    expect(dailyCallLimit()).toBe(1000);
  });

  it.each(["abc", "Infinity", "-Infinity", "NaN", "1,5", "60 次", "0x10"])(
    "畸形值 %s 回落默认 60，绝不透传 NaN/Infinity",
    (raw) => {
      process.env[ENV_KEY] = raw;
      const limit = dailyCallLimit();
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBe(60);
    }
  );

  it("低于下限的合法数字被夹到 1（不出现 0 或负数无限锁死）", () => {
    process.env[ENV_KEY] = "0";
    expect(dailyCallLimit()).toBe(1);
    process.env[ENV_KEY] = "-5";
    expect(dailyCallLimit()).toBe(60); // 负数带符号，不算合法数字 → 默认
  });
});

describe("checkAndCountServerKey()：畸形 env 下配额仍然真实生效（不再 fail-open）", () => {
  it("env='60/day' 且今日已用 60 → ok=false（修复前 n >= NaN 恒 false 永远放行）", async () => {
    process.env[ENV_KEY] = "60/day";
    stored = { n: 60 };
    const q = await checkAndCountServerKey("a@b.com");
    expect(Number.isFinite(q.limit)).toBe(true);
    expect(q.limit).toBe(60);
    expect(q.ok).toBe(false);
    expect(q.used).toBe(60);
    /* 旧语义的失效点：任何次数与 NaN 比较都为 false */
    expect(60 >= Number.NaN).toBe(false);
  });

  it("env='60/day' 且今日已用 59 → 放行并计数到 60（护栏没变成一刀切）", async () => {
    process.env[ENV_KEY] = "60/day";
    stored = { n: 59 };
    const q = await checkAndCountServerKey("a@b.com");
    expect(q.ok).toBe(true);
    expect(q.used).toBe(60);
    expect(puts.at(-1)).toEqual({ n: 60 });
  });

  it("env='1,000' 且今日已用 500 → 放行（合法千分位不被误判为畸形而收紧）", async () => {
    process.env[ENV_KEY] = "1,000";
    stored = { n: 500 };
    const q = await checkAndCountServerKey("a@b.com");
    expect(q.limit).toBe(1000);
    expect(q.ok).toBe(true);
  });
});
