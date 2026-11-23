import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ AppShell 顶部横幅几何 / 设计令牌 / 光标约定（回归锁） ============
 * 背景：两条 fixed 横幅（新版本提示/今日提醒）写死 top-0/top-11+pt-2，不遵循
 * globals.css 的 --safe-top 移动几何契约——viewportFit=cover 时刘海屏上会顶进
 * 状态栏/灵动岛；两处 bg-[#1d1d1f] 绕过 --color-ink 令牌；4 处按钮缺 cursor-pointer；
 * period 死状态每 10 分钟让全站外壳白渲染一次。 */

const SHELL = readFileSync(join(process.cwd(), "src/components/app-shell.tsx"), "utf8");

describe("顶部 fixed 横幅遵循 --safe-top", () => {
  it("新版本提示胶囊顶部留白 = safe-top + 8px", () => {
    expect(SHELL).toContain('style={{ paddingTop: "calc(var(--safe-top) + 8px)" }}');
    expect(SHELL).toContain('top: buildStale ? "calc(var(--safe-top) + 2.75rem)" : "var(--safe-top)"');
  });
  it("胶囊不再写死 bg-[#1d1d1f]：墨色走 --color-ink 令牌", () => {
    expect(SHELL).not.toContain("bg-[#1d1d1f]");
    expect(SHELL).toContain("rounded-full bg-ink px-4 py-1.5");
    expect(SHELL).toContain("rounded-lg bg-ink text-[11px]");
  });
});

describe("period 死状态已移除", () => {
  it("不再有无人消费的 period state / PERIOD_LABEL、periodOf 导入", () => {
    expect(SHELL).not.toMatch(/const \[period, setPeriod\]/);
    expect(SHELL).not.toMatch(/setPeriod\(/);
    expect(SHELL).not.toMatch(/import \{[^}]*PERIOD_LABEL/);
    expect(SHELL).not.toMatch(/import \{[^}]*periodOf/);
  });
  it("时段主题校准保留（每 10 分钟直接写 CSS 变量）", () => {
    expect(SHELL).toContain("setInterval(applyPeriodTheme, 600_000)");
  });
});

describe("按钮 cursor-pointer 补齐", () => {
  it("重试连接（探测失败页唯一可点按钮）带指针与悬停反馈", () => {
    expect(SHELL).toMatch(/onClick=\{retryAuthProbe\} className="min-h-11 cursor-pointer rounded-lg border border-border bg-white px-4 text-sm font-medium transition hover:bg-surface-2 hover:border-faint"/);
  });
  it("移动顶栏搜索与底栏「更多」带指针", () => {
    expect(SHELL).toMatch(/tap-target grid cursor-pointer place-items-center rounded-xl/);
    expect(SHELL).toMatch(/flex min-w-0 cursor-pointer flex-col items-center justify-center gap-1 py-2/);
  });
});
