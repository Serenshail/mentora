/* ========= 数据层：与 Web 端 zustand store 同一份数据模型 =========
 * 职责：
 *  1. 登录后从云端拉快照（云端为准；云端空且本机有数据才反推——防"空快照覆盖"事故）
 *  2. 本地改动 → 立即写本机缓存 + 2.5s 防抖推云端；onHide 强制 flush
 *  3. 写路径复刻 Web store 的关键语义：验收过门/迁移题真门/解锁链/MOC 目录/双链解析
 *
 * 与 Web 的已知差异（诚实边界）：
 *  - 复习调度用经典 1/3/7/15/30 档（不引入 FSRS）；fsrs 字段不写，
 *    Web 端会在下次复习时按 reviewStage 预热无缝接管——两边状态互相兼容。
 *  - RAG 检索（教练答疑/读书对话）暂不注入 ragCtx，回答不带第二大脑证据。 */
var api = require("./api.js");
var util = require("./util.js");
var masteryMod = require("./mastery.js");

var INTERVALS = [1, 3, 7, 15, 30];

var state = {
  goals: [],
  knowledge: [],
  books: [],
  sessions: [],
  customPersonas: [],
  folders: [],
  settings: {},
  userId: null,
  loaded: false
};

var syncStatus = "idle"; // idle | saving | saved | error
var statusListeners = [];
var pushTimer = null;
var pushing = false;
var pendingPush = false;

function emitStatus(s) {
  syncStatus = s;
  for (var i = 0; i < statusListeners.length; i++) statusListeners[i](s);
}

function onSyncStatus(fn) {
  statusListeners.push(fn);
  fn(syncStatus);
  return function () {
    var i = statusListeners.indexOf(fn);
    if (i >= 0) statusListeners.splice(i, 1);
  };
}

/* ---------------- 本机缓存 ---------------- */

function cacheKey() {
  return state.userId ? "mentora-mp-store-" + state.userId : "mentora-mp-store-anon";
}

/* 本地快照：写盘走「脏标记 + 防抖」。
 * 为什么：知识库大时（几百篇笔记）JSON.stringify 是 MB 级主线程开销，
 * 而 markDirty 在验收/记笔记/答题等高频路径上每次都会触发——
 * 之前每次都同步写盘，"点一下卡一下"就是它。数据在内存里永远是最新的，
 * 防抖只是推迟持久化；onHide/app onHide 有 flushPush 兜底，不怕丢。 */
var saveTimer = null;
function saveLocalSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    saveLocal();
  }, 800);
}

function saveLocal() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    wx.setStorageSync(
      cacheKey(),
      JSON.stringify({
        goals: state.goals,
        knowledge: state.knowledge,
        books: state.books,
        sessions: state.sessions,
        customPersonas: state.customPersonas,
        folders: state.folders,
        settings: state.settings
      })
    );
  } catch (e) { /* 配额满：本机缓存跳过，云端仍是耐久存储 */ }
}

