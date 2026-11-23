/* 小程序核心逻辑冒烟（Node 环境跑，wx 用内存 stub）——不入包 */
const path = require("path");
const proj = path.join(__dirname, "..", "miniprogram");

// ---- wx stub ----
const storage = {};
global.wx = {
  getStorageSync: (k) => storage[k],
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
  showToast: () => {}
};

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", name); }
}

/* ---- utf8 增量解码：把含中文/emoji 的串按 1 字节切开喂 ---- */
const { Utf8Decoder } = require(path.join(proj, "utils/utf8.js"));
const sample = "你好 Mentorα 👋 tail";
const bytes = Buffer.from(sample, "utf8");
const dec = new Utf8Decoder();
let out = "";
for (const b of bytes) out += dec.push(Uint8Array.from([b]).buffer);
ok("utf8 byte-split decode", out === sample);

/* ---- md 渲染 ---- */
const md = require(path.join(proj, "utils/md.js"));
const lesson = [
  "## ② 知识点穷尽",
  "",
  "- **zero-shot**：不给例子，直接下指令",
  "- 看 `few-shot` 与[官方指南](https://x.ai/a?b=1)",
  "",
  "```python",
  "print('hi')",
  "```",
  "",
  "> 引用一行",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
].join("\n");
const parsed = md.parse(lesson);
ok("md heading", parsed.blocks.some((b) => b.t === "h" && b.level === 2));
ok("md list bold+code+link", parsed.blocks.some((b) => b.t === "list" && b.items.length === 2));
ok("md code block", parsed.blocks.some((b) => b.t === "code" && b.text.includes("print")));
ok("md quote", parsed.blocks.some((b) => b.t === "quote"));
ok("md table 2 rows", parsed.blocks.some((b) => b.t === "table" && b.rows.length === 2));
ok("md links extracted", parsed.links.length === 1 && parsed.links[0].url === "https://x.ai/a?b=1");
ok("md rich-text nodes", parsed.blocks[0].nodes.length > 0 && parsed.blocks[0].nodes[0].name === "span");
ok("md plain strips", md.plain("**粗**和`码`[[链]]").includes("粗") && !md.plain("**粗**").includes("**"));

/* ---- extractJson ---- */
const { extractJson, streamChat } = require(path.join(proj, "utils/chat.js"));
ok("extractJson fenced", extractJson('前缀```json\n{"a":1}\n```后缀').a === 1);
ok("extractJson bare array first", Array.isArray(extractJson('x [ {"i":1},{"i":2} ] y')));
ok("extractJson nested", extractJson('{"a":{"b":[1,2]}}').a.b.length === 2);

/* ---- grade 归一化（证据强制） ---- */
const g1 = require(path.join(proj, "utils/grade.js")).normalizeQuizGrade({
  items: [{ itemId: "x", verdict: "pass", feedback: "好", evidence: "" }],
  overall: "pass",
});
ok("quiz no-evidence demoted", g1.overall === "fail" && g1.items[0].verdict === "ungradable");
const g2 = require(path.join(proj, "utils/grade.js")).normalizeQuizGrade({
  items: [{ itemId: "x", verdict: "correct", feedback: "好", evidence: "讲义原文…" }],
  overall: "pass",
  transferQuestion: "变式题？",
});
ok("quiz with evidence passes", g2.overall === "pass" && g2.transferQuestion === "变式题？");
const g3 = require(path.join(proj, "utils/grade.js")).normalizeReviewGrade({ verdict: "PASS", evidence: "", feedback: "还行" });
ok("review no-evidence fail", g3.verdict === "fail");

/* ---- 掌握状态机 ---- */
const mastery = require(path.join(proj, "utils/mastery.js"));
ok("apply no-hint → transferable", mastery.masteryFromQuiz([{ verdict: "correct", hintLevel: 0, kind: "apply" }]) === "transferable");
ok("hint5 → exposed", mastery.masteryFromQuiz([{ verdict: "correct", hintLevel: 5 }]) === "exposed");
ok("partial → guided", mastery.masteryFromQuiz([{ verdict: "partially_correct" }]) === "guided");

