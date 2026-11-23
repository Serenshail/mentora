import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 人生伙伴：切换/新建会话必须作废在途单人流（回归锁） ============
 * 背景：CouncilPage 整页只有一份 useChat，messages/pending/streaming/error 与会话
 * 无关；而 newChat / openSession / startWith 都不停止在途单人流。于是 A 会话流式
 * 期间切到 B 时：
 *   ① pending 直接渲染进 B 的对话区（page.tsx 的 pending && !isRoundtable 分支）；
 *   ② A 完成时 use-chat 用 A 的线程闭包 setMessages([...next, assistant]) 整体替换
 *      B 的视图；
 *   ③ startWith 的 await send(开场白) 撞上 busyRef 守卫静默 return ""——B 既没有
 *      开场白，也没有任何报错或提示；error 横幅同理跨会话残留。
 * 修复：useChat 增加 cancel()（同步换代 + abort + 释放 busyRef + 清 pending/thinking/
 * streaming/error），切换/新建路径先 cancel；send 内部按代际丢弃旧流的 delta、完成
 * 回调、错误与 finally 收尾（只 abort 不够：旧 finally 会在新流开跑后清掉新流的
 * streaming/busy，UI 假装空闲 → 第三条流并发灌同一份 pending）。
 *
 * vitest 无 DOM 环境（未安装 jsdom），沿用本仓库既有做法
 * （brain-review-unmount-abort.test.ts / read-workspace-unmount-abort.test.ts）：
 * 直接读源码做语义锚点断言，按锚点而非行号，重排/换行不误报；扫描前剥离注释，
 * 防止把守卫注释掉骗过本锁。 */

const HOOK = readFileSync(join(process.cwd(), "src/lib/use-chat.ts"), "utf8");
const PAGE = readFileSync(join(process.cwd(), "src/app/council/page.tsx"), "utf8");

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

/** 取 marker 之后第一个箭头函数体 `=> { ... }`（花括号配平，含嵌套）。
 * 必须从 `=>` 后取，否则 `async (opts: {...})` 的形参类型字面量会被误当成函数体。 */
function bodyOf(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at === -1) return "";
  const arrow = src.indexOf("=> {", at);
  if (arrow === -1) return "";
  const open = arrow + 3;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

/** 取从 marker 起到 nextMarker 之前的源码片段（用于无花括号的表达式体函数）。 */
function sliceBetween(src: string, marker: string, nextMarker: string): string {
  const at = src.indexOf(marker);
  if (at === -1) return "";
  const end = src.indexOf(nextMarker, at + marker.length);
  return src.slice(at, end === -1 ? src.length : end);
}

const HOOK_SRC = stripComments(HOOK);
const PAGE_SRC = stripComments(PAGE);

describe("use-chat：cancel() 必须同步换代、abort、释放 busy 并清视图态", () => {
  it("hook 对外暴露 cancel（调用方才能接上）", () => {
    expect(HOOK_SRC).toMatch(/return\s*\{[^}]*\bcancel\b[^}]*\}/);
  });

  it("cancel 实现存在且三件事齐备：换代 / abort / 释放 busyRef", () => {
    const cancel = bodyOf(HOOK_SRC, "const cancel = useCallback(");
    expect(cancel).not.toBe("");
    expect(cancel).toMatch(/genRef\.current\s*(\+=|=\s*genRef\.current\s*\+)/); // 换代
    expect(cancel).toContain("abortRef.current?.abort()"); // 掐在途连接
    expect(cancel).toContain("busyRef.current = false"); // 同步释放，新会话开场白才发得出去
    for (const s of ["setPending(\"\")", "setStreaming(false)", "setError(null)"]) {
      expect(cancel).toContain(s); // 视图态不残留到新会话
    }
  });

  it("send 按代际丢弃视图写入：delta、整表替换、错误、finally 收尾都要过 alive()", () => {
    const send = bodyOf(HOOK_SRC, "async (opts: {");
    expect(send).not.toBe("");
    expect(send).toContain("const alive = () => genRef.current === gen");
    // delta 不灌进新会话的 pending
    expect(send).toMatch(/onDelta:\s*\(d\)\s*=>\s*\{[^}]*alive\(\)[^}]*setPending/);
    /* 完成时：先判代际；已 cancel 的只走 onDone 落回发起会话（sessionId 闭包是对的，
     * 修复前落库就正确），绝不用旧线程 setMessages 整体替换新会话视图。 */
    const afterStream = send.slice(send.indexOf("const full = await streamChat"));
    const guardAt = afterStream.indexOf("if (!alive())");
    expect(guardAt).toBeGreaterThan(-1);
    const guardBranch = afterStream.slice(guardAt, afterStream.indexOf("if (full)", guardAt));
    expect(guardBranch).toContain("opts.onDone?.(");
    expect(guardBranch).not.toContain("setMessages(");
    expect(guardAt).toBeLessThan(afterStream.indexOf("setMessages([...next, assistant])"));
    // 旧流的错误不显示到新会话
    expect(send).toMatch(/catch \(e\)[\s\S]*?if \(!alive\(\)\) return "";/);
    // 旧流的 finally 不许把新流的 streaming/busy 清掉
    expect(send).toMatch(/finally\s*\{\s*if \(alive\(\)\)\s*\{[\s\S]*?busyRef\.current = false/);
  });

  it("stop() 语义不被改坏：仍然只 abort，不换代（结果仍按原会话落库）", () => {
    const stop = sliceBetween(HOOK_SRC, "const stop = useCallback(", "useEffect(");
    expect(stop).toContain("abortRef.current?.abort()");
    expect(stop).not.toContain("genRef.current");
  });
});

describe("council/page.tsx：切换/新建会话必须 cancel 在途单人流", () => {
  it("页面确实拿到了 cancel", () => {
    expect(PAGE_SRC).toMatch(/useChat\(\)/);
    expect(PAGE_SRC).toMatch(/const \{[^}]*\bcancel\b[^}]*\} = useChat\(\)/);
  });

  it("newChat 先 cancel 再清视图（否则 delta 盖在选择页上）", () => {
    const newChat = bodyOf(PAGE_SRC, "const newChat = () =>");
    expect(newChat).toContain("cancel()");
    expect(newChat.indexOf("cancel()")).toBeLessThan(newChat.indexOf("setMessages([])"));
  });

  it("openSession（切换会话）在 activeId 变更前 cancel", () => {
    const open = bodyOf(PAGE_SRC, "const openSession = () =>");
    expect(open).toContain("cancel()");
    expect(open.indexOf("cancel()")).toBeLessThan(open.indexOf("setActiveId(s.id)"));
  });

  it("startWith 在建会话前 cancel 旧流", () => {
    const start = bodyOf(PAGE_SRC, "const startWith = (personaId: string) =>");
    expect(start).toContain("cancel()");
    expect(start.indexOf("cancel()")).toBeLessThan(start.indexOf("addSession("));
  });

  it("createRoundtable（选完与会者建桌）同样在 addSession 前 cancel", () => {
    const create = bodyOf(PAGE_SRC, "const createRoundtable = () =>");
    expect(create).toContain("cancel()");
    expect(create.indexOf("cancel()")).toBeLessThan(create.indexOf("addSession("));
  });

  it("打开单聊只创建空会话，等用户提问再调用模型", () => {
    const start = bodyOf(PAGE_SRC, "const startWith = (personaId: string) =>");
    expect(start).toContain("messages: []");
    expect(start).not.toContain("send(");
  });

  it("删除当前会话时的既有停止入口不回退", () => {
    expect(PAGE_SRC).toContain("if (streaming && deletingSession.id === activeId) stop();");
  });
});
