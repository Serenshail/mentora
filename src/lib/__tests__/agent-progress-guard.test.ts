import { describe, expect, it } from "vitest";
import {
  digestOf,
  lookupRead,
  markRound,
  newProgressState,
  normalizeSignature,
  progressStats,
  recordRead,
  stallVerdict,
} from "../agent/progress-guard";

/* ============ RUN-01 无进展控制（A09） ============
 * 用户真实抱怨：「调整计划」反复读工具，把预算耗尽才说「已尽力」。
 * PRD §6.3 要求：识别非相邻重复与换参数空转，连续两轮无新证据就停止同策略，
 * 转为一次聚焦澄清或有依据的失败说明；同时**不能误杀研究型任务**（读新来源是合理进展）。 */

describe("签名与指纹规范化", () => {
  it("个人页面列表和详情是有效读取，创建和修改不缓存",()=>{
    const state=newProgressState();
    expect(recordRead(state,0,"manage_workspace",{action:"list"},'[{"id":"page-1"}]').advanced).toBe(true);
    expect(recordRead(state,1,"manage_workspace",{action:"read",id:"page-1"},'{"blocks":[{"id":"table"}]}').advanced).toBe(true);
    recordRead(state,2,"manage_workspace",{action:"update",id:"page-1"},"已更新");
    expect(lookupRead(state,"manage_workspace",{action:"update",id:"page-1"}).reuse).toBeUndefined();
  });
  it("参数键顺序不同视为同一次调用", () => {
    const a = normalizeSignature("get_goal", { topic: "Python", id: "g1" });
    const b = normalizeSignature("get_goal", { id: "g1", topic: "Python" });
    expect(a).toBe(b);
  });

  it("对象版本不同（id 变了）视为不同调用", () => {
    const a = normalizeSignature("get_goal", { id: "g1" });
    const b = normalizeSignature("get_goal", { id: "g2" });
    expect(a).not.toBe(b);
  });

  it("内容指纹忽略空白差异，但不同内容不同指纹", () => {
    expect(digestOf("阶段一：语法\n阶段二：文件")).toBe(digestOf("阶段一：语法   阶段二：文件"));
    expect(digestOf("阶段一：语法")).not.toBe(digestOf("完全不同的另一份内容，长度也不一样，用来确保指纹区分开。"));
  });
});

describe("只读结果复用", () => {
  it("同签名同版本第二次读取命中缓存（不再产生新信息）", () => {
    const st = newProgressState();
    const r1 = recordRead(st, 0, "get_goal", { id: "g1" }, "目标：Python，第二阶段 phase-files");
    expect(r1.advanced).toBe(true);

    const hit = lookupRead(st, "get_goal", { id: "g1" });
    expect(hit.reuse?.content).toContain("phase-files");

    const r2 = recordRead(st, 1, "get_goal", { id: "g1" }, "目标：Python，第二阶段 phase-files");
    expect(r2.advanced).toBe(false);
    expect(r2.note).toMatch(/重复读取/);
  });

  it("版本变化后缓存失效（重新读才算新信息）", () => {
    const st = newProgressState();
    recordRead(st, 0, "get_goal", { id: "g1" }, "旧内容 A");
    /* 计划被改过：同一 id 但内容不同 → 属于新信息 */
    const r = recordRead(st, 1, "get_goal", { id: "g1" }, "新内容 B，第二阶段标题已改");
    expect(r.advanced).toBe(true);
  });

  it("写入工具不进缓存（写入结果本身是副作用，绝不复用）", () => {
    const st = newProgressState();
    const r = recordRead(st, 0, "edit_phase", { id: "g1" }, "已修改");
    expect(r.advanced).toBe(false);
    expect(lookupRead(st, "edit_phase", { id: "g1" }).reuse).toBeUndefined();
  });
});

