import { describe, expect, it } from "vitest";
import { scoreDirect, scoreHandoff, scoreResume, isRefusalOrEmpty, looksTruncated } from "../../../scripts/eval-scoring-v2.mjs";

/* EVAL-01 口径校准 v2 的判据测试。
 * 关键回归：旧口径把「正确但简短」的翻译判负（in09），v2 必须判正。 */

describe("scoreDirect（v2：取消统一字数下限）", () => {
  it("in09 真实输出：58 字但正确 → PASS（旧口径 >60 门槛正因此误判）", () => {
    const t = "那只敏捷的棕色狐狸跃过了懒洋洋的狗。\n\n（这句是英文全字母句，26 个字母各至少出现一次，常用于打字机和字体测试。）";
    /* 实测 58 字——旧口径 CJKOK 要求 >60，正确翻译被判失败 */
    expect(t.length).toBeLessThanOrEqual(60);
    const r = scoreDirect(t);
    expect(r.pass).toBe(true);
  });

  it("极短但正确的翻译 → PASS（这是旧口径的误判点）", () => {
    const r = scoreDirect("那只敏捷的棕色狐狸跃过了懒洋洋的狗。");
    expect(r.pass).toBe(true);
    expect(r.checks.notRefusal).toBe(true);
  });

  it("空输出 → FAIL", () => {
    expect(scoreDirect("").pass).toBe(false);
  });

  it("拒答 → FAIL", () => {
    expect(scoreDirect("抱歉，我无法回答这个问题。").pass).toBe(false);
  });

  it("内部协议泄漏 → FAIL", () => {
    expect(scoreDirect("先调用工具，等待用户批准后再回答。这段是正文。").pass).toBe(false);
  });

  it("简单问题被强行转成建目标流程 → FAIL", () => {
    expect(scoreDirect("学习目标已创建，开始引导对话。").pass).toBe(false);
  });

  it("正常中长回答 → PASS", () => {
    const r = scoreDirect("calloc 会把分配的内存清零，malloc 不会。所以需要零初始化的场景用 calloc 更省一次手动清零。");
    expect(r.pass).toBe(true);
  });
});

describe("scoreHandoff（v2：看真实对象，不只看标签）", () => {
  it("有交接工具 + 目标已创建 + 背景已存 → PASS", () => {
    const r = scoreHandoff({
      handoffTools: ["新建学习目标"],
      text: "已为你创建学习目标。",
      created: { goals: 1, background: "有编程基础，每天两小时" },
    });
    expect(r.pass).toBe(true);
  });

  it("只有工具标签、目标其实没创建 → FAIL（旧口径会放过）", () => {
    const r = scoreHandoff({
      handoffTools: ["新建学习目标"],
      text: "好的。",
      created: { goals: 0, background: null },
    });
    expect(r.pass).toBe(false);
  });

  it("建了目标但背景为空 → FAIL（AQ-02 背景必须保留）", () => {
    const r = scoreHandoff({
      handoffTools: ["新建学习目标"],
      text: "已创建。",
      created: { goals: 1, background: "" },
    });
    expect(r.pass).toBe(false);
  });

  it("读不到 created 时不因背景判负（unknown 不算失败）", () => {
    const r = scoreHandoff({ handoffTools: ["新建学习目标"], text: "已创建学习目标。" });
    expect(r.checks.backgroundSaved).toBe("unknown");
    expect(r.pass).toBe(true);
  });

  it("无工具也无新对象 → FAIL", () => {
    expect(scoreHandoff({ handoffTools: [], text: "随便聊聊。", created: { goals: 0 } }).pass).toBe(false);
  });
});

describe("scoreResume（v2）", () => {
  it("有恢复工具 → PASS", () => {
    expect(scoreResume({ resumeTools: ["恢复工作流"], text: "继续上次的进度。" }).pass).toBe(true);
  });

  it("声称恢复但实际重建 → FAIL", () => {
    expect(scoreResume({ resumeTools: [], text: "我重新创建了一个新目标。" }).pass).toBe(false);
  });

  it("in28 实证：如实告知「没找到」并给选项（含重新立一个）→ PASS", () => {
    const t =
      "没找到。查了三个地方,都没有算法目标的痕迹: 目标列表只有 4 个 draft 状态；学习工作流恢复无；笔记库和长期记忆空。\n" +
      "两种走法,你挑: 重新立一个算法目标——你说想学什么方向我建好草稿；或者你其实想接着推进某个 draft 目标。";
    const r = scoreResume({ resumeTools: ["列出学习目标", "恢复工作流"], text: t });
    expect(r.pass).toBe(true);
    expect(r.checks.noRecreate).toBe(true);
    expect(r.checks.resumeHappened).toBe(true);
  });

  it("声称有进度却又重建 → FAIL（这是真正的错）", () => {
    const r = scoreResume({ resumeTools: [], text: "你的进度在这里。不过我重新创建了一个新目标给你。" });
    expect(r.pass).toBe(false);
  });
});

