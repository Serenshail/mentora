import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 读书伙伴建书：组件卸载必须中止在途生成流（回归锁） ============
 * 背景：createAbortRef 此前只被弹窗里的「取消生成」按钮触达，没有任何 useEffect
 * 清理在组件卸载时 abort。生成期间弹窗虽挡住页内导航，但浏览器 Back / 移动端
 * 硬件返回仍可离开 /learn；此时 verifyBook 与 streamChat 两条 /api 流继续跑到
 * 上游完成（服务端照常计费，一次失控调用），完成后 addBook 仍把用户已放弃的
 * 书写进 store 并同步上云，router.push 还会把用户强行拽回书籍详情页。
 * 修复：与 use-chat.ts / agent-home.tsx 同款——挂载空依赖 useEffect，卸载时
 * abort。abort 后走既有 AbortError 分支（create / generateBook 的 catch 只
 * toast），不建书、不跳转。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （brain-review-unmount-abort.test.ts 的静态扫描）：直接读组件源码做断言，
 * 按语义锚点而非行号，重排/换行不误报。扫描前先剥离注释，防止把清理
 * useEffect 注释掉骗过本锁。 */

const PAGE = readFileSync(join(process.cwd(), "src/components/read-workspace.tsx"), "utf8");

/** 剥离块/行注释（感知字符串与转义），只用于本测试的静态扫描。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++; // 保留换行，行号结构不乱
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        if (c === "\\" && i + 1 < n) {
          out += c + src[i + 1];
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (c === quote) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const SRC = stripComments(PAGE);

/** 抽出源码里每个 useEffect(...) 调用的完整实参体（圆括号配平，支持多行/嵌套）。 */
function extractUseEffectBodies(src: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf("useEffect(");
  while (idx !== -1) {
    const open = src.indexOf("(", idx);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(open + 1, end));
    idx = src.indexOf("useEffect(", end);
  }
  return out;
}

describe("read-workspace.tsx：建书生成流必须有卸载中止兜底", () => {
  const effects = extractUseEffectBodies(SRC);

  it("抽取器确实抓到了本组件的 useEffect（防止组件重构后扫描悄悄变空）", () => {
    expect(effects.length).toBeGreaterThanOrEqual(1);
  });

  it("存在空依赖 useEffect，cleanup 里 abort createAbortRef（卸载即中止在途生成）", () => {
    const unmountGuards = effects.filter(
      (b) => b.includes("createAbortRef.current?.abort()") && b.trimEnd().endsWith("[]")
    );
    expect(unmountGuards.length).toBeGreaterThanOrEqual(1);
  });

  it("abort 必须接到两条在途流上：verifyBook 与 streamChat 都传 ctrl.signal", () => {
    expect(SRC).toContain("verifyBook(title, author, ctrl.signal)");
    expect(SRC).toContain("signal: ctrl.signal");
  });

  it("卸载 abort 后走既有 AbortError 分支：两处 catch 判 AbortError，不建书不跳转", () => {
    // create 的 catch + generateBook 的 catch = 至少 2 处 AbortError 判断
    const abortCatches = (SRC.match(/name === "AbortError"/g) ?? []).length;
    expect(abortCatches).toBeGreaterThanOrEqual(2);
  });

  it("原有取消入口不得回退：弹窗「取消生成」按钮与 cancelCreate 仍在", () => {
    expect(SRC).toContain("const cancelCreate = () => createAbortRef.current?.abort()");
    expect(SRC).toContain('onClick={cancelCreate}');
  });
});
