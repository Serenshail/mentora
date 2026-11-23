import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* usage.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

/* ============ FREE_MONTHLY_TOKENS 畸形值回归锁 ============
 * 修复前 usage.ts:22 是 `Math.max(10_000, Number(process.env.FREE_MONTHLY_TOKENS || DEFAULT))`。
 * Number("200,000") / Number("20万") 都是 NaN，而 Math.max(10_000, NaN) 仍是 NaN；
 * withinFreeBudget 里 `usedTokens < NaN` 恒为 false，于是 chat/route.ts 对每个 freeTier
 * 用户直接 429「本月免费 AI 额度已用完」——一个 env 拼写错误把全体到期降级用户锁死整月，
 * 且文案误导。修复口径：env 解析失败必须回落默认值，绝不把 NaN 透传进比较式。 */

/* 月度累计打桩：withinFreeBudget 只经 dbGet 读一条 usage 记录 */
let used = { ti: 0, to: 0, n: 0 };
vi.mock("../server/db", () => ({
  emailHash: () => "hash",
  hasHealthyRemoteDb: () => true,
  dbGet: vi.fn(async () => ({ ...used })),
  dbPut: vi.fn(async () => {}),
}));

const ENV_KEY = "FREE_MONTHLY_TOKENS";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_KEY];
  used = { ti: 0, to: 0, n: 0 };
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = saved;
});

async function load() {
  return import("../server/usage");
}

describe("freeMonthlyTokens()：env 解析恒为有限数", () => {
  it("未配置 → 默认 200_000", async () => {
    delete process.env[ENV_KEY];
    const { freeMonthlyTokens } = await load();
    expect(freeMonthlyTokens()).toBe(200_000);
  });

  it("千分位写法 '200,000' 不再变 NaN（本次修复的主诉）", async () => {
    process.env[ENV_KEY] = "200,000";
    const { freeMonthlyTokens } = await load();
    const limit = freeMonthlyTokens();
    expect(Number.isFinite(limit)).toBe(true);
    expect(limit).toBe(200_000);
    /* 旧实现的确定性失效点，防止回退 */
    expect(Math.max(10_000, Number("200,000"))).toBeNaN();
  });

  it("下划线/空白写法按数字解析", async () => {
    process.env[ENV_KEY] = " 150_000 ";
    const { freeMonthlyTokens } = await load();
    expect(freeMonthlyTokens()).toBe(150_000);
  });

  it("纯数字无分隔符照常解析", async () => {
    process.env[ENV_KEY] = "300000";
    const { freeMonthlyTokens } = await load();
    expect(freeMonthlyTokens()).toBe(300_000);
  });

  it.each(["20万", "abc", "Infinity", "-Infinity", "NaN", "1,5", "2,00,000"])(
    "畸形值 %s 回落默认 200_000，绝不透传 NaN/Infinity，也不解析成离谱小值",
    async (raw) => {
      process.env[ENV_KEY] = raw;
      const { freeMonthlyTokens } = await load();
      const limit = freeMonthlyTokens();
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBe(200_000);
    }
  );

  it("低于下限的合法数字仍按 10_000 兜底", async () => {
    process.env[ENV_KEY] = "500";
    const { freeMonthlyTokens } = await load();
    expect(freeMonthlyTokens()).toBe(10_000);
  });
});

describe("withinFreeBudget()：畸形 env 下免费版不再被 fail-closed 锁死", () => {
  it("env='200,000' 且用量为 0 → ok=true（修复前 usedTokens < NaN 恒 false）", async () => {
    process.env[ENV_KEY] = "200,000";
    used = { ti: 0, to: 0, n: 0 };
    const { withinFreeBudget } = await load();
    const b = await withinFreeBudget("a@b.com");
    expect(Number.isFinite(b.limit)).toBe(true);
    expect(b.ok).toBe(true);
    /* 旧语义的失效点：任何用量与 NaN 比较都为 false */
    expect(0 < Number.NaN).toBe(false);
  });

  it("畸形 env 回落默认值后预算仍然真实生效（不是变相无限额）", async () => {
    process.env[ENV_KEY] = "20万";
    used = { ti: 150_000, to: 60_000, n: 3 };
    const { withinFreeBudget } = await load();
    const b = await withinFreeBudget("a@b.com");
    expect(b.limit).toBe(200_000);
    expect(b.usedTokens).toBe(210_000);
    expect(b.ok).toBe(false);
  });
});