/* ---- store 写路径（验收过门 → 迁移解锁 → 知识入库 → 复习档） ---- */
const store = require(path.join(proj, "utils/store.js"));
store.onLogin("user-test");
const gid = store.seedSampleGoal();
let goal = store.goalById(gid);
ok("seed goal active day1", goal.plan.days.d1.status === "active" && goal.plan.days.d2.status === "locked");

store.setDayStatus(gid, "d1", "passed", { pendingUnlock: true, transferQuestion: "TQ" });
goal = store.goalById(gid);
ok("pass keeps gate", goal.plan.days.d1.status === "passed" && goal.plan.days.d1.pendingUnlock === true);
ok("next stays locked (真门)", goal.plan.days.d2.status === "locked");

store.completeTransfer(gid, "d1", "我的回答");
goal = store.goalById(gid);
ok("transfer unlocks next", goal.plan.days.d1.pendingUnlock === false && goal.plan.days.d2.status === "active");

store.addLearnKnowledge(goal, goal.plan.days.d1, "independent");
ok("knowledge ingested", store.state.knowledge.some((k) => k.title === "zero-shot 与 few-shot 的区别"));
ok("MOC created", store.state.knowledge.some((k) => k.title === goal.topic.split(" · ")[0] + " · 目录") || store.state.knowledge.some((k) => (k.tags || []).includes("MOC")));
const before = store.state.knowledge.length;
store.addLearnKnowledge(goal, goal.plan.days.d1, "independent");
ok("knowledge deduped", store.state.knowledge.length === before);

const due = store.dueReviews();
ok("new notes due today", due.length >= 2);
store.recordReview(due[0].id, true);
const reviewed = store.knowledgeById(due[0].id);
ok("review ladder stage1 +3d", reviewed.reviewStage === 1 && reviewed.nextReviewAt > new Date().toISOString().slice(0, 10));
// Web 同语义：independent 需要 passReps>=4 且 stability>=21 才升 durable——单次复习保持原级
ok("review mastery stays independent", reviewed.masteryStatus === "independent");

store.incrementAttempts(gid, "d2");
ok("attempts++", store.goalById(gid).plan.days.d2.attempts === 1);

// 强制跳过解锁链（跳过也要记 quizLog，与 Web 同语义）
store.setDayStatus(gid, "d2", "skipped");
store.logQuiz(gid, {
  dayId: "d2",
  date: new Date().toISOString().slice(0, 10),
  passed: false,
  forced: true,
  items: []
});
goal = store.goalById(gid);
ok("skip unlocks d3", goal.plan.days.d2.status === "skipped" && goal.plan.days.d3.status === "active");
ok("skip logged forced", goal.quizLog.some((q) => q.forced === true));

/* ---- config/api 模块可加载 ---- */
const config = require(path.join(proj, "config.js"));
ok("config default prod", config.current().indexOf("https://") === 0);

/* ============ Mini V1.0：协议归一化 + 计划构建（utils/schema.js） ============ */
const schema = require(path.join(proj, "utils/schema.js"));

/* splitGoalReply：GOAL_READY 标记形态 */
const cardReply =
  '好的，先明确方向。<!--GOAL_READY-->\n```json\n{"topic":"系统架构","direction":"三个月内通过软考架构","domainKind":"exam","motivation":"升职","background":"五年后端","weeklyHours":6,"learnerProfile":["晚上学"],"successCriteria":["真题 45 分以上"],"assumptions":["不承诺日期"]}\n```';
const cardR = schema.splitGoalReply(cardReply);
ok("goal card: 标记形态出卡", cardR.card && cardR.card.topic === "系统架构" && cardR.card.domainKind === "exam");
ok("goal card: prose 已剔 json", cardR.prose.length > 0 && cardR.prose.indexOf('"topic"') < 0);
/* 裸 JSON（模型漏标记） */
const cardR2 = schema.splitGoalReply(
  '聊两句\n{"topic":"Rust","direction":"能写小工具","domainKind":"coding","motivation":"兴趣","background":"会 C","weeklyHours":4,"successCriteria":["写出一个 CLI"]}'
);
ok("goal card: 裸 json 出卡", cardR2.card && cardR2.card.topic === "Rust");
ok("goal card: 普通回复不出卡", schema.splitGoalReply("你每周能投入多久？").card === null);

