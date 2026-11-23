import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /brain 实时预览：段级提交必须 rebase 到当前正文（回归锁） ============
 * 背景（已由独立复核读码证实）：LiveBlocks 的 pendingRef 在 onChange 时捕获当时的
 * blocks 数组快照，commit 时 `next = [...pending.blocks]; next[i] = text;
 * onCommit(next.join("\n\n"))` 把「旧 blocks + 本块修改」整体替换正文。而文本区最长
 * 45s 的块级 AI 改写（onRewrite）在途时，用户可以点开别处、AI 结果经 setBody 落库，
 * 再 blur 提交——旧快照 join 后整体覆写正文，把 AI 追加的摘要/刚确认的润色静默丢掉
 * （无冲突检测、无提示）。
 *
 * 修复：新增纯函数 rebaseDraft(pending, currentBody)，段级草稿只替换目标段落，
 * 基于「当前正文」而不是编辑开始时的快照；卸载兜底用 bodyRef 取最新正文同样 rebase。
 *
 * vitest 无 DOM 环境（无 jsdom），沿用本仓库既有做法（note-workspace-liveblocks-remount
 * .test.ts 的静态扫描 + 剥注释）：读组件源码做语义锚点断言，不绑行号。
 * 扫描前先剥离注释，防止把修复代码注释掉骗过本锁。 */

const SRC = readFileSync(
  join(process.cwd(), "src/components/brain/note-workspace.tsx"),
  "utf8"
);

/** 剥离块/行注释（感知字符串与转义），只用于本测试的静态扫描。 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
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

const CODE = stripComments(SRC).replace(/\r\n/g, "\n");

describe("note-workspace：段级提交 rebase 到当前正文，不用旧快照整体覆写", () => {
  it("rebaseDraft 存在，且基于当前正文重组段落、只替换目标段", () => {
    expect(CODE).toContain("function rebaseDraft(");
    // 段级分支用当前正文切块（而不是编辑开始时的 blocks 快照）
    expect(CODE).toContain("splitBlocks(currentBody)");
    expect(CODE).toContain("cur[at] = pending.text");
  });

  it("commit 走 rebaseDraft(pending, body)，不再整体 join 旧快照写回", () => {
    const start = CODE.indexOf("const commit = () =>");
    expect(start, "必须保留 commit()").toBeGreaterThan(-1);
    const end = CODE.indexOf("setActive(null);", start);
    const commit = CODE.slice(start, end);
    expect(commit).toContain("rebaseDraft(pending, body)");
    // 旧实现的特征串：`const next = [...pending.blocks]; … next.join("\n\n")`
    expect(commit).not.toContain("next.join");
    expect(commit).not.toContain("[...pending.blocks]");
  });

  it("卸载兜底也按最新正文 rebase（bodyRef）——空依赖闭包读不到 body prop", () => {
    expect(CODE).toContain("rebaseDraft(pending, bodyRef.current)");
    expect(CODE).toContain("const bodyRef = useRef(body)");
  });

  it("原段落已被别处改写时不覆写整篇，改为追加保留（宁可多一段也不静默丢）", () => {
    expect(CODE).toContain("[...cur, pending.text].join");
  });
});
