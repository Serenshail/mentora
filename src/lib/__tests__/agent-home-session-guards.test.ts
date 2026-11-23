import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ AgentHome 会话管理/发送入口的守卫（回归锁，v3 会话级运行态） ============
 * 四条相邻的会话管理问题，都在 agent-home.tsx 的会话 UI 上：
 *  1) 删除会话无确认：轨道（右栏）hover 垃圾桶与会话 tab 的 X 都直接调
 *     removeAgentSession，而删掉的是整段对话的全部消息（store.removeAgentSession
 *     直接 filter，无回收站）。对照 note-workspace 删一篇笔记都要 confirm。
 *  2) 生成进行中可删除发起会话：删掉后 appendAgentMsg(assistantMsg, runSid) 找不到
 *     该会话，store 兜底会新建一个只装回答的「新对话」幽灵会话，用户提问消失。
 *  3) 「清空」在生成中仍可点：清空后消息流（含流式正文、审批卡、过程块）整块卸载，
 *     生成过程对用户不可见。
 *  4) 发送按钮 `disabled` 与 send() 支持的「只带图片发送」矛盾。
 * v3 追加（UI-01）：停止与发送必须同位置同时刻可点；运行中输入框仍可编辑草稿。
 *
 * vitest 无 DOM 环境，沿用本仓库既有做法（静态扫描 + 剥注释）。 */

const SRC = readFileSync(
  fileURLToPath(new URL("../../components/agent-home.tsx", import.meta.url)),
  "utf8"
);

/** 剥离块/行注释（感知字符串与转义），只用于本测试的静态扫描。 */
function stripComments(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    const next = i + 1 < n ? input[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && i + 1 < n && input[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = input[i];
        if (c === "\\" && i + 1 < n) {
          out += c + input[i + 1];
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

/** 从 marker 起按花括号配平抽出函数/箭头体（跨过参数列表，取 `=> {` 之后的体）。 */
function body(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `找不到 ${marker}`).toBeGreaterThan(-1);
  const arrow = src.indexOf("=>", start + marker.length);
  const open = src.indexOf("{", arrow < 0 ? start + marker.length : arrow);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${marker} 未配平`);
}

describe("agent-home：删除会话先确认，且生成中的会话不可删", () => {
  const helper = body(CODE, "const requestRemoveSession =");

  it("helper 内既确认又拦生成中的会话", () => {
    expect(helper).toMatch(/confirm\(/);
    expect(helper).toMatch(/runningIds\.has\(sess\.id\)/);
    expect(helper).toMatch(/removeAgentSession\(sess\.id\)/);
  });

  it("删除时同时清掉该会话的运行态，不留孤儿运行/草稿", () => {
    expect(helper).toMatch(/cancelRun\(sess\.id/);
    expect(helper).toMatch(/dropSession\(sess\.id\)/);
  });

  it("两处删除入口（轨道垃圾桶 + 会话 tab 的 X）都改走 helper，不再裸调", () => {
    const calls = CODE.match(/removeAgentSession\(/g) ?? [];
    expect(calls.length, "只允许 helper 内部一处 removeAgentSession 调用").toBe(1);
    const entryPoints = CODE.match(/requestRemoveSession\(sess\)/g) ?? [];
    expect(entryPoints.length).toBe(2);
  });
});

describe("agent-home：清空 / 发送按钮的可用性守卫", () => {
  it("「清空」在生成中禁用（busy），避免把运行态 UI 整块卸掉", () => {
    const clearBtn = CODE.slice(CODE.indexOf("清空这段对话") - 400, CODE.indexOf("清空这段对话") + 80);
    expect(clearBtn).toMatch(/disabled=\{busy\}/);
    expect(clearBtn).toMatch(/if \(!busy\) clearAgentChat\(\)/);
  });

  it("发送按钮放行「只带附件」的发送，与 send() 的准入条件一致", () => {
    expect(CODE).toMatch(/const canSend = !!input\.trim\(\) \|\| !!attach;/);
    expect(CODE).toMatch(/disabled=\{!busy && !canSend\}/);
    expect(CODE).toMatch(/if \(\(!q && !att\) \|\| isRunningSession\(sid\)\) return;/);
  });
});

describe("agent-home：发送/停止同位（UI-01）与运行中草稿（UI-01/CX-02）", () => {
  it("同一个按钮按 busy 切换发送/停止，且有可读标签", () => {
    expect(CODE).toMatch(/onClick=\{\(\) => \(busy \? stop\(\) : void send\(\)\)\}/);
    expect(CODE).toMatch(/aria-label=\{busy \? "停止当前回答" : "发送消息"\}/);
  });

  it("运行中输入框不被禁用（草稿可继续写）", () => {
    const at = CODE.indexOf("ref={inputRef}");
    const inputTag = CODE.slice(at, at + 800);
    expect(inputTag).not.toMatch(/disabled=\{busy\}/);
  });

  it("运行中 Enter 不提交第二个任务，且中文输入法组合态不误发", () => {
    expect(CODE).toMatch(/if \(busy\) return;/);
    expect(CODE).toMatch(/e\.nativeEvent\.isComposing/);
  });
});

describe("agent-home：会话 tab 键盘可达 + 运行中会话可见", () => {
  it("会话 tab 是真 button（有 aria-current），不再是 div[role=button]", () => {
    expect(CODE).toMatch(/aria-current=\{sess\.id === activeId \? "true" : undefined\}/);
    expect(CODE).not.toContain('role="button"');
  });

  it("有会话在跑时 tab 上有转圈标记（运行态按会话隔离，不靠全局 busy）", () => {
    expect(CODE).toMatch(/runningIds\.has\(sess\.id\)/);
  });

  it("轨道删除按钮在无 hover 的触屏（<lg 工作台 slide-over）里也是可见的", () => {
    expect(CODE).toMatch(/max-lg:opacity-100/);
  });
});

describe("agent-home：滚动跟随（UI-03）", () => {
  it("发送强制回底，并清掉旧的「上翻暂停」意图", () => {
    expect(CODE).toMatch(/setFollowing\(sid, true\)/);
    expect(CODE).toMatch(/scrollToBottom\(sid\)/);
  });

  it("只有主动向上滚动才退出跟随（内容变高不算）", () => {
    expect(CODE).toMatch(/top < prev - 8/);
  });

  it("browsingHistory 时提供「回到最新」入口", () => {
    expect(CODE).toMatch(/回到最新/);
  });

  it("不操纵 window/学习页的滚动，只看消息容器", () => {
    expect(CODE).not.toMatch(/window\.scrollTo|document\.documentElement\.scrollTop/);
  });
});
