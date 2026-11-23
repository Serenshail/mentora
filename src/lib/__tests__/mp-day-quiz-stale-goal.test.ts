import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

/* ============ 小程序 day 页：评分窗口内目标被替换后，验收结果不得半截落库 ============
 * 事故链（pages/day/day.js applyQuizResult）：
 *   quiz-grade 是 10-60s 的非流式等待，applyQuizResult 沿用**提交时**捕获的
 *   goal/day 引用。期间 pullIfSafe→adoptCloud 可能整体替换 goals：
 *   - store.applyQuizPass / logQuiz 按 id 重查，查不到就静默 return；
 *   - store.addLearnKnowledge(goal, day, ...) 却直接读旧对象的 topic/day.title，
 *     照常把知识点写进第二大脑。
 *   结果 attempts/passed/迁移门/quizLog 全部没写，知识点却入库了，而 toast 与
 *   结果页都报告「验收判过」——用户回列表发现进度没动。
 * 修法：写前按 id 重取；没有落点就明确告知，绝不报成功、也不写知识点。
 *
 * 本测试真执行 day.js（stub wx/Page/chat/grade），用 store.state 摆出场景。 */

const requireCjs = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

/** 目标的最小形状：测试要直接读 plan.days 的 status/attempts，给具体类型避免 unknown */
interface GoalShape extends Dict {
  plan: {
    phases: Dict[];
    days: Record<string, Dict & { status?: string; attempts?: number }>;
  };
  quizLog?: Dict[];
}

interface StoreMod {
  state: { goals: GoalShape[]; knowledge: Dict[] };
}

interface PageCtx {
  /** 页面 data：常用字段给具体类型，其余走索引签名，避免断言处全是 unknown */
  data: {
    quizMode?: string;
    grade?: Dict;
    goalId?: string;
    dayId?: string;
    answers?: Dict;
    [k: string]: unknown;
  };
  setData: (patch: Dict) => void;
  applyQuizResult: (goal: Dict, day: Dict, g: Dict) => void;
}

let toasts: { title: string }[] = [];
let store: StoreMod;
let pageCfg: PageCtx;

function installWxStub() {
  const g = globalThis as unknown as Dict;
  g.wx = {
    getStorageSync: () => "",
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: (o: { title: string }) => toasts.push(o),
    showModal: () => {},
    setClipboardData: () => {},
    navigateBack: () => {},
    redirectTo: () => {},
  };
}

function loadDayPage() {
  const utils = join(ROOT, "miniprogram/utils");
  const cache = requireCjs.cache as unknown as Record<string, unknown>;
  for (const f of ["store.js", "util.js", "api.js", "mastery.js"]) delete cache[join(utils, f)];
  store = requireCjs(join(utils, "store.js")) as StoreMod;
  cache[join(utils, "chat.js")] = {
    id: "chat",
    filename: "chat",
    loaded: true,
    exports: { streamChat: () => Promise.resolve(""), extractJson: () => ({}) },
  } as unknown;
  cache[join(utils, "grade.js")] = {
    id: "grade",
    filename: "grade",
    loaded: true,
    exports: { normalizeQuizGrade: (g: Dict) => g },
  } as unknown;
  cache[join(utils, "stream-view.js")] = {
    id: "sv",
    filename: "sv",
    loaded: true,
    exports: {
      createStreamRenderer: () => ({ push: () => {}, flush: () => {}, cancel: () => {} }),
    },
  } as unknown;
  cache[join(utils, "schema.js")] = {
    id: "schema",
    filename: "schema",
    loaded: true,
    exports: { buildPhaseCtx: () => ({ ctx: "" }), phaseDraftToDay: () => ({}) },
  } as unknown;

  const pagePath = join(ROOT, "miniprogram/pages/day/day.js");
  delete cache[pagePath];
  let captured: PageCtx | null = null;
  (globalThis as unknown as Dict).Page = (cfg: PageCtx) => {
    captured = cfg;
  };
  requireCjs(pagePath);
  if (!captured) throw new Error("day.js 未调用 Page()");
  pageCfg = captured;
}

function seedGoal(): GoalShape {
  const goal = {
    id: "g1",
    topic: "测试目标",
    status: "active",
    quizLog: [] as Dict[],
    plan: {
      phases: [{ id: "p1", dayIds: ["d1"] }],
      days: {
        d1: {
          id: "d1",
          phaseId: "p1",
          title: "第一天",
          status: "active",
          attempts: 0,
          knowledgePoints: [{ id: "kp1", text: "知识点一" }],
          acceptance: [{ id: "a1", kind: "explain", question: "解释一下" }],
          qa: [],
        },
      },
    },
  };
  store.state.goals = [goal];
  store.state.knowledge = [];
  return goal;
}