describe("辅助判据", () => {
  it("isRefusalOrEmpty 识别空与拒答", () => {
    expect(isRefusalOrEmpty("")).toBe(true);
    expect(isRefusalOrEmpty("   ")).toBe(true);
    expect(isRefusalOrEmpty("抱歉，我无法回答")).toBe(true);
    expect(isRefusalOrEmpty("这是一个正常回答，内容足够长。")).toBe(false);
  });

  it("looksTruncated 只认结构性证据（不再用末尾标点，避免把截到 600 字的表格判负）", () => {
    expect(looksTruncated("```js\nconst a = 1;")).toBe(true);           // 未闭合代码块
    expect(looksTruncated("接下来我会")).toBe(true);                     // 未兑现承诺
    /* 关键回归：截断到 600 字时以逗号结尾是正常现象，不得判截断 */
    expect(looksTruncated("很多人以为，")).toBe(false);
    expect(looksTruncated("| 维度 | list | tuple | 可变性 | 能改元素、增删 |")).toBe(false);
    expect(looksTruncated("这是一个完整回答。")).toBe(false);
    expect(looksTruncated("")).toBe(true);                              // 空输出
  });
});

/* ===== 两轮用例判据（2026-11-11 冻结，产品决定 §2） ===== */
import { scoreClarify, scoreHandoffRound2 } from "../../../scripts/eval-scoring-v2.mjs";

describe("scoreClarify（首轮：合理澄清 ≠ 交接完成）", () => {
  const goodText =
    "方向差别很大，先确认两件事：你学线性代数是为了什么（机器学习/考研/数学系）？现在的基础大概在什么水平？";
  it("合理澄清（问用途与基础）+ 未创建 → PASS", () => {
    const r = scoreClarify({ text: goodText, createdDelta: { goals: 0 } });
    expect(r.pass).toBe(true);
    expect(r.checks.noPrematureCreate).toBe(true);
  });
  it("问卷式盘问（≥3 问句 + 编号列表）→ FAIL", () => {
    const t = "1. 你的用途是什么？\n2. 你的基础是什么？\n3. 每天多少时间？";
    expect(scoreClarify({ text: t, createdDelta: { goals: 0 } }).pass).toBe(false);
  });
  it("首轮就创建目标 → FAIL（noPrematureCreate）", () => {
    expect(scoreClarify({ text: goodText, createdDelta: { goals: 1 } }).pass).toBe(false);
  });
  it("编造用户事实 → FAIL", () => {
    expect(
      scoreClarify({ text: "你是做数据分析的，那我们直接从矩阵开始。要继续吗？", createdDelta: { goals: 0 } }).pass
    ).toBe(false);
  });
  it("完全不澄清且空转（无问句无关键词）→ FAIL", () => {
    expect(scoreClarify({ text: "好的，线性代数是一门数学。", createdDelta: { goals: 0 } }).pass).toBe(false);
  });
});

describe("scoreHandoffRound2（二轮：真实交接）", () => {
  const expected = ["机器学习", "Python", "1.5"];
  it("真实创建 + 背景保存 + 不重问 + 有入口 → PASS", () => {
    const r = scoreHandoffRound2({
      text: "已按你说的建立目标：机器学习用的线代。[继续引导对话](/learn/new?goal=g1)",
      createdDelta: { goals: 1 },
      goal: { background: "会 Python 和一点高数，学线性代数是为了看懂机器学习论文公式，每天 1.5 小时" },
      expectedPoints: expected,
    });
    expect(r.pass).toBe(true);
    expect(r.checks.created).toBe(true);
    expect(r.checks.backgroundSaved).toBe(true);
  });
  it("只有工具卡、对象未创建（增量=0）→ FAIL", () => {
    const r = scoreHandoffRound2({
      text: "帮你建好了学习目标。", createdDelta: { goals: 0 },
      goal: { background: "机器学习 Python 1.5" }, expectedPoints: expected,
    });
    expect(r.pass).toBe(false);
  });
  it("背景没存关键点 → FAIL（AQ-02）", () => {
    const r = scoreHandoffRound2({
      text: "建好了。/learn/new?goal=g1", createdDelta: { goals: 1 },
      goal: { background: "" }, expectedPoints: expected,
    });
    expect(r.pass).toBe(false);
  });
  it("再次盘问已提供的信息 → FAIL（noReAsk）", () => {
    const r = scoreHandoffRound2({
      text: "建目标之前先问下：你每天能投入多少时间？/learn/new?goal=g1",
      createdDelta: { goals: 1 },
      goal: { background: "机器学习 Python 1.5" }, expectedPoints: expected,
    });
    expect(r.checks.noReAsk).toBe(false);
    expect(r.pass).toBe(false);
  });
});
