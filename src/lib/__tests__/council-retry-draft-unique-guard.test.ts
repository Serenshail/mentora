import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ council 页六处修复的回归锁（2026-11 复核） ============
 * ① 圆桌发送被互斥拒绝（isSessionBusy）时输入框已被清空——doSend 的圆桌分支在
 *    roundtableSend 内部守卫之前就 setInput("")，用户草稿丢失；重试补答轮也会清掉
 *    当前会话未发送的草稿。修复：清空移到全部守卫之后，且只在实际消费草稿的 fresh
 *    发送路径清（if (!retry)）。
 * ② 深链「会话不存在」横幅的「知道了」无效：未命中目标从不登记 appliedDeepLinkRef，
 *    effect 重跑的 rAF 会把 missing 置回 true——点掉就闪回；且有效深链因 store 未水合
 *    会先误报一帧。修复：按目标记录关闭（deepLinkDismissedFor）+ 渲染期用当前
 *    sessions 复核。
 * ③ 自建人物允许重名：圆桌历史按 **【显示名】** 前缀归属各席发言，同名两席会把同一段
 *    历史错配给两人。修复：saveForged 对全部人物名（内置+自建）做唯一性拦截；智能体
 *    forge_persona 工具同规则。
 * ④ 结果驱动的 rtRetry 持有 persona 快照，人物删除后重试仍按旧 system 跑该席、写回
 *    孤儿发言。修复：重试时按当前人物表重解席位，已删席跳过、全删撤下入口。
 * ⑤ openSession 注释断言「不该补写进任何会话」与 use-chat.ts:87-93 刻意保留的 onDone
 *    落库语义相反——误导维护者删除活代码。修复：注释改为描述真实语义。
 * ⑥ personaDistillSchema 的 ZodError（message=issues JSON 转储）直接进 toast。修复：
 *    识别 ZodError 给可读中文文案（与同弹窗 extractJson 失败口径一致）。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/council/page.tsx"), "utf8");
const UI = readFileSync(join(process.cwd(), "src/components/ui.tsx"), "utf8");
const TOOLS = readFileSync(join(process.cwd(), "src/lib/agent/tool-executors.ts"), "utf8");

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

const SRC = stripComments(PAGE);
const doSend = SRC.slice(SRC.indexOf("const doSend"), SRC.indexOf("const sendSingle"));
const roundtableSend = SRC.slice(SRC.indexOf("const roundtableSend"), SRC.indexOf("/* 停止本轮"));
const saveForged = SRC.slice(SRC.indexOf("const saveForged"), SRC.indexOf("if (!hydrated) return <Skeleton"));

describe("council：圆桌发送守卫拒绝时草稿不丢", () => {
  it("doSend 的圆桌分支不再在守卫前清输入框", () => {
    expect(doSend).toContain("void roundtableSend(text);");
    expect(doSend).not.toMatch(/void roundtableSend\(text\);\s*\n\s*setInput\(""\);/);
  });

  it("清空移到 roundtableSend 全部守卫之后，且重试补答轮不清草稿", () => {
    const clearIdx = roundtableSend.indexOf('if (!retry) setInput("");');
    const guardIdx = roundtableSend.indexOf("isSessionBusy(sessionId)");
    expect(clearIdx).toBeGreaterThan(guardIdx); // 守卫（可拒绝）在先，清空在后
    expect(roundtableSend).toContain("if (!retry) setInput(\"\");");
  });
});

describe("council：重试补答按当前人物表重解席位（快照失效防护）", () => {
  it("重试席位先经 resolvePersona 过滤：已删除席跳过，全删撤下补答入口", () => {
    expect(roundtableSend).toContain("retrySeats = retry.seats.filter((s) => resolvePersona(s.id) != null)");
    expect(roundtableSend).toContain("if (retrySeats.length === 0)");
    expect(roundtableSend).toContain("setRtRetry(null)");
  });

  it("引擎的 onlySeats/participants 用过滤后的席位列表", () => {
    expect(roundtableSend).toContain("onlySeats: retry ? retrySeats.map((s) => s.id) : undefined");
    expect(roundtableSend).toContain("? retrySeats");
  });
});

describe("council：自建人物重名拦截（圆桌前缀按显示名归属发言）", () => {
  it("saveForged 在入库前对全部人物名做唯一性校验，重名不落库", () => {
    const addIdx = saveForged.indexOf("addCustomPersona({");
    const dupIdx = saveForged.indexOf("allPersonaOptions.some((p) => p.name === name)");
    expect(dupIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(dupIdx); // 校验在 addCustomPersona 之前
    expect(saveForged).toContain("return;");
  });

  it("智能体 forge_persona 工具走同一规则（内置席位名同样占用）", () => {
    const forge = TOOLS.slice(TOOLS.indexOf('case "forge_persona"'), TOOLS.indexOf('case "regenerate_phase"'));
    expect(forge).toContain("ALL_SEAT_METAS.some((m) => m.name === wantedName)");
    expect(forge).toContain("(store.customPersonas ?? []).some((c) => c.name === wantedName)");
    expect(forge).toContain("ok: false");
  });
});

describe("council：深链横幅可关闭且不误报有效深链", () => {
  it("「知道了」按目标记录关闭，不再依赖会被 rAF 闪回的 setDeepLinkMissing(false)", () => {
    expect(PAGE).toContain("deepLinkDismissedFor");
    expect(PAGE).toContain("onClick={() => setDeepLinkDismissedFor(requestedSession)}");
    expect(PAGE).not.toContain("onClick={() => setDeepLinkMissing(false)}");
  });

  it("横幅渲染带当前 sessions 复核与关闭态门（有效深链首帧不再误报）", () => {
    const banner = PAGE.slice(PAGE.indexOf("链接指向的会话不存在") - 600, PAGE.indexOf("链接指向的会话不存在"));
    expect(banner).toContain("!sessions.some((s) => s.id === requestedSession)");
    expect(banner).toContain("deepLinkDismissedFor !== requestedSession");
  });
});

describe("council：失败呈现与主题令牌", () => {
  it("forge catch 识别 ZodError 给可读文案，不再转储 issues JSON", () => {
    expect(PAGE).toContain('e.name === "ZodError"');
    expect(PAGE).toContain("模型输出的人物资料不完整");
  });

  it("openSession 注释与 use-chat 语义一致（cancel 后 onDone 照常落库是刻意保留）", () => {
    expect(PAGE).toContain("切回来能看到");
    expect(PAGE).not.toContain("本来就不该补写进任何会话");
  });

  it("本页 4 处墨底改用主题令牌 bg-ink，不再硬编码 #1d1d1f", () => {
    expect(PAGE).not.toContain("bg-[#1d1d1f]");
    expect((PAGE.match(/bg-ink/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("settings 头像回落底同样走 bg-ink", () => {
    const settings = readFileSync(join(process.cwd(), "src/app/settings/page.tsx"), "utf8");
    expect(settings).not.toContain("bg-[#1d1d1f]");
  });

  it("Input 组件有禁用视觉态（与 Button 的 disabled:opacity-45 同口径）", () => {
    const inputBlock = UI.slice(UI.indexOf("export function Input"), UI.indexOf("export function Textarea"));
    expect(inputBlock).toContain("disabled:opacity-45");
    expect(inputBlock).toContain("disabled:cursor-not-allowed");
  });
});