function loadLocal() {
  try {
    var raw = wx.getStorageSync(cacheKey());
    if (!raw) return false;
    var d = JSON.parse(raw);
    state.goals = d.goals || [];
    state.knowledge = d.knowledge || [];
    state.books = d.books || [];
    state.sessions = d.sessions || [];
    state.customPersonas = d.customPersonas || [];
    state.folders = d.folders || [];
    state.settings = d.settings || {};
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 云端同步 ---------------- */

function serialize() {
  var s = Object.assign({}, state.settings, { apiKey: "" });
  return {
    goals: state.goals,
    knowledge: state.knowledge,
    books: state.books,
    sessions: state.sessions,
    customPersonas: state.customPersonas,
    folders: state.folders,
    settings: s
  };
}

function cloudHasData(d) {
  if (!d) return false;
  return (
    ((d.goals || []).length +
      (d.knowledge || []).length +
      (d.books || []).length +
      (d.sessions || []).length +
      (d.customPersonas || []).length) > 0
  );
}

function hasLocalData() {
  return (
    state.goals.length +
      state.knowledge.length +
      state.books.length +
      state.sessions.length > 0
  );
}

function adoptCloud(data) {
  state.goals = data.goals || [];
  state.knowledge = data.knowledge || [];
  state.books = data.books || [];
  state.sessions = data.sessions || [];
  state.customPersonas = data.customPersonas || [];
  state.folders = data.folders || [];
  var s = data.settings || {};
  delete s.apiKey;
  state.settings = s;
  saveLocal();
}

function pushNow() {
  if (!state.userId) return Promise.resolve(false);
  if (pushing) {
    pendingPush = true;
    return Promise.resolve(false);
  }
  pushing = true;
  emitStatus("saving");
  return api
    .pushCloud(serialize())
    .then(function () {
      pushing = false;
      if (pendingPush) {
        pendingPush = false;
        return pushNow();
      }
      dirtyPending = false; // 已推上去：本地不再有未推送改动
      emitStatus("saved");
      return true;
    })
    .catch(function () {
      pushing = false;
      pendingPush = false;
      emitStatus("error");
      return false;
    });
}

var pushDebounced = null;

/* 未推送的本地改动标记。
 * 为什么需要它：markDirty 到真正 pushNow 之间有 2.5s 防抖，
 * 这期间 syncStatus 仍是 "idle"。如果 pullIfSafe 只看 syncStatus，
 * 就会把还没推上去的本地改动当成"已同步"从而被云端覆盖
 * （真实场景：改完笔记立刻切 tab，onShow 里的 pullIfSafe(false) 会把改动抹掉）。 */
var dirtyPending = false;

function markDirty() {
  dirtyPending = true;
  saveLocalSoon(); // 写盘防抖：高频路径上不再每次都做 MB 级 JSON 序列化
  if (!pushDebounced) {
    pushDebounced = util.debounce(function () {
      pushNow();
    }, 2500);
  }
  pushDebounced();
}

/* 登录后：先看本机缓存（秒开），再对齐云端（云端为准） */
function onLogin(userId) {
  state.userId = userId;
  state.loaded = false;
  dirtyPending = false;
  loadLocal();
  state.loaded = true;
  return pullIfSafe(true);
}

/* 云端对齐。force=true（登录时）：云端空+本机有数据 → 反推修复；
 * 非 force（回前台）：本地有未推送改动时绝不拉取覆盖。
 *
 * 拉取节流：快照是**全量**的（目标+笔记+书+会话），知识库大时是 MB 级。
 * 每个 tab 页 onShow 都调 pullIfSafe —— 之前每切一次 tab 就在当前
 * （往往很慢的）网络通道上重拉一遍全量数据，这是"点 tab 特别卡"的
 * 网络层来源。非 force 时 30s 内不重复拉；下拉刷新/登录不受限。 */
var PULL_MIN_INTERVAL = 30 * 1000;
var lastPullAt = 0;

function pullIfSafe(force) {
  if (!state.userId) return Promise.resolve("skip");
  var now = Date.now();
  if (!force && now - lastPullAt < PULL_MIN_INTERVAL) {
    return Promise.resolve("skip");
  }
  return api
    .pullCloud()
    .then(function (cloud) {
      lastPullAt = Date.now();
      if (!cloud) {
        if (force && hasLocalData()) {
          return pushNow().then(function () {
            return "pushed";
          });
        }
        return "none";
      }
      if (!cloudHasData(cloud.data)) {
        if (force && hasLocalData()) return pushNow().then(function () { return "pushed"; });
        return "none";
      }
      // 有未推送改动（含防抖窗口内的）→ 绝不覆盖本地
      if (!force && hasLocalData() && (dirtyPending || syncStatus === "saving")) return "skip";
      adoptCloud(cloud.data);
      return "pulled";
    })
    .catch(function () {
      return "error";
    });
}

function flushPush() {
  if (saveTimer) {
    // 待写的本地快照立即落盘（切后台前保证本机缓存完整）
    saveLocal();
  }
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (state.userId) pushNow();
}

function onLogout() {
  flushPush();
  state.userId = null;
  state.loaded = false;
  state.goals = [];
  state.knowledge = [];
  state.books = [];
  state.sessions = [];
  state.customPersonas = [];
  state.folders = [];
  state.settings = {};
}

/* ---------------- 派生选择器 ---------------- */

function activeGoal() {
  for (var i = 0; i < state.goals.length; i++) {
    if (state.goals[i].status === "active") return state.goals[i];
  }
  return null;
}

function dueReviews() {
  var today = util.todayISO();
  return state.knowledge.filter(function (k) {
    return k.nextReviewAt && k.nextReviewAt <= today;
  });
}

function goalById(id) {
  for (var i = 0; i < state.goals.length; i++) {
    if (state.goals[i].id === id) return state.goals[i];
  }
  return null;
}

function knowledgeById(id) {
  for (var i = 0; i < state.knowledge.length; i++) {
    if (state.knowledge[i].id === id) return state.knowledge[i];
  }
  return null;
}

function bookById(id) {
  for (var i = 0; i < state.books.length; i++) {
    if (state.books[i].id === id) return state.books[i];
  }
  return null;
}

function sessionById(id) {
  for (var i = 0; i < state.sessions.length; i++) {
    if (state.sessions[i].id === id) return state.sessions[i];
  }
  return null;
}

/* ---------------- 写路径（复刻 Web store 语义） ---------------- */

/* 通过某天后解锁同阶段下一天 / 下一阶段首天。
 * 返回值：本次推进是否把整个目标走完了（true = 最后一个阶段最后一天）。
 *
 * 注意（曾经的真 bug）：早期版本在这里直接给传入的 goal 赋 status="done"，
 * 而调用方传的是一个临时 shadow 对象——赋值落在临时对象上，真实 goal 永远停在
 * active，导致「目标永远完不成」：首页一直显示进行中、结业回路永不触发。
 * 现在改为**返回结论**，由调用方写回真实 goal，不依赖对象引用。 */
function unlockNext(goal, dayId) {
  if (!goal.plan) return false;
  var day = goal.plan.days[dayId];
  if (!day) return false;
  var phase = null;
  for (var i = 0; i < goal.plan.phases.length; i++) {
    if (goal.plan.phases[i].id === day.phaseId) phase = goal.plan.phases[i];
  }
  if (!phase) return false;
  var idx = phase.dayIds.indexOf(dayId);
  if (idx >= 0 && idx < phase.dayIds.length - 1) {
    var next = goal.plan.days[phase.dayIds[idx + 1]];
    if (next && next.status === "locked") next.status = "active";
    return false;
  }
  phase.status = "passed";
  var pIdx = goal.plan.phases.indexOf(phase);
  var nextPhase = goal.plan.phases[pIdx + 1];
  if (nextPhase && nextPhase.status === "locked") {
    nextPhase.status = "active";
    var first = goal.plan.days[nextPhase.dayIds[0]];
    if (first && first.status === "locked") first.status = "active";
    return false;
  }
  // 没有下一阶段了 → 整个目标走完
  return !nextPhase;
}

function setDayStatus(goalId, dayId, status, opts) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan) return;
  var plan = util.clone(goal.plan);
  var day = plan.days[dayId];
  if (!day) return;
  day.status = status;
  day.completedAt = status === "active" ? undefined : util.todayISO();
  var gate = status === "passed" && opts && opts.pendingUnlock;
  if (gate) {
    day.pendingUnlock = true;
    day.transferQuestion = (opts && opts.transferQuestion) || "";
  } else if (status === "passed") {
    delete day.pendingUnlock;
  }
  var shadow = { id: goal.id, plan: plan };
  if ((status === "passed" && !gate) || status === "skipped") {
    if (unlockNext(shadow, dayId)) goal.status = "done";
  }
  goal.plan = plan;
  if (goal.status === "done" && !goal.graduatedAt && !goal.needsGraduation) {
    goal.needsGraduation = true;
  }
  markDirty();
}

