import { describe, expect, it } from "vitest";
import { skeletonClassName } from "../utils";

/* ============ Skeleton 默认类「仅兜底」合并的回归锁 ============
 * 背景：cn 只是 clsx（无 tailwind-merge），Skeleton 基类 rounded-lg /
 * bg-black/[0.06] 与调用方传入的 rounded-2xl、bg-surface/60 等同族类同时
 * 保留，胜负由 Tailwind 4 构建产物按类名字母序的样式发射顺序决定——
 * .rounded-lg 恰好排在 .rounded-2xl 之后而胜出，17 处调用方的圆角全部
 * 静默失效（骨架圆角 0.5rem，与替身卡片的 1.125rem 不一致）。
 * 修复：skeletonClassName 把默认类改为仅兜底——调用方传了同族类
 * （rounded-* / bg-*）则默认类整个不下发，不再依赖发射顺序。
 * 锁住三个面：① 调用方圆角必须原样保留且不再与 rounded-lg 同现；
 * ② bg 同族同理（bg-surface/60 下不得再出现 bg-black/[0.06]）；
 * ③ 未传同族类时默认类必须仍在（老的无参调用不回归）。 */

describe("skeletonClassName（Skeleton 默认圆角/底色仅兜底）", () => {
  it("调用方传 rounded-2xl 时基类 rounded-lg 不再下发（核心回归场景）", () => {
    const out = skeletonClassName("h-64 rounded-2xl bg-surface/60");
    expect(out).toContain("rounded-2xl");
    expect(out).not.toContain("rounded-lg");
    expect(out).toContain("animate-pulse");
    // bg 同族同理：调用方的 bg-surface/60 生效，默认 bg-black/[0.06] 不再出现
    expect(out).toContain("bg-surface/60");
    expect(out).not.toContain("bg-black");
  });

  it("调用方传 rounded-none（首页整页骨架）时不发默认 rounded-lg", () => {
    const out = skeletonClassName("min-h-screen rounded-none");
    expect(out).toContain("rounded-none");
    expect(out).not.toContain("rounded-lg");
    // 未传 bg-* 时默认底色仍兜底
    expect(out).toContain("bg-black/[0.06]");
  });

  it("任意圆角变体/任意值都识别为已指定（rounded-full、rounded-[3rem]、变体写法）", () => {
    for (const c of ["rounded-full", "rounded-[3rem]", "rounded-t-2xl"]) {
      expect(skeletonClassName(c), c).not.toContain("rounded-lg");
      expect(skeletonClassName(c), c).toContain(c);
    }
  });

  it("未传圆角时默认 rounded-lg 仍在（无参/纯尺寸调用不回归）", () => {
    expect(skeletonClassName()).toContain("rounded-lg");
    expect(skeletonClassName()).toContain("bg-black/[0.06]");
    expect(skeletonClassName("h-16")).toBe(
      "animate-pulse rounded-lg bg-black/[0.06] h-16"
    );
    expect(skeletonClassName(undefined)).toBe(
      "animate-pulse rounded-lg bg-black/[0.06]"
    );
  });

  it("admin 三连骨架（h-16 rounded-2xl 无 bg）保留调用方圆角且默认底色兜底", () => {
    const out = skeletonClassName("h-16 rounded-2xl");
    expect(out).toContain("rounded-2xl");
    expect(out).not.toContain("rounded-lg");
    expect(out).toContain("bg-black/[0.06]");
  });

  it("空白与多余空格不产生空词元或重复空格", () => {
    expect(skeletonClassName("")).toBe("animate-pulse rounded-lg bg-black/[0.06]");
    expect(skeletonClassName("  h-64   rounded-2xl  ")).toBe(
      "animate-pulse bg-black/[0.06] h-64 rounded-2xl"
    );
  });

  it("17 处既有调用方逐一核验：圆角与底色按调用意图生效", () => {
    // 全仓 <Skeleton> 调用方（grep 得到），按各处 className 原样核验
    const cases: Array<[string, string]> = [
      ["h-16 rounded-2xl", "rounded-2xl"],
      ["min-h-screen rounded-none", "rounded-none"],
      ["h-64 rounded-2xl bg-surface/60", "rounded-2xl"],
      ["h-40 rounded-2xl bg-surface/60", "rounded-2xl"],
      ["h-28 rounded-2xl bg-surface/60", "rounded-2xl"],
      ["h-44 rounded-2xl bg-surface/60", "rounded-2xl"],
      ["h-40 w-full max-w-md rounded-2xl bg-surface/60", "rounded-2xl"],
    ];
    for (const [input, radius] of cases) {
      const out = skeletonClassName(input);
      expect(out, input).toContain(radius);
      expect(out, input).not.toContain("rounded-lg");
      expect(out, input).toMatch(/^animate-pulse( |$)/);
    }
  });
});
