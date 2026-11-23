/* ========= 协议归一化 + 计划构建（Web ai/client.ts schema 与 lib/plan.ts 的容错移植） =========
 * 与 Web 的对应关系（改动两端要同步）：
 *   normMasterPlan   ← masterPlanSchema（client.ts:238）
 *   normPhaseList    ← phaseListSchema（client.ts:257）
 *   normPhaseDay     ← phasePlanSchema.days[n]（client.ts:274，year/kind/evergreen 容错）
 *   masterDraftToPlan← lib/plan.ts:74（阶段标题公式「阶段N · 标题」必须一字不差）
 *   phaseDraftToDay  ← lib/plan.ts:102
 *   splitGoalReply   ← ai/client.ts:209（GOAL_READY 标记 + 候选逆序）
 *   normReadingGoal  ← readingGoalSchema（client.ts:553，枚举回落 understand）
 *   normAssessGen/Grade ← readingAssessGen/GradeSchema（client.ts:583/600，四级判定）
 * 纪律与 Web 相同：格式容错只降级不炸；结论纪律（证据缺失降级）在 grade.js。 */
var util = require("./util.js");

var KNOWLEDGE_TYPES = ["fact", "concept", "procedure", "discrimination", "judgment", "creative"];
var ACCEPT_KINDS = ["explain", "apply", "oral", "essay", "build"];
var READING_GOALS = ["understand", "think", "apply", "retain"];
var ASSESS_KINDS = ["explain", "connect", "apply"];
var ASSESS_LEVELS = ["mastered", "partial", "not", "ungradable"];

function str(v, fallback) {
  var s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.trim() || (fallback || "");
}
function num(v, fallback) {
  /* 字符串形态保留小数点：模型带单位输出 "2.5"/"2.5小时" 时此前把点当杂字符
   * 删掉再 parseInt，"2.5" 归一化成 25（weeklyHours 十倍膨胀、estDays 把
   * buildPhaseCtx 的 maxDays 顶到钳制上限）。parseFloat 对 "2.5.5" 停在首个
   * 点，天然容错。数值形态直通（与 typeof === "number" 分支一致）。 */
  if (typeof v === "number") return v;
  var s = String(v == null ? "" : v).replace(/[^\d.-]/g, "");
  var n = parseFloat(s);
  return isNaN(n) ? (fallback || 0) : n;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function normKnowledgeType(v) {
  var s = String(v == null ? "" : v).toLowerCase();
  return KNOWLEDGE_TYPES.indexOf(s) >= 0 ? s : "concept";
}
/* 知识点条目：字符串或 {text,knowledgeType} 双形态（phasePlanSchema union） */
function normKps(v) {
  var out = [];
  arr(v).forEach(function (t) {
    if (typeof t === "string" && t.trim()) {
      out.push({ text: t.trim() });
    } else if (t && typeof t === "object" && str(t.text)) {
      out.push({ text: str(t.text), knowledgeType: normKnowledgeType(t.knowledgeType) });
    }
  });
  return out;
}

/* ---------------- 引导：从回复里解析目标卡（client.ts:209 同算法） ---------------- */
var GOAL_KINDS = ["coding", "language", "humanities", "exam", "career", "other"];

function tryParseCard(raw) {
  try {
    var j = require("./chat.js").extractJson(raw);
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    /* 必备四件套缺一个就不是目标卡（防把普通 JSON 当卡） */
    if (!str(j.topic) || !str(j.direction) || !str(j.motivation) || !arr(j.successCriteria).length) return null;
    var dk = String(j.domainKind || "other").toLowerCase();
    return {
      topic: str(j.topic),
      direction: str(j.direction),
      domainKind: GOAL_KINDS.indexOf(dk) >= 0 ? dk : "other",
      motivation: str(j.motivation),
      background: str(j.background),
      weeklyHours: Math.min(80, Math.max(1, num(j.weeklyHours, 3))),
      learnerProfile: arr(j.learnerProfile).map(function (x) { return String(x); }).filter(Boolean),
      successCriteria: arr(j.successCriteria).map(function (x) { return String(x); }).filter(Boolean),
      assumptions: arr(j.assumptions).map(function (x) { return String(x); }).filter(Boolean)
    };
  } catch (e) {
    return null;
  }
}

/** 返回 {prose, card}。兼容两种输出：<!--GOAL_READY--> 标记、或漏标记直接给 json。 */
function splitGoalReply(text) {
  var marker = /<!--\s*GOAL_READY\s*-->/i.exec(text);
  var head = marker ? text.slice(0, marker.index) : text;
  var tail = marker ? text.slice(marker.index + marker[0].length) : text;
  var candidates = [];
  var braceStart = tail.indexOf("{");
  var braceEnd = tail.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push({ raw: tail.slice(braceStart, braceEnd + 1), start: braceStart, end: braceEnd + 1 });
  }
  var fence = /```[a-zA-Z]*\s*([\s\S]*?)```/g;
  var m;
  while ((m = fence.exec(tail))) {
    candidates.push({ raw: m[1], start: m.index, end: m.index + m[0].length });
  }
  for (var i = candidates.length - 1; i >= 0; i--) {
    var c = candidates[i];
    var card = tryParseCard(c.raw);
    if (card) {
      var prose = marker ? head.trim() : (text.slice(0, c.start) + text.slice(c.end)).trim();
      return { prose: prose, card: card };
    }
  }
  return { prose: head.trim(), card: null };
}