function completeTransfer(goalId, dayId, answer) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan) return;
  var plan = util.clone(goal.plan);
  var day = plan.days[dayId];
  if (!day || day.status !== "passed") return;
  day.pendingUnlock = false;
  day.transferAnswer = answer;
  var shadow = { id: goal.id, plan: plan };
  if (unlockNext(shadow, dayId)) goal.status = "done";
  goal.plan = plan;
  if (goal.status === "done" && !goal.graduatedAt) goal.needsGraduation = true;
  markDirty();
}

function incrementAttempts(goalId, dayId) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan || !goal.plan.days[dayId]) return;
  var plan = util.clone(goal.plan);
  var day = plan.days[dayId];
  if (day) day.attempts = (day.attempts || 0) + 1;
  goal.plan = plan;
  markDirty();
}

function logQuiz(goalId, result) {
  var goal = goalById(goalId);
  if (!goal) return;
  goal.quizLog = [result].concat(goal.quizLog || []);
  markDirty();
}

/* ---- 第二大脑：MOC 目录 + 双链解析（Web store 同语义简化版） ---- */

function mocTitle(subject) {
  return subject + " · 目录";
}

function withMoc(knowledge, subject) {
  if (!subject) return knowledge;
  var title = mocTitle(subject);
  var members = [];
  for (var i = 0; i < knowledge.length; i++) {
    var k = knowledge[i];
    if ((k.domain || "").split("/")[0] === subject && k.title !== title) {
      members.push(k);
    }
  }
  var body =
    "# " + subject + " · 目录\n\n> 自动维护的索引（MOC）：本科目下所有笔记都挂在这里,点链接跳转,新笔记自动加入。\n\n" +
    members
      .map(function (m) {
        return "- [[" + m.title + "]]";
      })
      .join("\n");
  var hit = null;
  for (var j = 0; j < knowledge.length; j++) {
    if (knowledge[j].title === title) hit = knowledge[j];
  }
  if (hit) {
    if (hit.body === body) return knowledge;
    return knowledge.map(function (k) {
      if (k.id === hit.id) {
        var nk = util.clone(k);
        nk.body = body;
        nk.updatedAt = new Date().toISOString();
        return nk;
      }
      return k;
    });
  }
  var moc = {
    id: util.uid("k"),
    title: title,
    body: body,
    domain: subject,
    source: "manual",
    sourceTitle: "自动目录",
    masteredAt: util.todayISO(),
    reviewStage: 0,
    links: [],
    tags: ["MOC"],
    version: 1,
    updatedAt: new Date().toISOString()
  };
  return [moc].concat(knowledge);
}

