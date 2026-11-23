import { describe, expect, it } from "vitest";
import { rebuildRtRetry } from "@/lib/rt-retry";

/* ============ 圆桌补答入口的历史重建（单元测试） ============
 * 背景：rtRetry 是 CouncilPage 的组件内存态（useState），路由切换/刷新即丢，
 * 但会话历史里的失败消息永久承诺「可单独重试」「可点『重试主持人纪要』」——
 * 不重建的话补救路径静默失效，用户只能整题重问。
 * 修复：rebuildRtRetry 纯函数（lib/rt-retry.ts）+ 页面在切回圆桌会话时重建。
 * 本文件直接单测纯函数：只看最后一轮、席位以最后一次出现为准、
 * 纪要在失败消息之后落库视为已补救。 */

type P = { id: string; name: string };
const seats: Record<string, P> = {
  a: { id: "a", name: "甲" },
  b: { id: "b", name: "乙" },
  c: { id: "c", name: "丙" },
};
const resolve = (id: string) => seats[id] ?? null;

const SEAT_OK = (name: string, take: string) => ({
  role: "assistant",
  content: `**【${name}】**\n\n${take}`,
});
const SEAT_FAIL = (name: string) => ({
  role: "assistant",
  content: `**【${name}】**（发言失败——本轮结束后可单独重试）`,
});
const HOST_FAIL = {
  role: "assistant",
  content: "> 主持人纪要生成失败：各席发言已完整保留，可点「重试主持人纪要」。",
};
const SUMMARY = (t: string) => ({ role: "assistant", content: `## 圆桌纪要\n\n${t}` });
const ASK = (q: string) => ({ role: "user", content: q });
const sess = (messages: { role: string; content: string }[], participants = ["a", "b", "c"]) => ({
  id: "s1",
  participants,
  messages,
});

describe("rebuildRtRetry：从会话历史重建圆桌补答入口", () => {
  it("部分失败 → 重建失败席位 + 本轮已有发言，question 取最后一轮的用户消息", () => {
    const r = rebuildRtRetry(
      sess([ASK("如何评估创业方向？"), SEAT_OK("甲", "看现金流量表"), SEAT_FAIL("乙"), SEAT_FAIL("丙")]),
      resolve
    );
    expect(r).not.toBeNull();
    expect(r!.sessionId).toBe("s1");
    expect(r!.question).toBe("如何评估创业方向？");
    expect(r!.seats.map((s) => s.id).sort()).toEqual(["b", "c"]);
    expect(r!.goodTakes).toEqual({ a: "看现金流量表" });
    expect(r!.note).toContain("2 席发言失败");
  });

  it("席位全好但主持人失败且纪要未出 → 只重试主持人（seats 为空）", () => {
    const r = rebuildRtRetry(sess([ASK("Q2"), SEAT_OK("甲", "x"), SEAT_OK("乙", "y"), HOST_FAIL]), resolve);
    expect(r).not.toBeNull();
    expect(r!.seats).toEqual([]);
    expect(r!.goodTakes["a"]).toBe("x");
    expect(r!.note).toBe("主持人纪要失败");
  });

  it("主持人失败后已补答重出纪要（纪要在失败消息之后）→ 视为已补救，不再提示", () => {
    const r = rebuildRtRetry(
      sess([ASK("Q3"), SEAT_OK("甲", "x"), SEAT_OK("乙", "y"), HOST_FAIL, SUMMARY("补答后重出的纪要")]),
      resolve
    );
    expect(r).toBeNull();
  });

  it("失败席位全部补答成功（同轮追加第二条同席位消息）→ 以最后一次出现为准，入口撤下", () => {
    const r = rebuildRtRetry(
      sess([
        ASK("Q4"),
        SEAT_OK("甲", "x"),
        SEAT_FAIL("乙"),
        SEAT_FAIL("丙"),
        SEAT_OK("乙", "补答1"),
        SEAT_OK("丙", "补答2"),
        SUMMARY("重出"),
      ]),
      resolve
    );
    expect(r).toBeNull();
  });

  it("只补答部分失败席位 → 剩余失败席位仍在入口里（与 live 流程同口径）", () => {
    const r = rebuildRtRetry(
      sess([ASK("Q4b"), SEAT_OK("甲", "x"), SEAT_FAIL("乙"), SEAT_FAIL("丙"), SEAT_OK("乙", "补答内容"), SUMMARY("重出")]),
      resolve
    );
    expect(r).not.toBeNull();
    expect(r!.seats.map((s) => s.id)).toEqual(["c"]);
    expect(r!.goodTakes).toEqual({ a: "x", b: "补答内容" });
    expect(r!.note).toContain("1 席发言失败");
  });

  it("失败后用户问了新问题且新一轮全成功 → 旧失败不复活", () => {
    const r = rebuildRtRetry(
      sess([
        ASK("旧问题"),
        SEAT_OK("甲", "x"),
        SEAT_FAIL("乙"),
        ASK("新问题"),
        SEAT_OK("甲", "x2"),
        SEAT_OK("乙", "y2"),
        SUMMARY("纪要"),
      ]),
      resolve
    );
    expect(r).toBeNull();
  });

  it("新一轮有新失败：goodTakes 只取本轮发言，上一轮旧 take 不得冒充本轮已有发言", () => {
    const r = rebuildRtRetry(
      sess([ASK("旧问题"), SEAT_OK("甲", "旧take"), SEAT_OK("乙", "旧take2"), ASK("新问题"), SEAT_OK("甲", "新take"), SEAT_FAIL("乙")]),
      resolve
    );
    expect(r).not.toBeNull();
    expect(r!.seats.map((s) => s.id)).toEqual(["b"]);
    expect(r!.goodTakes).toEqual({ a: "新take" });
  });

  it("无用户消息 / 席位全部失效 → null（与 live 流程「凑不够 2 席不开重试」同口径）", () => {
    expect(rebuildRtRetry(sess([]), resolve)).toBeNull();
    expect(rebuildRtRetry(sess([ASK("Q")], ["gone"]), resolve)).toBeNull();
  });

  it("已删除席位的失败消息不进 seats（按 participants 解析，解析不到即跳过）", () => {
    const r = rebuildRtRetry(sess([ASK("Q6"), SEAT_OK("甲", "x"), SEAT_FAIL("乙")], ["a", "b"]), resolve);
    expect(r).not.toBeNull();
    expect(r!.seats.map((s) => s.id)).toEqual(["b"]);
    expect(Object.keys(r!.goodTakes)).toEqual(["a"]);
  });
});