/* ---------------- 总纲要（masterPlanSchema 容错 + masterDraftToPlan） ---------------- */

function normMasterPlan(draft) {
  if (!draft || typeof draft !== "object") throw new Error("计划不完整，再试一次");
  var phases = arr(draft.phases)
    .map(function (p, i) {
      /* 数组元素可能是 null/非对象（模型输出 phases:[null,…]）：跳过而不是
       * TypeError 炸掉整次归一化——与 normAssessGen/Grade 的 q==null 防护同纪律 */
      if (!p || typeof p !== "object") return null;
      var outline = arr(p.outline).map(function (x) { return String(x); }).filter(Boolean);
      if (!outline.length && str(p.outcome)) outline = [str(p.outcome)];
      return {
        title: str(p.title, "阶段" + (i + 1)),
        outcome: str(p.outcome),
        estDays: p.estDays == null ? 0 : num(p.estDays, 0),
        outline: outline,
        boundary: str(p.boundary)
      };
    })
    .filter(Boolean);
  if (!phases.length) throw new Error("计划不完整，再试一次");
  return { summary: str(draft.summary), phases: phases };
}

/** 总纲要 → Plan（阶段骨架，无天；第一阶段 active，planned:false） */
function masterDraftToPlan(draft, card) {
  var n = normMasterPlan(draft);
  var plan = {
    summary: n.summary,
    totalDays: n.phases.reduce(function (a, p) { return a + p.estDays; }, 0),
    weeklyHours: card.weeklyHours || 3,
    startDate: util.addDays(1),
    phases: [],
    days: {},
    createdAt: new Date().toISOString()
  };
  n.phases.forEach(function (p, pi) {
    plan.phases.push({
      id: util.uid("ph"),
      title: "阶段" + (pi + 1) + " · " + p.title,
      outcome: p.outcome,
      dayIds: [],
      status: pi === 0 ? "active" : "locked",
      outline: p.outline,
      boundary: p.boundary || undefined,
      estDays: p.estDays || undefined,
      planned: false
    });
  });
  return plan;
}

/* ---------------- 阶段天目录（phaseListSchema 容错） ---------------- */

function normPhaseList(draft) {
  if (!draft || typeof draft !== "object") throw new Error("目录不完整，再试一次");
  var days = arr(draft.days)
    .map(function (d) {
      if (!d || typeof d !== "object") return null; /* days:[null] 只降级不炸 */
      var kps = normKps(d.knowledgePoints);
      if (!str(d.title) || !kps.length) return null;
      return {
        title: str(d.title),
        knowledgePoints: kps.map(function (k) { return k.text; })
      };
    })
    .filter(Boolean);
  if (!days.length) throw new Error("目录不完整，再试一次");
  return { boundary: str(draft.boundary), days: days };
}

/* ---------------- 单日细节（phasePlanSchema 容错） ---------------- */

function normResource(r) {
  /* resources:[null] 等坏元素归一化成空 title，由调用方的 r.title 过滤掉 */
  if (!r || typeof r !== "object") r = {};
  var url = typeof r.url === "string" && /^https?:\/\//.test(r.url.trim()) ? r.url.trim() : undefined;
  return {
    title: str(r.title),
    url: url,
    why: str(r.why),
    year: r.year == null ? undefined : num(r.year, 0) || undefined,
    kind: typeof r.kind === "string" && r.kind.trim() ? r.kind.trim() : undefined,
    evergreen: r.evergreen === true || r.evergreen === "true" ? true : undefined
  };
}