function linkifyBodies(knowledge) {
  var byTitle = {};
  for (var i = 0; i < knowledge.length; i++) {
    if (!knowledge[i].unresolved) {
      byTitle[(knowledge[i].title || "").trim().toLowerCase()] = knowledge[i].id;
    }
  }
  var re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  return knowledge.map(function (k) {
    var found = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(k.body || ""))) {
      var id = byTitle[m[1].trim().toLowerCase()];
      if (id && id !== k.id && found.indexOf(id) < 0) found.push(id);
    }
    if (!found.length) return k;
    var merged = (k.links || []).slice();
    for (var j = 0; j < found.length; j++) {
      if (merged.indexOf(found[j]) < 0) merged.push(found[j]);
    }
    if (merged.length === (k.links || []).length) return k;
    var nk = util.clone(k);
    nk.links = merged;
    return nk;
  });
}

/* 验收通过：知识点进第二大脑 + 间隔复习队列（Web addKnowledge 的 learn 路径） */
function addLearnKnowledge(goal, day, mStatus) {
  var existing = {};
  state.knowledge.forEach(function (k) {
    existing[k.title] = true;
  });
  var fresh = [];
  (day.knowledgePoints || []).forEach(function (kp) {
    if (!kp.text || existing[kp.text]) return;
    existing[kp.text] = true;
    fresh.push({
      id: util.uid("k"),
      title: kp.text,
      body: "",
      domain: goal.topic + "/笔记",
      source: "learn",
      sourceTitle: goal.topic + " · " + day.title,
      knowledgeType: kp.knowledgeType,
      masteryStatus: mStatus,
      masteredAt: util.todayISO(),
      reviewStage: 0,
      nextReviewAt: util.todayISO(),
      links: [],
      version: 1,
      updatedAt: new Date().toISOString()
    });
  });
  if (fresh.length === 0) return 0;
  var next = fresh.concat(state.knowledge);
  var subjects = {};
  fresh.forEach(function (f) {
    subjects[(f.domain || "").split("/")[0]] = true;
  });
  Object.keys(subjects).forEach(function (subj) {
    next = withMoc(next, subj);
  });
  state.knowledge = linkifyBodies(next);
  markDirty();
  return fresh.length;
}

/* 掌握状态写回计划里的知识点（historicalHighest 保留历史最高证据） */
function updatePlanKpMastery(goalId, dayId, mStatus) {
  var goal = goalById(goalId);
  if (!goal || !goal.plan || !goal.plan.days[dayId]) return;
  var plan = util.clone(goal.plan);
  var kps = (plan.days[dayId].knowledgePoints || []).slice();
  for (var i = 0; i < kps.length; i++) {
    kps[i].masteryStatus = mStatus;
    if (
      !kps[i].historicalHighest ||
      masteryMod.ORDER.indexOf(mStatus) >
        masteryMod.ORDER.indexOf(kps[i].historicalHighest)
    ) {
      kps[i].historicalHighest = mStatus;
    }
  }
  plan.days[dayId].knowledgePoints = kps;
  goal.plan = plan;
  markDirty();
}

