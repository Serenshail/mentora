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

  // 还原 api 缓存，避免影响其它断言
  if (saved) require.cache[apiPath] = saved;
  else delete require.cache[apiPath];

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
