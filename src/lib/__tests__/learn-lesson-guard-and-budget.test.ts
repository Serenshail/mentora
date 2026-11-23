import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ learn/[id] 页七处修复的回归锁（2026-11 复核） ============
 * ① genLesson 对「模型 200 但正文为空」静默无操作、轨迹却标 done——现在显式 failed
 *    阶段 + toast（与 AskCoach/use-chat 空回复守卫同口径）。
 * ② genLesson 无重入守卫 + 「重新生成」按钮无 loading/disabled——流式期间可叠加多条
 *    并发生成流（双倍计费 + flushNow 互相灌 buf + 落库竞态）。现在有 lessonGenRef
 *    同步守卫（state 在同 tick 双击下还是旧值）+ 按钮 loading 门控。
 * ③ 本页 AI 流式调用无超时/中止兜底：流中段挂起即永久 busy（判分锁死/占位日永卡）。
 *    现在 5 处裸调用全部带 AbortSignal.timeout 客户端总预算（graduation.ts:87 同款）。
 * ④ 重排长流程只有一条几秒即消失的 toast，无进行中状态且防重入——现在走 ensurePhaseCatalog
 *    同款 bgGen 通道（PhasePlanPanel 已订阅该键，busy/progress/error 全套展示）+ busy 重入守卫。
 * ⑤ 验收答案仅存组件内存，切日期/刷新即静默丢失——现在按 goal+day 分键 localStorage 草稿，
 *    判过清除（onChange 形状保持原样，learn-quiz-grading-locked 回归锁锚定它）。
 * ⑥ PhasePaywall 写死「¥9.9/月 · ¥99/年」违反 pricing.ts 唯一真源——现在读
 *    priceLabel(PLANS.month.price)/priceLabel(PLANS.year.price)。 */

const PAGE = readFileSync(join(process.cwd(), "src/app/learn/[id]/page.tsx"), "utf8");

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
const genLesson = SRC.slice(SRC.indexOf("const genLesson"), SRC.indexOf("/* 提交验收 */"));
const dayPanelState = SRC.slice(SRC.indexOf("const [lesson, setLesson]"), SRC.indexOf("/* 生成今日学习文档 */"));
const regenPhaseFlow = SRC.slice(SRC.indexOf("async function regenPhaseFlow"), SRC.indexOf("function PhasePlanPanel"));
const paywall = SRC.slice(SRC.indexOf("function PhasePaywall"), SRC.indexOf("/* 重排确认对话框"));
/* 「重新生成」三字先出现在 RegeneratePlan 的说明文案里——锚到按钮 onClick 里的 setLesson("") */
const regenBtn = SRC.slice(SRC.indexOf('setLesson("");') - 500, SRC.indexOf('setLesson("");') + 100);

describe("learn/[id]：讲义空回复不再静默标记成功", () => {
  it("genLesson 捕获 streamChat 返回值，空正文走 failed 阶段 + 显式 toast，不落 done", () => {
    expect(genLesson).toContain("const content = full || buf;");
    expect(genLesson).toContain("if (content.trim())");
    expect(genLesson).toContain("模型返回了空回复，请重试");
    expect(genLesson).toContain('state: "failed"');
    // done 轨迹只允许出现在有正文分支里
    const okBranch = genLesson.slice(genLesson.indexOf("if (content.trim())"), genLesson.indexOf("} catch"));
    expect(okBranch).toContain('state: "done"');
  });
});

describe("learn/[id]：讲义生成防重入（ref 同步守卫 + 按钮门控）", () => {
  it("genLesson 开头有 lessonGenRef 同步守卫，finally 释放", () => {
    const guardIdx = genLesson.indexOf("if (lessonGenRef.current) return;");
    const loadingIdx = genLesson.indexOf("setLessonLoading(true)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(loadingIdx).toBeGreaterThan(guardIdx);
    expect(genLesson).toContain("lessonGenRef.current = false;");
  });

  it("「重新生成」按钮带 loading={lessonLoading}（Button 内部 loading 即 disabled）", () => {
    expect(regenBtn).toContain("loading={lessonLoading}");
  });
});

describe("learn/[id]：AI 流式调用必须有客户端超时预算", () => {
  const withTimeout = (SRC.match(/signal: AbortSignal\.timeout\(/g) ?? []).length;
  it("5 处裸调用全部接入 AbortSignal.timeout（AskCoach 本有用户 signal，不计）", () => {
    // genLesson / submitQuiz / runDayDetail / ensurePhaseCatalog / RegeneratePlan(generate)
    expect(withTimeout).toBeGreaterThanOrEqual(5);
  });
  it("长生成任务预算 ≥ 90s（不得把预算写得过小误伤正常生成）", () => {
    const budgets = [...SRC.matchAll(/AbortSignal\.timeout\((\d+_000)\)/g)].map((m) => parseInt(m[1].replace("_", ""), 10));
    expect(budgets.length).toBe(withTimeout);
    for (const b of budgets) expect(b).toBeGreaterThanOrEqual(90_000);
  });
  it("submitQuiz 带 signal（否则流挂起 → grading 恒真、验收 UI 锁死）", () => {
    const quiz = SRC.slice(SRC.indexOf("const submitQuiz"), SRC.indexOf("if (g.overall === \"pass\")"));
    expect(quiz).toContain("AbortSignal.timeout(");
  });
});

describe("learn/[id]：重排长流程的进行中状态与防重入", () => {
  it("regenPhaseFlow 走 bgGen catalog 键：busy 重入守卫 + BgEntry 进行中/收尾", () => {
    expect(regenPhaseFlow).toContain("genKey(\"catalog\", goal.id, phase.id)");
    expect(regenPhaseFlow).toContain("bgGen.get(key)?.busy");
    expect(regenPhaseFlow).toContain("busy: true");
    expect(regenPhaseFlow.indexOf("st.busy = false;")).toBeGreaterThan(regenPhaseFlow.indexOf("bgGen.set(key, st)"));
  });
});

describe("learn/[id]：验收答案草稿持久化", () => {
  it("按 goal+day 分键读 localStorage 草稿，答案变化即写回", () => {
    expect(dayPanelState).toContain("mentora-quiz-draft-");
    expect(dayPanelState).toContain("localStorage.getItem(quizDraftKey)");
    expect(dayPanelState).toContain("localStorage.setItem(quizDraftKey, JSON.stringify(answers))");
  });
  it("判过（pass）即清草稿", () => {
    const passBranch = SRC.slice(SRC.indexOf('if (g.overall === "pass")'), SRC.indexOf("} else {", SRC.indexOf('if (g.overall === "pass")')));
    expect(passBranch).toContain("clearQuizDraft()");
  });
});

describe("learn/[id]：付费墙价格读 pricing.ts 唯一真源", () => {
  it("CTA 价格来自 priceLabel(PLANS…)，不再写死数字", () => {
    expect(paywall).toContain("priceLabel(PLANS.month.price)");
    expect(paywall).toContain("priceLabel(PLANS.year.price)");
    expect(paywall).not.toContain("¥9.9/月");
    expect(PAGE).toContain('import { PLANS, priceLabel } from "@/lib/pricing";');
  });
});
