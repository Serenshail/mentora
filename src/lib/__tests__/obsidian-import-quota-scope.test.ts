import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ Obsidian 导入：配额标记必须与单次导入动作绑定（回归锁） ============
 * 背景（已由独立复核读码证实）：
 *   store.ts safeStorage.setItem 对所有 zustand persist 写的 QuotaExceededError
 *   统一 dispatchEvent(new CustomEvent("mentora:quota"))，不区分来源。
 *   旧实现把 onQuota 挂在组件挂载期的 useEffect 里、把命中写进跨调用存活的
 *   quotaHitRef，且只在「导入成功」分支复位。于是：先在 /brain 页发生一次与导入
 *   无关的配额失败（例如保存超长笔记），这个 ref 被永久置位；随后导入一个小目录
 *   即便写盘成功，也会走进 toast.error「已导入 N 篇，但本机存储已满」的假告警，
 *   误导用户去导出备份或改用「仅结构」重导。
 *
 * 修复：删除挂载期全局监听与持久 ref；改为 confirm 内的局部 let quotaHit，
 *   监听窗口只包住本次 importKnowledge 的同步写盘（进入 confirm 时自然清零），
 *   finally 里一律 removeEventListener。通用配额告警仍由 app-shell 的 onQuota
 *   （全局、带 warned 去重）负责，本组件只负责「本次导入是否写全」的判定。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法
 * （brain-review-unmount-abort.test.ts / learn-enter-ime-guard.test.ts 的静态扫描）：
 * 直接读组件源码做断言，按语义锚点而非行号，避免重排/换行误报。扫描前剥离注释，
 * 防止把注释里的说明文字当成仍在生效的代码。 */

const COMPONENT = readFileSync(
  join(process.cwd(), "src/components/brain/obsidian-import.tsx"),
  "utf8"
);

/** 剥离块/行注释（感知字符串与转义），只用于静态扫描。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++; // 保留换行
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

const SRC = stripComments(COMPONENT);

/** 抽出一个函数体（从 `const fn = async () => {` 的花括号起，配平到匹配的 `}`）。 */
function extractFunctionBody(src: string, decl: string): string | null {
  const start = src.indexOf(decl);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

const confirmBody = extractFunctionBody(SRC, "const confirm = async () =>");

describe("obsidian-import.tsx：配额命中标记必须绑定到单次 confirm（不得跨调用残留）", () => {
  it("抽取器确实抓到了 confirm 函数体（防止组件重构后扫描悄悄变空）", () => {
    expect(confirmBody).not.toBeNull();
    expect(confirmBody).toContain("importKnowledge(");
  });

  it("挂载期不再存在全局 mentora:quota 监听，也不存在跨调用存活的 quotaHitRef", () => {
    // 旧 bug 的两个根因：useEffect 里挂载监听 + 模块级/组件级持久 ref
    expect(SRC).not.toMatch(/useEffect\s*\(/);
    expect(SRC).not.toContain("quotaHitRef");
    // 组件函数体内不应出现在 confirm 之外的 addEventListener("mentora:quota")
    // （confirm 内那一处是允许的，且必须是唯一一处）
    const mountAddCount = (SRC.match(/addEventListener\(\s*"mentora:quota"/g) ?? []).length;
    expect(mountAddCount).toBe(1);
  });

  it("监听窗口在 confirm 内：局部标记清零 + 写入期间监听 + finally 摘监听", () => {
    const body = confirmBody as string;
    // 局部标记（非 ref），每次 confirm 进入时天然为 false → 与导入动作绑定
    expect(body).toMatch(/let\s+quotaHit\s*=\s*false/);
    expect(body).toContain("quotaHit = true");
    expect(body).toContain('addEventListener("mentora:quota", onQuota)');
    // 判定用的是局部标记，而不是任何 ref
    expect(body).toMatch(/if\s*\(\s*quotaHit\s*\)/);
    // 监听必须在 importKnowledge 之前注册（否则同步 setItem→dispatchEvent 会漏）
    expect(body.indexOf("addEventListener(\"mentora:quota\"")).toBeLessThan(
      body.indexOf("importKnowledge(")
    );
    // finally 里必须成对摘掉监听，异常/成功都不残留监听器
    const finallyIdx = body.lastIndexOf("finally");
    expect(finallyIdx).toBeGreaterThan(-1);
    const finallyBody = body.slice(finallyIdx);
    expect(finallyBody).toContain('removeEventListener("mentora:quota", onQuota)');
  });

  it("成功分支仍据配额命中切换 toast：命中给 error、未命中给 success（行为不回归）", () => {
    const body = confirmBody as string;
    expect(body).toContain("toast.error(");
    expect(body).toContain("toast.success(");
    expect(body).toContain("本机存储已满");
    expect(body).toContain("已导入");
  });
});