function normPhaseDay(d) {
  if (!d || typeof d !== "object") throw new Error("这一天的细节不完整，请重试");
  var kps = normKps(d.knowledgePoints);
  var acceptance = arr(d.acceptance)
    .map(function (a) {
      /* acceptance:[null] 同 normAssessGen 的 q==null 防护口径 */
      if (!str(a && a.question)) return null;
      var kind = String((a && a.kind) || "").toLowerCase();
      return {
        kind: ACCEPT_KINDS.indexOf(kind) >= 0 ? kind : "apply",
        question: str(a.question),
        hint: str(a.hint) || undefined
      };
    })
    .filter(Boolean);
  if (!str(d.title) || !kps.length || !acceptance.length) {
    throw new Error("这一天的细节不完整，请重试");
  }
  return {
    title: str(d.title),
    knowledgePoints: kps,
    resources: arr(d.resources).map(normResource).filter(function (r) { return r.title; }),
    method: str(d.method),
    example:
      d.example && str(d.example.title) && str(d.example.description)
        ? { title: str(d.example.title), description: str(d.example.description), code: str(d.example.code) || undefined }
        : undefined,
    acceptance: acceptance
  };
}

/** 单日草稿 → DayPlan 骨架（id/phaseId 由调用方覆盖；plan.ts:102 同逻辑） */
function phaseDraftToDay(d, phaseId, dayId) {
  var n = normPhaseDay(d);
  return {
    id: dayId,
    phaseId: phaseId,
    title: n.title,
    knowledgePoints: n.knowledgePoints.map(function (k) {
      return { id: util.uid("kp"), text: k.text, knowledgeType: k.knowledgeType };
    }),
    resources: n.resources,
    method: n.method,
    example: n.example,
    acceptance: n.acceptance.map(function (a) {
      return { id: util.uid("ac"), kind: a.kind, question: a.question, hint: a.hint };
    }),
    status: "locked",
    attempts: 0
  };
}

/* ---------------- 阅读系统 V1.0 ---------------- */

/** 目标推荐（readingGoalSchema：非法枚举回落 understand） */
function normReadingGoal(json) {
  var j = json && typeof json === "object" ? json : {};
  var ok = function (v) { return READING_GOALS.indexOf(String(v)) >= 0; };
  var secondary = arr(j.secondary).filter(ok);
  return {
    primary: ok(j.primary) ? j.primary : "understand",
    secondary: secondary,
    reason: str(j.reason)
  };
}

/** 验收出题（readingAssessGenSchema：kind 回落 explain，固定 3 题） */
function normAssessGen(json) {
  var j = json && typeof json === "object" ? json : {};
  var questions = arr(j.questions)
    .map(function (q) {
      var kind = String(q == null ? "" : q.kind);
      if (!str(q && q.question)) return null;
      return { kind: ASSESS_KINDS.indexOf(kind) >= 0 ? kind : "explain", question: str(q.question) };
    })
    .filter(Boolean)
    .slice(0, 3);
  if (questions.length < 2) throw new Error("验收题不完整");
  return { questions: questions };
}

/** 验收判分（readingAssessGradeSchema：四级 + evidence 截断，与 Web 同口径） */
function normAssessGrade(json) {
  var j = json && typeof json === "object" ? json : {};
  var results = arr(j.results)
    .map(function (r) {
      var kind = String(r == null ? "" : r.kind);
      var level = String(r == null ? "" : r.level);
      return {
        kind: ASSESS_KINDS.indexOf(kind) >= 0 ? kind : "explain",
        level: ASSESS_LEVELS.indexOf(level) >= 0 ? level : "partial",
        evidence: str(r && r.evidence).slice(0, 400),
        feedback: str(r && r.feedback)
      };
    })
    .filter(Boolean);
  if (!results.length) throw new Error("判分结果不完整");
  return {
    results: results,
    suggestion: str(j.suggestion),
    misconception:
      j.misconception && str(j.misconception.concept)
        ? { concept: str(j.misconception.concept), note: str(j.misconception.note) }
        : null
  };
}

/* ---------------- 上下文助手（与 Web read/[id]/page.tsx 同形状） ---------------- */

var READING_GOAL_LABELS = {
  understand: "理解",
  think: "思考",
  apply: "应用",
  retain: "沉淀"
};
var ASSESS_KIND_LABELS = { explain: "理解验收", connect: "结构验收", apply: "迁移验收" };
var DEPOSIT_TYPES = [
  { id: "explanation", label: "我的解释" },
  { id: "point", label: "核心点" },
  { id: "question", label: "问题" },
  { id: "view", label: "我的观点" },
  { id: "practice", label: "实践案例" },
  { id: "unresolved", label: "待解决" },
  { id: "aiFeedback", label: "AI 反馈" }
];
var READ_STATUS_LABELS = {
  unread: "未开始",
  reading: "阅读中",
  finished: "已读完",
  assessing: "验收中",
  mastered: "已掌握"
};

