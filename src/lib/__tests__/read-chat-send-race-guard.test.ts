import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /read/[id] 主聊天 doSend 竞态回归锁 ============
 * 背景：doSend 在 RAG 检索前就 setInput("")，而 streaming 只在 send 之后才变 true——
 * 检索在飞时（预算可长达 20s）输入框未禁用。此时再发一轮会把上一轮检索 abort 掉，
 * 上一条提问的协程在 `if (rac.signal.aborted) return;` 处静默退出：既不落库
 * （addBookMsg 在检查之后）也不上屏，用户输入就此消失且无任何提示。
 *
 * 修复：新增 retrieving 状态覆盖「send 之前的检索窗口」——doSend 在
 * streaming || retrieving 时拒绝新一轮（输入文字留在框里，检索完可发）；
 * 检索结束（完成/失败/被卸载）在 finally 复位；发送按钮 disabled={retrieving}
 * 给出可见反馈，而不是点了没反应。
 *
 * vitest 无 DOM，沿用仓库既有做法：读页面源码做语义锚点断言（不按行号）。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");

/** 抽出 doSend 函数体（const 声明起，花括号配平）。 */
function extractDoSend(src: string): string {
  const start = src.indexOf("const sendReadingQuestion = (text: string, retry = false) => {");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = start;
  let opened = false;
  for (; end < src.length; end++) {
    const ch = src[end];
    if (ch === "{") {
      depth++;
      opened = true;
    } else if (ch === "}") {
      depth--;
      if (opened && depth === 0) {
        end++;
        break;
      }
    }
  }
  return src.slice(start, end);
}

describe("read/[id] doSend 检索窗口竞态守卫", () => {
  const doSend = extractDoSend(PAGE);

  it("retrieving 状态存在且语义是「send 之前的检索窗口」", () => {
    expect(PAGE).toContain("const [retrieving, setRetrieving] = useState(false);");
  });

  it("doSend 拒绝在 streaming 或 retrieving 期间开启新一轮（输入不丢失）", () => {
    expect(doSend).toMatch(/if \(!text \|\| streaming \|\| retrieving \|\| isBusy\(\) \|\| ragAbortRef\.current\) return;/);
  });

  it("进入异步检索前就置位 retrieving（不是检索完成后才标记）", () => {
    const asyncStart = doSend.indexOf("void (async () => {");
    expect(asyncStart).toBeGreaterThan(-1);
    expect(doSend.slice(0, asyncStart)).toContain("setRetrieving(true)");
  });

  it("检索结束必须复位 retrieving（finally：完成/失败/卸载都覆盖）", () => {
    expect(doSend).toMatch(/\.finally\(\(\) => \{\s*if \(ragAbortRef\.current === rac\) ragAbortRef\.current = null;\s*setRetrieving\(false\);\s*\}\)/);
  });

  it("发送按钮在检索期间禁用（可见反馈，而非点击无响应）", () => {
    expect(PAGE).toMatch(/<Button onClick=\{doSend\} loading=\{streaming\} disabled=\{retrieving\}/);
  });

  it("检索前保存问题，重试时沿用原消息", () => {
    const persist = doSend.indexOf("addBookMsg(book.id, user)");
    expect(persist).toBeGreaterThan(doSend.indexOf("if (!retry)"));
    expect(persist).toBeLessThan(doSend.indexOf("await retrieveEnhanced"));
    expect(doSend).toContain("history,");
    expect(doSend).not.toContain("userText: text");
  });

  it("取消检索或切换账户后不会继续请求回答", () => {
    expect(doSend).toContain("if (rac.signal.aborted || useAppStore.getState()._storeUserId !== account) return;");
  });
});