describe("换参数空转识别", () => {
  it("换了参数但结果一样 → 不算进展", () => {
    const st = newProgressState();
    recordRead(st, 0, "search_brain", { query: "Python 第二阶段" }, "没有相关笔记。");
    const r = recordRead(st, 1, "search_brain", { query: "Python 阶段二 文件" }, "没有相关笔记。");
    expect(r.advanced).toBe(false);
    expect(r.note).toMatch(/结果与之前相同/);
    expect(r.duplicateOf).toBeTruthy();
  });

  it("换参数且拿到不同内容 → 算进展", () => {
    const st = newProgressState();
    recordRead(st, 0, "get_note", { title: "笔记A" }, "笔记A 的正文内容，讲的是变量与类型。");
    const r = recordRead(st, 1, "get_note", { title: "笔记B" }, "笔记B 的正文内容，讲的是文件读写与异常处理。");
    expect(r.advanced).toBe(true);
  });

  it("非相邻重复也能识别（第 0 轮读的，第 3 轮再读）", () => {
    const st = newProgressState();
    recordRead(st, 0, "get_goal", { id: "g1" }, "目标内容 X");
    recordRead(st, 1, "list_goals", {}, "1 个目标：Python");
    recordRead(st, 2, "read_context", {}, "今日任务：变量与类型");
    /* 第 3 轮回头再读 g1：旧实现只比上一轮，会漏判 */
    const r = recordRead(st, 3, "get_goal", { id: "g1" }, "目标内容 X");
    expect(r.advanced).toBe(false);
  });
});

describe("研究型任务不被误杀", () => {
  it("web_search / read_url 读新来源算进展", () => {
    const st = newProgressState();
    expect(recordRead(st, 0, "web_search", { query: "Next.js 15" }, "5 条结果").advanced).toBe(true);
    expect(recordRead(st, 1, "read_url", { url: "https://nextjs.org/x" }, "正文…").advanced).toBe(true);
  });

  it("连续读多个网页不会触发空转收尾", () => {
    const st = newProgressState();
    for (let i = 0; i < 4; i++) {
      const r = recordRead(st, i, "read_url", { url: `https://a.test/${i}` }, `第 ${i} 页正文`);
      markRound(st, i, r.advanced, r.note);
    }
    expect(st.stalledStreak).toBe(0);
    expect(stallVerdict(st)).toBeNull();
  });
});

describe("空转收尾判定", () => {
  it("连续两轮无进展 → 给出停止同策略的收尾指令", () => {
    const st = newProgressState();
    recordRead(st, 0, "get_goal", { id: "g1" }, "目标内容 X");
    markRound(st, 0, true, "获得了新信息");
    const r1 = recordRead(st, 1, "get_goal", { id: "g1" }, "目标内容 X");
    markRound(st, 1, r1.advanced, r1.note);
    expect(stallVerdict(st)).toBeNull(); // 只 1 轮，还不够
    /* 第 3 轮必须也是**同一批对象**的重复读（换参数但结果相同），才是真空转。
     * 换一个从没读过的查询即使返回「没有相关笔记」也算新信息——PRD 的定义是
     * 「获得必要缺失信息」，读到了「确实没有」同样是新证据。 */
    const r2 = recordRead(st, 2, "get_goal", { topic: "Python", id: "g1" }, "目标内容 X");
    markRound(st, 2, r2.advanced, r2.note);
    const verdict = stallVerdict(st);
    expect(typeof verdict).toBe("string");
    expect(verdict as string).toMatch(/连续 2 轮没有获得新信息/);
    expect(verdict as string).toMatch(/聚焦问题/);
    expect(verdict as string).toMatch(/禁止再用同一批工具换参数试探/);
  });

  it("有进展就清零（不会因为历史空转一直卡住）", () => {
    const st = newProgressState();
    markRound(st, 0, false, "无新信息");
    markRound(st, 1, false, "无新信息");
    expect(stallVerdict(st)).not.toBeNull();
    markRound(st, 2, true, "获得了新信息");
    expect(st.stalledStreak).toBe(0);
    expect(stallVerdict(st)).toBeNull();
  });

  it("progressStats 可用于诊断（读了几次、几轮有进展）", () => {
    const st = newProgressState();
    recordRead(st, 0, "get_goal", { id: "g1" }, "A");
    recordRead(st, 1, "get_goal", { id: "g2" }, "B 内容不同");
    markRound(st, 0, true, "x");
    markRound(st, 1, true, "y");
    const s = progressStats(st);
    expect(s.reads).toBe(2);
    expect(s.advancedRounds).toBe(2);
    expect(s.stalledStreak).toBe(0);
  });
});