function makePage(goal: Dict): PageCtx {
  const page = Object.assign({}, pageCfg) as PageCtx;
  page.data = JSON.parse(JSON.stringify(pageCfg.data)) as Dict;
  page.data.goalId = "g1";
  page.data.dayId = "d1";
  page.data.answers = { a1: "我的回答" };
  page.setData = function (patch: Dict) {
    Object.assign(this.data, patch);
  };
  // 提交时的快照引用（模拟评分窗口开始时的 goal/day）
  void goal;
  return page;
}

const PASS_GRADE = {
  overall: "pass",
  summary: "答得不错",
  reviewAdvice: "",
  transferQuestion: "迁移题",
  items: [
    { itemId: "a1", verdict: "correct", hintLevel: 0, feedback: "对", evidence: "e", kind: "explain" },
  ],
};

/** 知识点入库后会顺带生成一条 MOC 目录笔记，所以"有入库"= 至少一条非 MOC 笔记 */
function learnedTitles(): string[] {
  return store.state.knowledge
    .map((k) => String(k.title || ""))
    .filter((t) => t.indexOf("· 目录") < 0);
}

beforeEach(() => {
  toasts = [];
  installWxStub();
  loadDayPage();
});

afterEach(() => {
  store.state.goals = [];
  store.state.knowledge = [];
});

describe("mp-day-quiz-stale-goal: 评分窗口内目标被替换", () => {
  it("正常路径：写前重取的引用仍然可用，验收照常落库", () => {
    const goal = seedGoal();
    const page = makePage(goal);
    page.applyQuizResult(goal, store.state.goals[0].plan.days.d1, PASS_GRADE);

    const day = store.state.goals[0].plan.days.d1;
    expect(day.status).toBe("passed");
    expect(day.attempts).toBe(1);
    expect((store.state.goals[0].quizLog as Dict[]).length).toBe(1);
    expect(learnedTitles()).toEqual(["知识点一"]);
    expect(toasts.map((t) => t.title).join("|")).toContain("验收判过");
  });

  it("目标在评分窗口内被删：不报判过、不写知识点（旧实现在这里半截落库）", () => {
    const goal = seedGoal();
    const staleDay = store.state.goals[0].plan.days.d1;
    const page = makePage(goal);
    // adoptCloud 整体替换 goals（他端删除目标）
    store.state.goals = [];

    page.applyQuizResult(goal, staleDay, PASS_GRADE);

    // 知识点绝不能入库：这是旧实现唯一"成功"的写路径
    expect(store.state.knowledge).toEqual([]);
    // 用户必须看到没保存的交代，而不是「验收判过」
    expect(toasts.length).toBe(1);
    expect(toasts[0].title).toContain("已被删除");
    expect(toasts[0].title).not.toContain("判过");
    // 结果页仍然渲染反馈（判分内容不丢）
    expect(page.data.quizMode).toBe("result");
    expect((page.data.grade as Dict).overall).toBe("pass");
  });

  it("目标还在但学习日被删：同样不写知识点、不报成功", () => {
    const goal = seedGoal();
    const staleDay = store.state.goals[0].plan.days.d1;
    const page = makePage(goal);
    store.state.goals[0].plan.days = {};

    page.applyQuizResult(goal, staleDay, PASS_GRADE);

    expect(store.state.knowledge).toEqual([]);
    expect(toasts[0].title).toContain("已被删除");
  });

  it("目标被整体替换成新对象（adoptCloud 正常同步）：按 id 重取后照常落库", () => {
    const goal = seedGoal();
    const page = makePage(goal);
    // 模拟 adoptCloud：结构相同但对象引用全新的快照
    store.state.goals = JSON.parse(JSON.stringify(store.state.goals));
    // 用旧引用调（模拟提交时捕获的 goal/day）
    page.applyQuizResult(goal, goal.plan.days.d1, PASS_GRADE);

    // 写路径会 clone 后整体替换 plan，所以按 id 重新读当前对象
    expect(store.state.goals[0].plan.days.d1.status).toBe("passed");
    expect((store.state.goals[0].quizLog as Dict[]).length).toBe(1);
    expect(learnedTitles()).toEqual(["知识点一"]);
  });
});