/* masterDraftToPlan：estDays 字符串容错 + 标题公式 + 激活起点 */
const mPlan = schema.masterDraftToPlan(
  {
    summary: "整体路线",
    totalDaysEstimate: 9,
    phases: [
      { title: "打基础", outcome: "能跑起来", estDays: "3", outline: ["语法", "练习"], boundary: "不碰宏" },
      { title: "做项目", outcome: "能交付", estDays: 6, outline: ["CLI"] }
    ]
  },
  { weeklyHours: 5 }
);
ok("master plan: 阶段标题公式", mPlan.phases[0].title === "阶段1 · 打基础" && mPlan.phases[1].title === "阶段2 · 做项目");
ok("master plan: 首阶段 active 其余 locked", mPlan.phases[0].status === "active" && mPlan.phases[1].status === "locked");
ok("master plan: estDays 字符串容错", mPlan.totalDays === 9);
ok("master plan: 无天目录 planned=false", mPlan.phases[0].planned === false && mPlan.phases[0].dayIds.length === 0);
ok("master plan: boundary 落档", mPlan.phases[0].boundary === "不碰宏");

/* normPhaseList + setPhaseCatalog：目录落库 → stub 占位 → 首天激活 */
const catList = schema.normPhaseList({
  boundary: "只学核心",
  days: [
    { title: "Day 1：入门", knowledgePoints: ["a", { text: "b", knowledgeType: "procedure" }] },
    { title: "Day 2：进阶", knowledgePoints: ["c"] }
  ]
});
ok("phase list: boundary + 2 天", catList.boundary === "只学核心" && catList.days.length === 2);
const catGoalId = store.addGoal({
  id: "g-cat",
  topic: "测试目标",
  direction: "方向",
  domainKind: "coding",
  motivation: "m",
  background: "b",
  weeklyHours: 5,
  successCriteria: ["x"],
  status: "active",
  createdAt: new Date().toISOString(),
  quizLog: [],
  intakeTranscript: [],
  plan: JSON.parse(JSON.stringify(mPlan))
});
store.setPhaseCatalog(
  "g-cat",
  mPlan.phases[0].id,
  catList.boundary,
  catList.days.map(function (d, i) {
    return { id: "cd" + (i + 1), title: d.title, knowledgePoints: d.knowledgePoints };
  })
);
const catGoal = store.goalById("g-cat");
const catPhase = catGoal.plan.phases[0];
ok("catalog: dayIds 接通", catPhase.dayIds.join(",") === "cd1,cd2" && catPhase.catalog.length === 2);
ok("catalog: stub 占位 + 次天仍锁", catGoal.plan.days.cd1.stub === true && catGoal.plan.days.cd2.status === "locked");
ok("catalog: 首天激活 + 阶段激活", catGoal.plan.days.cd1.status === "active" && catPhase.status === "active");
ok("catalog: planned 仍 false（有 stub）", catPhase.planned === false);

/* phaseDraftToDay：单日细节容错（year 字符串/kind 非法/acceptance kind 回落） */
const dayDraft = schema.phaseDraftToDay(
  {
    title: "Day 1：入门",
    knowledgePoints: ["a", { text: "b", knowledgeType: "PROCEDURE" }],
    resources: [
      { title: "官方文档", url: "https://x.dev/a", why: "w", year: "2025年", kind: "doc" },
      { title: "坏链资源", url: "ftp://nope", why: "w" }
    ],
    method: "读→练",
    example: { title: "t", description: "d", code: "print(1)" },
    acceptance: [
      { kind: "explain", question: "q1" },
      { kind: "bogus", question: "q2" }
    ]
  },
  catPhase.id,
  "cd1"
);
ok("phase day: knowledgeType 大写归一", dayDraft.knowledgePoints[1].knowledgeType === "procedure");
ok("phase day: year 字符串解析", dayDraft.resources[0].year === 2025);
ok("phase day: 非 http url 剥离（资源保留，与 Web 同）", dayDraft.resources.length === 2 && dayDraft.resources[1].url === undefined);
ok("phase day: 验收 kind 回落 apply", dayDraft.acceptance[1].kind === "apply");
store.setDayDetail("g-cat", catPhase.id, "cd1", dayDraft);
const catGoal2 = store.goalById("g-cat");
const cd1 = catGoal2.plan.days.cd1;
ok("setDayDetail: stub 摘除 + 细节落位", cd1.stub === false && cd1.acceptance.length === 2 && cd1.method === "读→练");
ok("setDayDetail: 运行态保留（active）", cd1.status === "active" && cd1.attempts === 0);
ok("setDayDetail: 目录标题优先", cd1.title === "Day 1：入门");

