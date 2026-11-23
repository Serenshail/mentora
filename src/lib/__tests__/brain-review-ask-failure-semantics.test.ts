import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ /brain 复习出题：空回复显式报错 + 失败就地重试 + 总结不与旧题同屏（回归锁） ============
 * 三处旧缺陷（2026-11 复核）：
 *  ① askNext 丢弃 streamChat 返回值，模型 200 但正文为空（BYOK 自定义端点的现实场景，
 *     client.ts:175 按约定返回 ""，use-chat.ts:105-107 明确「必须显式报错」）时无条件
 *     setPhase("answer")——空问题卡 + 对着空题提交还会 recordReview 进 FSRS。
 *  ② 出题失败（catch）直接 setReviewQueue([]) 关窗丢整轮进度，与判卷失败「答案不丢、
 *     就地重试」的语义相反；同一个弹窗两种失败处置。
 *  ③ 出总结（空队列分支）只 setReviewQueue([])+setSummary，不重置 phase——渲染条件
 *     (phase === "answer"||"graded") 不受 summary 约束，判完最后一题点「下一个」后
 *     总结卡与旧题目/判卷内容同屏叠加，还带一个失效的「下一个」按钮。
 * 修复：askFailed 就地重试态 + 空回复检查 + 题目区渲染加 !summary 门。 */
const PAGE = readFileSync(join(process.cwd(), "src/app/brain/page.tsx"), "utf8");

/** 剥离块/行注释（brain-review-unmount-abort.test.ts 同款），防注释掉的旧代码骗过扫描 */
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
/** askNext 函数体（从「const askNext」到「const submitAnswer」） */
const askNext = SRC.slice(SRC.indexOf("const askNext"), SRC.indexOf("const submitAnswer"));
const askNextCatch = askNext.slice(askNext.indexOf("} catch {"));
/* 「复习弹窗」锚在注释里会被剥注释吃掉——用弹窗 open 条件（真实代码）定位 */
const modal = SRC.slice(SRC.indexOf("open={reviewQueue.length > 0 || !!summary}"));

describe("brain/page.tsx：出题空回复必须显式报错，不得静默进入答题态", () => {
  it("streamChat 返回值被捕获并做非空检查，检查先于 setPhase(\"answer\")", () => {
    expect(askNext).toContain("const full = await streamChat({");
    const guardIdx = askNext.indexOf("if (!full.trim())");
    const phaseIdx = askNext.indexOf('setPhase("answer")');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(phaseIdx).toBeGreaterThan(guardIdx); // 空回复必须在进入答题态之前拦下
  });

  it("空回复路径显式 toast（与 use-chat/AskCoach 同口径），不 setPhase", () => {
    const guardBlock = askNext.slice(askNext.indexOf("if (!full.trim())"), askNext.indexOf('setPhase("answer")'));
    expect(guardBlock).toContain("模型返回了空回复");
    expect(guardBlock).not.toContain('setPhase("answer")');
  });
});

describe("brain/page.tsx：出题失败就地保留进度，不再关窗丢弃整轮", () => {
  it("catch 不再 setReviewQueue([])（旧实现的关窗丢进度路径已废除）", () => {
    expect(askNextCatch).not.toContain("setReviewQueue([])");
    expect(askNextCatch).toContain("setAskFailed(true)");
  });

  it("存在就地重试入口：askFailed 卡片带重试按钮，重试复用未动的队列", () => {
    expect(SRC).toContain("const retryAsk = () =>");
    expect(SRC).toContain("void askNext(reviewQueue);");
    expect(modal).toContain("askFailed &&");
    expect(modal).toContain("重试出题");
  });
});

describe("brain/page.tsx：总结出现后旧题目/判卷渲染必须让位", () => {
  it("题目/判卷区与出题 spinner 都以 !summary 为渲染前置条件", () => {
    expect(modal).toContain('!summary && (phase === "answer" || phase === "graded")');
    expect(modal).toContain('!summary && phase === "ask"');
  });
});