function chapterJson(c) {
  if (!c) return "null";
  return JSON.stringify({
    title: c.title,
    knowledgeType: c.knowledgeType || "concept",
    coreIdea: c.coreIdea || "",
    focusQuestion: c.focusQuestion || "",
    keyConcepts: c.keyConcepts || [],
    assessFocus: c.assessFocus || "",
    expectedOutcome: c.expectedOutcome || ""
  });
}

/** goalText：未设 → "未设定"；已设 → 与 Web 同格式的自然语言（判分/出题按它加权） */
function goalText(goal) {
  if (!goal) return "未设定";
  var t = "主目标 " + (READING_GOAL_LABELS[goal.primary] || "理解");
  if ((goal.secondary || []).length) {
    t += "（次目标 " + goal.secondary
      .map(function (g) { return READING_GOAL_LABELS[g] || "理解"; })
      .join("、") + "）";
  }
  if (goal.intent) t += "，想解决：" + goal.intent;
  if (goal.background) t += "；已有基础：" + goal.background;
  return t;
}

/** 出题失败时的本地兜底三题（与 Web read/[id]/page.tsx 同文案） */
function fallbackAssessQuestions(c) {
  return [
    { kind: "explain", question: "合上书，用自己的话解释「" + c.title + "」的核心主张。" },
    {
      kind: "connect",
      question: "这个主张和" + (c.prerequisites && c.prerequisites[0] ? "「" + c.prerequisites[0] + "」" : "前面读过的内容") + "是什么关系？"
    },
    { kind: "apply", question: "你工作或生活里哪件事能用上它？具体说怎么用。" }
  ];
}

/* ---------------- 学习教练：阶段上下文（Web learn/[id] genCtx 同形状） ---------------- */

/** 总纲 ctx：已掌握/薄弱点/阶段边界全量注入，模型才知道往哪排。maxDays=阶段天数硬上限。 */
function buildPhaseCtx(goal, phase) {
  var plan = goal.plan || { days: {}, summary: "" };
  var mastered = [];
  Object.keys(plan.days || {}).forEach(function (k) {
    var d = plan.days[k];
    if (d && (d.status === "passed" || d.status === "skipped")) {
      (d.knowledgePoints || []).forEach(function (kp) {
        mastered.push(kp.text);
      });
    }
  });
  var weakPoints = [];
  (goal.quizLog || [])
    .filter(function (q) {
      return !q.passed;
    })
    .slice(0, 5)
    .forEach(function (q) {
      var d = plan.days[q.dayId];
      if (!d) return;
      var bad = 0;
      (q.items || []).forEach(function (i) {
        if (i.verdict === "incorrect") bad++;
      });
      weakPoints.push(d.title + "（" + bad + " 题未过）");
    });
  var maxDays = Math.min(Math.max(phase.estDays || 6, 2), 8);
  var ctx = JSON.stringify(
    {
      goal: {
        topic: goal.topic,
        direction: goal.direction,
        background: goal.background,
        domainKind: goal.domainKind,
        weeklyHours: goal.weeklyHours,
        learnerProfile: goal.learnerProfile || []
      },
      masterSummary: plan.summary || "",
      phase: {
        title: phase.title,
        outcome: phase.outcome,
        outline: phase.outline || [],
        boundary: phase.boundary || "",
        estDays: phase.estDays || null,
        maxDays: maxDays
      },
      mastered: mastered,
      weakPoints: weakPoints
    },
    null,
    1
  );
  return { ctx: ctx, maxDays: maxDays };
}

module.exports = {
  splitGoalReply: splitGoalReply,
  normMasterPlan: normMasterPlan,
  masterDraftToPlan: masterDraftToPlan,
  normPhaseList: normPhaseList,
  phaseDraftToDay: phaseDraftToDay,
  normReadingGoal: normReadingGoal,
  normAssessGen: normAssessGen,
  normAssessGrade: normAssessGrade,
  buildPhaseCtx: buildPhaseCtx,
  chapterJson: chapterJson,
  goalText: goalText,
  fallbackAssessQuestions: fallbackAssessQuestions,
  READING_GOAL_LABELS: READING_GOAL_LABELS,
  ASSESS_KIND_LABELS: ASSESS_KIND_LABELS,
  DEPOSIT_TYPES: DEPOSIT_TYPES,
  READ_STATUS_LABELS: READ_STATUS_LABELS
};