/* 阅读目标归一化 */
ok("reading goal: 枚举回落 understand", schema.normReadingGoal({ primary: "bogus" }).primary === "understand");
ok("reading goal: secondary 非法剔除", schema.normReadingGoal({ primary: "think", secondary: ["apply", "nope"] }).secondary.join(",") === "apply");
ok("goalText: 未设定", schema.goalText(null) === "未设定");
const gt = schema.goalText({ primary: "think", secondary: ["apply"], intent: "用于审计", background: "懂 SQL" });
ok("goalText: 主次目标+意图拼接", gt.indexOf("主目标 思考") === 0 && gt.indexOf("应用") > 0 && gt.indexOf("审计") > 0);

/* 三重验收归一化 */
const genQ = schema.normAssessGen({
  questions: [
    { kind: "bogus", question: "a" },
    { question: "b" },
    { question: "c" },
    { question: "d" }
  ]
});
ok("assess gen: kind 回落 explain + 截 3", genQ.questions.length === 3 && genQ.questions[0].kind === "explain");
const agGrade = schema.normAssessGrade({
  results: [
    { kind: "explain", level: "mastered", evidence: "用户原话", feedback: "好" },
    { kind: "connect", level: "weird", feedback: "x" }
  ],
  suggestion: "补课建议",
  misconception: { concept: "误解甲", note: "把 A 当成 B" }
});
ok("assess grade: 非法 level 回落 partial", agGrade.results[1].level === "partial");
ok("assess grade: misconception 带出", agGrade.misconception && agGrade.misconception.concept === "误解甲");

/* ============ Mini V1.0：阅读系统 store 写路径 ============ */
store.onLogin("u-read");
const bidV1 = store.createBookFromPlan(
  "测试之书",
  "作者甲",
  "",
  {
    map: { coreProblem: "P", authorStance: "S", lineage: "L", controversies: "C" },
    chapters: [
      { title: "第一章", focusQuestion: "q1?" },
      { title: "第二章", focusQuestion: "q2?" },
      { title: "第三章", focusQuestion: "q3?" }
    ]
  },
  "verified"
);
const bookV1 = store.bookById(bidV1);
ok("建书: map 四区域 + verification", bookV1.map && bookV1.map.coreProblem === "P" && bookV1.verification === "verified");
store.updateBook(bidV1, {
  goal: { primary: "think", secondary: ["apply"], intent: "", background: "", inferred: false, setAt: new Date().toISOString() }
});
ok("阅读目标: setBookGoal 落档", store.bookById(bidV1).goal.primary === "think");

/* 手动读完不写 masteredAt；验收通过才写 */
const chV1 = store.bookById(bidV1).chapters[0].id;
store.setChapterStatus(bidV1, chV1, "done");
const chAfterManual = store.bookById(bidV1).chapters[0];
ok("手动读完: done 但无 masteredAt", chAfterManual.status === "done" && !chAfterManual.masteredAt);
store.addChapterAssessment(bidV1, { chapterId: chV1, kind: "explain", question: "q", answer: "a", level: "mastered", evidence: "e1", feedback: "f" }, { concept: "误解甲", note: "把 A 当 B" });
store.addChapterAssessment(bidV1, { chapterId: chV1, kind: "apply", question: "q2", answer: "a2", level: "mastered", evidence: "e2", feedback: "f2" });
store.markChapterMastered(bidV1, chV1, "e1 e2");
const bAfterMaster = store.bookById(bidV1);
ok("验收通过: masteredAt 落档", Boolean(bAfterMaster.chapters[0].masteredAt) && bAfterMaster.chapters[0].status === "done");
ok("验收档案: assessments 追加", (bAfterMaster.assessments || []).length === 2);
ok("学习状态: misconception 两态落库", bAfterMaster.learning.misconceptions.some(function (m) { return m.concept === "误解甲" && m.clarified === false; }));
ok("学习状态: 证据入档", bAfterMaster.learning.evidence.some(function (e) { return e.text === "e1 e2"; }));

