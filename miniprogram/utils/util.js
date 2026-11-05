/* ========= 通用工具：与 Web 端 utils.ts 同口径 ========= */

/* 全站日界是 UTC 日（Web 端 todayISO 同源）：东八区 0-8 点不算新的一天 */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(days, from) {
  var base = from ? Date.parse(from + "T00:00:00Z") : Date.now();
  if (isNaN(base)) return todayISO();
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  var ta = Date.parse(a + "T00:00:00Z");
  var tb = Date.parse(b + "T00:00:00Z");
  if (isNaN(ta) || isNaN(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

function uid(prefix) {
  return (
    (prefix || "x") +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function debounce(fn, ms) {
  var timer = null;
  var d = function () {
    var args = arguments;
    var self = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      timer = null;
      fn.apply(self, args);
    }, ms);
  };
  /* 取消挂起的防抖：切后台/登出前撤掉待触发的推送，避免再发一次全量上传 */
  d.cancel = function () {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return d;
}

/* 学习热力墙数据（Web v15 study-heatmap 的数据口径）：
 * 格子语义 = 验收质量：0 无 / 1 仅复习或跳过 / 2 部分通过 / 3 全过。
 * 返回最近 weeks 周的格子 [{date, level}]。注意：按「今天收尾」连续回溯，
 * 并不按周一对齐——每列只是连续 7 天的切片，首列/末列的星期会漂移。 */
function heatmap(quizLog, weeks) {
  var byDate = {};
  (quizLog || []).forEach(function (q) {
    if (!q || !q.date) return;
    if (!byDate[q.date]) byDate[q.date] = { passed: 0, total: 0 };
    byDate[q.date].total += 1;
    if (q.passed) byDate[q.date].passed += 1;
  });
  var out = [];
  // 今天收尾，往回铺 total 天（UTC 日口径）
  var todayIso = todayISO();
  var end = todayIso;
  var total = (weeks || 12) * 7;
  var start = addDays(-(total - 1), end);
  for (var i = 0; i < total; i++) {
    var d = addDays(i, start);
    var rec = byDate[d];
    var level = 0;
    if (rec) {
      if (rec.passed >= rec.total) level = 3;
      else if (rec.passed > 0) level = 2;
      else level = 1;
    }
    out.push({ date: d, level: level, future: d > todayIso });
  }
  // 列优先排布：每列 = 连续 7 天切片（不按周一对齐）
  var cols = [];
  for (var c = 0; c < total / 7; c++) {
    cols.push(out.slice(c * 7, c * 7 + 7));
  }
  return cols;
}

/* 连续学习天数：从今天（或昨天）往前数有验收记录的天 */
function streak(quizLog) {
  var set = {};
  (quizLog || []).forEach(function (q) {
    if (q && q.date) set[q.date] = true;
  });
  var cursor = todayISO();
  if (!set[cursor]) {
    cursor = addDays(-1);
    if (!set[cursor]) return 0;
  }
  var n = 0;
  while (set[cursor] && n < 3650) {
    n += 1;
    cursor = addDays(-1, cursor);
  }
  return n;
}

/* 提示 toast。
 * icon:"success" 时微信会把标题截到约 7 个汉字，超过就丢掉关键引导（如「迁移题解锁下一天」）
 * ——超长自动降级为纯文字，宁可少个图标也不能吞掉半句话。 */
function toast(msg, icon) {
  var ic = icon || "none";
  if (ic === "success" && String(msg || "").length > 7) ic = "none";
  wx.showToast({ title: msg, icon: ic, duration: 2400 });
}

module.exports = {
  todayISO: todayISO,
  addDays: addDays,
  daysBetween: daysBetween,
  uid: uid,
  clone: clone,
  debounce: debounce,
  heatmap: heatmap,
  streak: streak,
  toast: toast
};
