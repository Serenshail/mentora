/* ========= 掌握状态机（Web 端 mastery.ts 的忠实移植） =========
 * 六级：unknown → exposed → guided → independent → transferable → durable
 * 规则：L1-L4 提示下完成最高 guided；L5 后原题不过 exposed；
 * apply/build 无提示判对直达 transferable；ungradable 不算证据。 */
var ORDER = ["unknown", "exposed", "guided", "independent", "transferable", "durable"];

function idx(m) {
  return ORDER.indexOf(m);
}

function maxStatus(a, b) {
  return idx(a) >= idx(b) ? a : b;
}

function advanceMastery(cur, hist, verdict, hintLevel, opts) {
  opts = opts || {};
  var h = hist || cur || "unknown";
  if (verdict === "ungradable") return { next: cur || "unknown", hist: h };
  var hl = typeof hintLevel === "number" ? hintLevel : 0;
  var base = cur || "unknown";
  var next = base;
  if (verdict === "correct") {
    if (hl >= 5) next = base === "unknown" ? "exposed" : base;
    else if (hl >= 1) next = maxStatus("guided", base);
    else next = maxStatus(opts.applyEvidence ? "transferable" : "independent", base);
  } else if (verdict === "partially_correct") {
    next = maxStatus("guided", base === "unknown" ? "exposed" : base);
  } else {
    next = base === "unknown" ? "exposed" : base;
  }
  return { next: next, hist: idx(next) > idx(h) ? next : h };
}

/* 验收通过后，本日知识点的掌握状态 = 所有题里最弱的证据（证据从紧不从松） */
function masteryFromQuiz(items) {
  var worst = "durable";
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var r = advanceMastery("unknown", undefined, it.verdict, it.hintLevel, {
      applyEvidence: it.kind === "apply" || it.kind === "build"
    });
    if (idx(r.next) < idx(worst)) worst = r.next;
  }
  if (worst === "durable") worst = "independent";
  return worst;
}

var LABELS = {
  unknown: "未测",
  exposed: "接触过",
  guided: "需要提示",
  independent: "能独立完成",
  transferable: "能迁移应用",
  durable: "长期保持"
};

module.exports = {
  ORDER: ORDER,
  LABELS: LABELS,
  maxStatus: maxStatus,
  advanceMastery: advanceMastery,
  masteryFromQuiz: masteryFromQuiz
};
