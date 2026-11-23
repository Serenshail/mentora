import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /brain 复习会话：组件卸载必须作废并中止在途 AI 流（回归锁） ============
 * 背景：reviewGenRef/reviewAbortRef 的失效与 abort 此前只挂在三处——换轮开流
 * （askNext）、判卷开流（submitAnswer）、弹窗 onClose。用户在出题/判卷在途时
 * 直接点侧栏导航卸载 /brain 页，没有任何 unmount cleanup：流继续跑到上游完成
 * 才被丢弃（token 白烧），且流恰好在卸载瞬间已正常跑完时 recordReview 仍会
 * 把一次没答完的复习写进 FSRS。与 use-chat.ts 的既有设计（卸载即 abort，
 * 注释明言防 token 白烧/同轮重复计费）不一致。
 * 修复：BrainPage 挂载空依赖 useEffect，cleanup 里 gen++ + abort 双管齐下——
 * abort 掐断在途连接；gen 失效拦住「abort 时流已正常结束」的竞态（此时不再抛
 * AbortError，只有代际失效能挡住随后的 setVerdict/recordReview）。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （learn-enter-ime-guard.test.ts / seats.test.ts 的静态扫描）：
 * 直接读页面源码做断言，按语义锚点而非行号，重排/换行不误报。
 * 扫描前先剥离注释（负向验证发现：注释掉的旧代码会被裸扫描误匹配成"仍在"），
 * 防止把失效的 useEffect 注释掉骗过本锁。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/brain/page.tsx"), "utf8");

/** 剥离块/行注释（感知字符串与转义），只用于本测试的静态扫描。
 * 极端边界（模板串内嵌套反引号等）不保证——本页 UI 文案均为普通字符串，够用。 */
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

describe("brain/page.tsx：复习会话在途流必须有卸载兜底（gen 失效 + abort）", () => {
  const effects = extractUseEffectBodies(SRC);

  it("抽取器确实抓到了本页的 useEffect（防止页面重构后扫描悄悄变空）", () => {
    expect(effects.length).toBeGreaterThanOrEqual(2); // BrainUrlSync 的 URL 同步 + 卸载兜底
  });

  it("存在空依赖 useEffect，cleanup 同时做代际失效（gen++）与 abort", () => {
    const unmountGuards = effects.filter(
      (b) => b.includes("reviewGenRef.current++") && b.includes("reviewAbortRef.current?.abort()")
    );
    expect(unmountGuards.length).toBeGreaterThanOrEqual(1);
    // 空依赖：cleanup 只在卸载时执行（url 同步 effect 的依赖数组不是 []，不会误匹配）
    const unmountOnly = unmountGuards.filter((b) => b.trimEnd().endsWith("[]"));
    expect(unmountOnly.length).toBeGreaterThanOrEqual(1);
  });

  it("兜底缺一不可：只 abort 不失效代际，拦不住「流已正常跑完」竞态的 recordReview", () => {
    const unmountOnly = effects.filter(
      (b) => b.includes("reviewGenRef.current++") && b.trimEnd().endsWith("[]")
    );
    expect(unmountOnly.length).toBeGreaterThanOrEqual(1);
    for (const b of unmountOnly) {
      expect(b).toContain("reviewAbortRef.current?.abort()");
    }
  });

  it("原有三处失效/中止点不得回退：弹窗 onClose 与两条流开头的代际+中止仍在", () => {
    // onClose 的 gen++（后缀形式）+ 兜底 cleanup = 至少 2 处后缀自增
    const postfixIncr = (SRC.match(/reviewGenRef\.current\+\+/g) ?? []).length;
    expect(postfixIncr).toBeGreaterThanOrEqual(2);
    // askNext 开流、submitAnswer 开流、onClose、卸载兜底 = 至少 4 处 abort
    const aborts = (SRC.match(/reviewAbortRef\.current\?\.abort\(\)/g) ?? []).length;
    expect(aborts).toBeGreaterThanOrEqual(4);
  });
});