/* 复习完成：经典 1/3/7/15/30 档（不写 fsrs 字段，Web 端 FSRS 可无缝接管）。
 * 掌握推进与 Web masteryFromReview 同规则：passReps=通过轮次、stability=当前间隔。 */
function recordReview(id, ok) {
  var k = knowledgeById(id);
  if (!k) return;
  var stage = k.reviewStage || 0;
  var nextStage;
  var interval;
  if (ok) {
    nextStage = Math.min(stage + 1, INTERVALS.length - 1);
    interval = INTERVALS[nextStage];
  } else {
    nextStage = 0;
    interval = 1;
  }
  k.lastReviewOk = ok;
  k.reviewStage = nextStage;
  k.nextReviewAt = util.addDays(interval);
  if (ok) {
    var cur = k.masteryStatus || "unknown";
    var passReps = nextStage;
    var stability = interval;
    var updated = cur;
    if (cur === "unknown" || cur === "exposed") {
      if (passReps >= 1) updated = "guided";
    } else if (cur === "guided") {
      if (passReps >= 2) updated = "independent";
    } else if (cur === "independent" || cur === "transferable") {
      if (passReps >= 4 && stability >= 21) updated = "durable";
    }
    k.masteryStatus = updated;
  }
  markDirty();
}

/* ---------------- 读书伙伴 ---------------- */

function updateBook(id, patch) {
  state.books = state.books.map(function (b) {
    if (b.id !== id) return b;
    var nb = util.clone(b);
    Object.keys(patch).forEach(function (key) {
      nb[key] = patch[key];
    });
    return nb;
  });
  markDirty();
}

function addBookMsg(id, msg) {
  var b = bookById(id);
  if (!b) return;
  b.chat = (b.chat || []).concat([msg]);
  markDirty();
}

/* 由阅读计划草稿建档（task=reading-plan 的产物） */
function createBookFromPlan(title, author, pastedText, plan) {
  var chapters = (plan.chapters || []).map(function (c, i) {
    return {
      id: "c" + i + "-" + util.uid(""),
      title: c.title,
      knowledgeType: c.knowledgeType || "concept",
      coreIdea: c.coreIdea || "",
      focusQuestion: c.focusQuestion || "",
      perspectives: c.perspectives || [],
      capture: c.capture || [],
      status: "todo"
    };
  });
  var book = {
    id: util.uid("b"),
    title: title,
    author: author || "",
    profile: plan.bookProfile || undefined,
    pastedText: pastedText || "",
    status: "reading",
    planSummary: plan.planSummary || "",
    chapters: chapters,
    insights: [],
    chat: [],
    createdAt: new Date().toISOString()
  };
  state.books = [book].concat(state.books);
  markDirty();
  return book.id;
}

/* ---------------- 人生伙伴（圆桌/单聊） ---------------- */

function addSession(sess) {
  state.sessions = [sess].concat(state.sessions);
  markDirty();
}

function updateSession(id, patch) {
  state.sessions = state.sessions.map(function (s) {
    if (s.id !== id) return s;
    var ns = util.clone(s);
    Object.keys(patch).forEach(function (key) {
      ns[key] = patch[key];
    });
    return ns;
  });
  markDirty();
}

function addSessionMsg(id, msg) {
  var s = sessionById(id);
  if (!s) return;
  s.messages = (s.messages || []).concat([msg]);
  markDirty();
}

function removeSession(id) {
  state.sessions = state.sessions.filter(function (s) {
    return s.id !== id;
  });
  markDirty();
}

/* ---------------- 示例目标（与 Web seedSampleGoal 同一份体验数据） ---------------- */

