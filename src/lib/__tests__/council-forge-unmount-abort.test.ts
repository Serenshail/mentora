import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ council 锻造流：卸载必须中止 persona-distill 在途请求（回归锁） ============
 * 背景：forgeAbortRef 只在 closeForge 与再次蒸馏时 abort，唯独没有对等的 unmount
 * cleanup（圆桌流有 149 行的卸载清理、useChat 也有，forge 漏了）。persona-distill
 * 是服务端长任务（route.ts LONG_GEN_TASKS，header 超时放宽到 120s）：用户开着弹窗
 * 直接切路由时，这条调用（BYOK 下烧的是用户的钱）会完整跑完，结果因组件卸载被丢弃；
 * 若中途失败，还会在下一个页面弹出全局「蒸馏失败」toast。
 *
 * vitest 无 DOM 环境，沿用本仓库源码扫描护栏风格：按结构锚点断言。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/council/page.tsx", import.meta.url)),
  "utf8"
);

describe("council 锻造流卸载中止", () => {
  it("存在 forgeAbortRef 的卸载清理 effect（与圆桌/useChat 同款）", () => {
    expect(PAGE).toMatch(/useEffect\(\(\) => \(\) => forgeAbortRef\.current\?\.abort\(\), \[\]\);/);
  });

  it("closeForge 关窗中止语义不回退（换代 + abort）", () => {
    const close = PAGE.slice(
      PAGE.indexOf("const closeForge = () =>"),
      PAGE.indexOf("const forge = async () =>")
    );
    expect(close).toContain("forgeGenRef.current += 1");
    expect(close).toContain("forgeAbortRef.current?.abort()");
  });

  it("forge 的迟到结果有 gen/abort 双守卫：卸载中止不算失败、不弹 toast", () => {
    const forge = PAGE.slice(
      PAGE.indexOf("const forge = async () =>"),
      PAGE.indexOf("const saveForged = () =>")
    );
    expect(forge).toContain("gen !== forgeGenRef.current || ac.signal.aborted");
    expect(forge).toContain("signal: ac.signal");
  });
});