/* 沉淀：question/unresolved 联动待解决问题 */
store.addBookDeposit(bidV1, { type: "question", text: "为什么甲会这样？" });
const bAfterDeposit = store.bookById(bidV1);
ok("沉淀: 七类落库", bAfterDeposit.deposits.length === 1 && bAfterDeposit.deposits[0].type === "question");
ok("沉淀: 待解决问题联动", bAfterDeposit.learning.unresolvedQuestions.indexOf("为什么甲会这样？") >= 0);

/* 整本五态：finished/mastered 联动 */
store.setBookReadStatus(bidV1, "finished");
ok("五态: finished 联动 finishedAt+status", store.bookById(bidV1).readStatus === "finished" && Boolean(store.bookById(bidV1).finishedAt) && store.bookById(bidV1).status === "done");
store.setBookReadStatus(bidV1, "mastered");
ok("五态: mastered 联动 masteredAt", store.bookById(bidV1).readStatus === "mastered" && Boolean(store.bookById(bidV1).masteredAt));

/* recap 入第二大脑：source=read + 进复习队列（Web addKnowledge read 路径同语义） */
store.addReadKnowledge([{ title: "《测试之书》· 第一章", body: "本章小结正文", domain: "测试之书" }], "《测试之书》");
const recapNote = store.state.knowledge.filter(function (k) { return k.title === "《测试之书》· 第一章"; })[0];
ok("recap 入库: source=read", Boolean(recapNote) && recapNote.source === "read");
ok("recap 入库: 进复习队列", Boolean(recapNote && recapNote.nextReviewAt));


/* ============ 结业回归锁（曾经的真 bug） ============
 * unlockNext 早期直接给传入对象赋 status="done"，而调用方传的是临时 shadow，
 * 赋值丢失 → 目标永远 active（首页永远"进行中"、结业回路永不触发）。
 * 这里把修复钉死：全部走完必须 done + needsGraduation。 */
function finishAll(userId, mode) {
  store.onLogin(userId);
  const gid2 = store.seedSampleGoal();
  const gg = store.goalById(gid2);
  const ids = gg.plan.phases[0].dayIds;
  ids.forEach((id) => {
    if (mode === "skip") {
      store.setDayStatus(gid2, id, "skipped");
    } else {
      store.setDayStatus(gid2, id, "passed", { pendingUnlock: true, transferQuestion: "q" });
      store.completeTransfer(gid2, id, "a");
    }
  });
  return store.goalById(gid2);
}
const doneGoal = finishAll("u-done", "pass");
ok("完成全部天 → goal.status=done", doneGoal.status === "done");
ok("完成全部天 → needsGraduation", doneGoal.needsGraduation === true);
const skippedAll = finishAll("u-skip", "skip");
ok("全部跳过也算完成", skippedAll.status === "done");

/* 中间态不得提前 done */
store.onLogin("u-mid");
const gidMid = store.seedSampleGoal();
const idsMid = store.goalById(gidMid).plan.phases[0].dayIds;
store.setDayStatus(gidMid, idsMid[0], "passed", { pendingUnlock: true, transferQuestion: "q" });
store.completeTransfer(gidMid, idsMid[0], "a");
const midGoal = store.goalById(gidMid);
ok("只过第一天 → 仍是 active", midGoal.status === "active");
ok("只过第一天 → 第二天已解锁", midGoal.plan.days[idsMid[1]].status === "active");

/* ============ 流式渲染节流器 ============ */
const { createStreamRenderer } = require(path.join(proj, "utils/stream-view.js"));
// 断言挪进底部 async 段（顶层 setTimeout 会与 process.exit 竞态）

