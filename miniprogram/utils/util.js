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
  /* 日期索引必须无原型：quizLog 经本机缓存 JSON.parse 与云端快照 adoptCloud
   * 进入 state，q.date 无校验——date 为 "__proto__"/"constructor"（快照损坏或
   * 被写入恶意值）时，普通对象会命中继承属性走过判空，随后
   * byDate[q.date].total += 1 变成对 Object.prototype 的写（全应用所有缺失
   * .total 的对象读取都得到 NaN）。Object.create(null) 同理用于 streak。 */
  var byDate = Object.create(null);
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
    /* 网格以今天收尾（见上），d 恒 <= todayIso，没有「未来格」这种格子 */
    out.push({ date: d, level: level });
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
  /* 无原型日期集合（同 heatmap：set["__proto__"] 对普通对象是原型写，虽被
   * 引擎对非对象赋值静默忽略，但 set[cursor] 的读取仍会被继承属性干扰） */
  var set = Object.create(null);
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

/* 消息数组裁剪（会话消息 / 读书聊天 / 每日答疑共用）。
 * 全量快照同步有 4.2MB 服务端硬闸、微信 setStorageSync 单 key 上限 1MB；
 * 三个数组都是无界 concat，活跃用户数月后会撞穿上限 → 本机缓存静默停写
 * （store.js 的 quizLog 已因同一原因修过）。
 * 控制增长的主手段是条数上限（典型单条几百到一两千字，100 条约 100-200KB）；
 * 单条超长再截断并留标记——截断是有损的，但比「此后全部编辑都落不了盘」好。 */
var MSG_MAX = 100;
var MSG_TEXT_MAX = 6000;

function capMessages(list, max, textMax) {
  var cap = max || MSG_MAX;
  var textCap = textMax || MSG_TEXT_MAX;
  var arr = (list || []).slice(-cap);
  return arr.map(function (m) {
    if (!m || typeof m.content !== "string" || m.content.length <= textCap) return m;
    return Object.assign({}, m, {
      content: m.content.slice(0, textCap) + "\n\n（内容过长，已截断保存）"
    });
  });
}

/* 阶段「有哪些学习日」的唯一判定：catalog 优先，老目标没有 catalog 时回落 dayIds。
 * 这组判定此前在 goal.js（渲染 + needCatalog）与 store.js setDayDetail 各写一份，
 * 三份必须保持同步——改一处漏一处就会出现「渲染有天、落库按另一份算」的口径分裂。
 * 返回 id 字符串数组（两种数据形态统一成同一类型，调用方不必再判断）。 */
function phaseDayIds(phase) {
  if (!phase) return [];
  if (phase.catalog && phase.catalog.length) {
    return phase.catalog.map(function (c) {
      return c.id;
    });
  }
  return phase.dayIds || [];
}

/* 复制文本 + 统一反馈。
 * 同一 affordance（md.wxml 的「复制」、链接行）在 day/council/book/note 四个页面都用，
 * 此前 day 页在 success 里补自定义 toast、其余三页裸调 wx.setClipboardData：
 * 同一交互在三处反馈形态不一致（day 注释的经验是原生「内容已复制」提示并不总出现）。
 * 收成一处后，改反馈只改这里；showToast 会替换而非叠加，不会出现两条提示闪烁。
 * fail 也要给反馈：剪贴板被系统限制/占用时静默无反应会让用户以为点了没用。 */
function copyText(data, msg) {
  wx.setClipboardData({
    data: String(data || ""),
    success: function () {
      toast(msg || "已复制");
    },
    fail: function () {
      toast("复制失败，请长按内容手动复制");
    }
  });
}

module.exports = {
  todayISO: todayISO,
  addDays: addDays,
  uid: uid,
  clone: clone,
  debounce: debounce,
  heatmap: heatmap,
  streak: streak,
  toast: toast,
  capMessages: capMessages,
  phaseDayIds: phaseDayIds,
  copyText: copyText
};