function seedSampleGoal() {
  var kp = function (t) {
    return { id: util.uid("kp"), text: t, knowledgeType: "concept" };
  };
  var day = function (n, title, kps, st) {
    return {
      id: "d" + n,
      phaseId: "p1",
      title: "Day " + n + "：" + title,
      knowledgePoints: kps.map(kp),
      resources: [
        {
          title: "Prompt Engineering Guide（官方）",
          url: "https://www.promptingguide.ai/zh",
          why: "系统性框架，当手册用",
          kind: "doc",
          year: 2025
        },
        {
          title: "Learn Prompting（免费开源课）",
          url: "https://learnprompting.org/zh/docs/introduction",
          why: "小步interactive",
          kind: "course",
          year: 2025
        }
      ],
      method: "读官方小节→写一个最小 prompt→跑一遍→按验收双轨自测",
      acceptance: [
        {
          id: util.uid("a"),
          kind: "explain",
          question: "用自己的话说清：什么是 zero-shot / few-shot，差别在哪"
        },
        {
          id: util.uid("a"),
          kind: "apply",
          question: "写一个让模型稳定输出 JSON 的 prompt，并贴出你跑通的结果"
        }
      ],
      status: st,
      attempts: 0,
      lesson:
        st === "active"
          ? "## 今日任务与用户背景\n体验示例目标：把一个真实小技能走完「学习→产出→验收」闭环。\n\n## ① 直接可学的资料\n- [Prompt Engineering Guide 中文版](https://www.promptingguide.ai/zh) —— 先读 Zero-Shot 与 Few-Shot 两节\n- [Learn Prompting 入门](https://learnprompting.org/zh/docs/introduction) —— 只看 Basics\n\n## ② 知识点穷尽\n- **zero-shot**：不给例子，直接下指令。适合任务边界清晰、模型见过的套路\n- **few-shot**：给 2-3 个输入输出示例，让模型模仿格式\n- **角色设定**：一句\"你是…\"能显著稳定输出风格\n- **输出约束**：明确\"只输出 JSON/不超过 100 字\"比事后修剪省一半时间\n\n## ③ 完整可运行示例\n\n```text\n你是产品文案。\n任务：把下面的功能点改写成一条朋友圈文案。\n要求：不超过 50 字，带一个具体场景，不要形容词堆砌。\n功能点：离线可用，数据存在本机。\n```\n把上面的 prompt 原样粘进任意对话模型跑一遍，再改功能点重跑。\n\n## ④ 验收\n完成上方\"验收标准\"里的两题，提交评分。"
          : undefined
    };
  };
  var goal = {
    id: util.uid("g"),
    topic: "示例 · Prompt 编写入门",
    direction: "三天走通「学习→产出→验收」闭环（可随时删除）",
    domainKind: "coding",
    motivation: "体验产品流程",
    background: "会用聊天 AI，没系统学过提示词",
    weeklyHours: 3,
    successCriteria: ["走完 Day1-3 并通过验收"],
    status: "active",
    createdAt: new Date().toISOString(),
    quizLog: [],
    intakeTranscript: [],
    plan: {
      startDate: util.todayISO(),
      createdAt: new Date().toISOString(),
      summary: "三天体验闭环：Day1 提示词基础 → Day2 结构化输出 → Day3 小项目验收",
      totalDays: 3,
      weeklyHours: 3,
      phases: [
        {
          id: "p1",
          title: "阶段1 · 体验闭环",
          outcome: "能独立写出结构化 prompt 并通过验收",
          status: "active",
          dayIds: ["d1", "d2", "d3"],
          outline: ["基础", "结构化", "小项目"]
        }
      ],
      days: {
        d1: day(1, "提示词基础：zero-shot / few-shot / 角色", ["zero-shot 与 few-shot 的区别", "角色设定与输出约束"], "active"),
        d2: day(2, "结构化输出与常见坑", ["JSON 输出约束", "失败模式与修复"], "locked"),
        d3: day(3, "小项目：把一个真实需求 prompt 化", ["需求→prompt 的转译"], "locked")
      }
    }
  };
  state.goals = [goal].concat(state.goals);
  markDirty();
  return goal.id;
}

module.exports = {
  state: state,
  onSyncStatus: onSyncStatus,
  markDirtyPublic: markDirty,
  onLogin: onLogin,
  pullIfSafe: pullIfSafe,
  flushPush: flushPush,
  pushNow: pushNow,
  onLogout: onLogout,
  activeGoal: activeGoal,
  dueReviews: dueReviews,
  goalById: goalById,
  knowledgeById: knowledgeById,
  bookById: bookById,
  sessionById: sessionById,
  setDayStatus: setDayStatus,
  completeTransfer: completeTransfer,
  incrementAttempts: incrementAttempts,
  logQuiz: logQuiz,
  addLearnKnowledge: addLearnKnowledge,
  updatePlanKpMastery: updatePlanKpMastery,
  recordReview: recordReview,
  updateBook: updateBook,
  addBookMsg: addBookMsg,
  createBookFromPlan: createBookFromPlan,
  addSession: addSession,
  updateSession: updateSession,
  addSessionMsg: addSessionMsg,
  removeSession: removeSession,
  seedSampleGoal: seedSampleGoal
};
