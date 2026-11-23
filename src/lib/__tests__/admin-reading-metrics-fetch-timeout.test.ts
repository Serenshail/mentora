import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 管理端指标请求必须带硬超时与卸载中止（回归锁） ============
 * 背景：load() 的 fetch 不带 AbortSignal.timeout、不挂卸载 abort——本代码库客户端
 * fetch 的既有惯例全部带硬超时（admin 面板家族 30s、feedback-widget 15s），此处是
 * 唯一裸奔的：自托管端进程卡死/移动代理连接不 RST 时 loading 永不回落，管理员
 * 只能整页刷新。修复：AbortSignal.timeout(30s) + 卸载 AbortController 中止。
 * vitest 无 DOM 环境，沿用仓库静态扫描做法。 */

const SRC = readFileSync(join(process.cwd(), "src/components/admin/reading-experiment.tsx"), "utf8");

describe("阅读实验面板：指标请求的超时与中止", () => {
  it("fetch 带硬超时（对齐 admin 面板家族的 30s），并把 signal 接进请求", () => {
    expect(SRC).toContain("AbortSignal.timeout(30_000)");
    expect(SRC).toMatch(/fetch\("\/api\/admin\/reading-metrics\?days=30", \{ headers: pwHeaders\(\), signal \}\)/);
  });

  it("卸载时中止挂起的请求（cleanup 里 abort）", () => {
    expect(SRC).toContain("abortRef.current?.abort()");
  });

  it("中止后不再写任何状态；超时给人话文案而非裸异常", () => {
    expect(SRC).toMatch(/if \(ac\.signal\.aborted\) return;/);
    expect(SRC).toContain('"加载超时，请重试"');
    expect(SRC).toMatch(/if \(!ac\.signal\.aborted\) setLoading\(false\)/);
  });
});