/* ============ 防抖窗口拉取回归锁（曾经的真 bug） ============
 * markDirty 后 2.5s 内 syncStatus 仍是 idle，若 pullIfSafe 只看 syncStatus，
 * 会把未推送的本地改动当成已同步而被云端覆盖（改完笔记立刻切 tab 就会中招）。
 * 用脏标记后：窗口内必须返回 "skip"，本地改动必须存活。 */
(async () => {
  /* ---- 节流器：push 合并 / flush 立即 / cancel 丢弃 ---- */
  let svCalls = 0;
  const throttled = createStreamRenderer(() => { svCalls++; }, 30);
  for (let i = 0; i < 20; i++) throttled.push();
  ok("节流：push 当下不立即刷新", svCalls === 0);
  await new Promise((r) => setTimeout(r, 80));
  ok("节流：20 次 push 只触发 ≤2 次刷新", svCalls >= 1 && svCalls <= 2);
  const beforeFlush = svCalls;
  throttled.flush();
  ok("flush 立即补一次", svCalls === beforeFlush + 1);
  throttled.cancel();
  const afterCancel = svCalls;
  throttled.push();
  await new Promise((r) => setTimeout(r, 80));
  ok("cancel 后 push 不触发", svCalls === afterCancel);

  /* ---- 防抖窗口拉取 ---- */
  const apiPath = require.resolve(path.join(proj, "utils/api.js"));
  const saved = require.cache[apiPath];
  const cloudSnapshot = {
    data: {
      goals: [{ id: "g-race", topic: "cloud", plan: null, quizLog: [] }],
      knowledge: [],
      books: [],
      sessions: [],
      customPersonas: [],
      settings: {}
    },
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: {
      pullCloud: () => Promise.resolve(cloudSnapshot),
      pushCloud: () => Promise.resolve(true),
      hasSession: () => true,
      me: () => Promise.resolve({ user: { userId: "u-race" } })
    }
  };
  // 重新加载 store，让它拿到被 stub 的 api
  delete require.cache[require.resolve(path.join(proj, "utils/store.js"))];
  const store2 = require(path.join(proj, "utils/store.js"));
  await store2.onLogin("u-race");
  const g = store2.goalById("g-race");
  g.topic = "local-edit";
  store2.markDirtyPublic();
  const r = await store2.pullIfSafe(false);
  ok("防抖窗口内 pull 必须 skip", r === "skip");
  ok("防抖窗口内本地改动不被覆盖", store2.goalById("g-race").topic === "local-edit");

  /* ---- 断流校验（t=end 必达，与 Web ai/client.ts 同语义） ----
   * 模拟网关掐断：喂了正文但服务端从不发 {"t":"end"}，success 先到——
   * 旧实现把半截当完整 resolve；修复后必须 reject 且 err.partial 带回半截内容。 */
  const chatMod = require(path.join(proj, "utils/chat.js"));
  global.wx.request = function (opts) {
    return {
      abort: function () {},
      onChunkReceived: function (fn) {
        fn({ data: '{"t":"d","v":"半截"}\n' });
        setTimeout(function () {
          opts.success({ statusCode: 200, header: {} });
        }, 5);
      }
    };
  };
  const broken = await chatMod
    .streamChat({ task: "lesson", args: {}, messages: [] })
    .then(function () { return null; })
    .catch(function (e) { return e; });
  ok("断流: 无 t=end 必须失败", Boolean(broken) && broken.message.indexOf("连接中断") >= 0);
  ok("断流: err.partial 保留半截", Boolean(broken) && broken.partial === "半截");

  /* 完整流：d + end + success → resolve 全文 */
  global.wx.request = function (opts) {
    return {
      abort: function () {},
      onChunkReceived: function (fn) {
        fn({ data: '{"t":"d","v":"全文"}\n{"t":"end"}\n' });
        setTimeout(function () {
          opts.success({ statusCode: 200, header: {} });
        }, 5);
      }
    };
  };
  const whole = await chatMod.streamChat({ task: "lesson", args: {}, messages: [] });
  ok("完整流: 见 t=end 才 resolve", whole === "全文");

  // 还原 api 缓存，避免影响其它断言
  if (saved) require.cache[apiPath] = saved;
  else delete require.cache[apiPath];

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
