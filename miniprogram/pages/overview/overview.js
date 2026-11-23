var store = require("../../utils/store.js");
var util = require("../../utils/util.js");
var sessionGuard = require("../../utils/session.js");

/* 今天页：产品的"每日入口"。
 * 设计约束 —— 一屏只回答一个问题：「现在该做什么」。
 * 所以只呈现三件事：那张主任务卡、到期的复习、以及一条可回看的学习日历。
 * 其余入口（学习目标列表 / 第二大脑 / 读书 / 伙伴）交给 tabBar，不在这里重复。 */

function periodGreet() {
  var h = new Date().getHours();
  if (h >= 5 && h < 9) return "早上好";
  if (h >= 9 && h < 12) return "上午好";
  if (h >= 12 && h < 14) return "午间好";
  if (h >= 14 && h < 18) return "下午好";
  if (h >= 18 && h < 23) return "晚上好";
  return "夜深了";
}

function headingFor(greet, name) {
  // 主标题就是判断句，不铺陈。有名字就带上。
  var who = name ? name + "，" : "";
  if (greet === "夜深了") return who + "今天够了就睡";
  return who + "今天做一件事";
}

Page({
  data: {
    loading: true,
    logged: false,
    name: "",
    greet: "",
    heading: "",
    sync: "",
    goal: null, // {id, topic, direction, progress, phaseTitle, dayId, dayTitle, done, total, gated, kicker}
    dueCount: 0,
    counts: { goals: 0, notes: 0, books: 0 },
    heatCols: [],
    streakDays: 0
  },

  onLoad: function () {
    this.setData({ greet: periodGreet() });
    this._offSync = store.onSyncStatus(this.syncLabel.bind(this));
  },

  onUnload: function () {
    if (this._offSync) this._offSync();
  },

  onShow: function () {
    var that = this;
    that.setData({ greet: periodGreet() });
    /* 首页是冷启动的第一屏：旧实现看到 hasSession() 为真就直接 render，
     * 此时 store 还是空的（me→onLogin→adoptCloud 还在途）→ loading:false、goal:null
     * → wxml 立刻呈现「还没有进行中的目标」误导性空态，回访用户要切 tab 才看到数据。
     * 统一走 session.ensure：没有 cookie 才探测，有 cookie 先恢复会话再渲染。 */
    sessionGuard.ensure(function () {
      that.render();
      store.pullIfSafe(false).then(function (r) {
        that.render();
        /* 拉取失败要可见：旧实现把返回值扔掉，与成功不可区分 */
        if (r === "error") util.toast("云端对齐失败，请检查网络");
      });
    });
  },

  onPullDownRefresh: function () {
    var that = this;
    store.pullIfSafe(true).then(function (r) {
      that.render();
      wx.stopPullDownRefresh();
      if (r === "error") util.toast("同步失败，请检查网络后重试");
    });
  },

  /* 会话探测已收敛到 utils/session.js（五个 tab 页同一语义）：
   * 这里不再保留第二套 probe——两套并存时守卫条件一旦分叉，又会出现
   * 「有 cookie 但探测失败被踢去登录页」/「有 cookie 却永不探测」的分裂。 */

  syncLabel: function (s) {
    var text =
      s === "saving"
        ? "同步中…"
        : s === "saved"
          ? "已同步"
          : s === "error"
            ? "同步失败，稍后自动重试"
            : s === "conflict"
              ? "两端数据有分叉，待手动处理"
              : "";
    this.setData({ sync: text });
  },

  render: function () {
    var st = store.state;
    var user = getApp().globalData.user;
    var name = (user && user.name) || "";
    var goal = store.activeGoal();
    var goalView = null;

    if (goal && goal.plan) {
      var activeDay = null;
      var activePhase = null;
      for (var i = 0; i < goal.plan.phases.length; i++) {
        var ph = goal.plan.phases[i];
        if (ph.status !== "active") continue;
        activePhase = ph;
        /* 「阶段有哪些学习日」走 util.phaseDayIds 的唯一判定（catalog 优先、老目标
         * 回落 dayIds）：直接读 ph.dayIds 是第 4 份手写口径，一旦 catalog 与 dayIds
         * 分叉（如某端只改 catalog）就会渲染与目录不一致——goal.js 渲染、
         * store.setDayDetail 已共用 util，这里是最后一份改齐的副本。 */
        var ids = util.phaseDayIds(ph);
        for (var j = 0; j < ids.length; j++) {
          var d = goal.plan.days[ids[j]];
          if (d && d.status === "active") {
            activeDay = d;
            break;
          }
        }
        if (activeDay) break;
      }
      /* 进度分母只统计 phase 目录引用到的天（与 goal.js render / Web 学习页同口径）：
       * Web 端阶段重排的纪律是「旧天对象绝不删除」，重排后未沿用的孤儿天仍留在
       * plan.days 里——按 Object.keys(plan.days) 全量统计会虚增分母，首页进度
       * 与目标详情页对不上。 */
      var total = 0;
      var passed = 0;
      goal.plan.phases.forEach(function (ph) {
        util.phaseDayIds(ph).forEach(function (id) {
          var d = goal.plan.days[id];
          if (!d) return;
          total += 1;
          if (d.status === "passed" || d.status === "skipped") passed += 1;
        });
      });
      var gated = Boolean(activeDay && activeDay.pendingUnlock);
      goalView = {
        id: goal.id,
        topic: goal.topic,
        direction: goal.direction || "",
        progress: total ? Math.round((passed / total) * 100) : 0,
        phaseTitle: activePhase ? activePhase.title : "",
        dayId: activeDay ? activeDay.id : "",
        dayTitle: activeDay ? activeDay.title : "",
        done: passed,
        total: total,
        gated: gated,
        kicker: gated ? "还差一道迁移题" : activePhase ? activePhase.title : "今天的任务"
      };
    }

    var allQuiz = [];
    st.goals.forEach(function (g) {
      (g.quizLog || []).forEach(function (q) {
        allQuiz.push(q);
      });
    });

    this.setData({
      loading: false,
      logged: true,
      name: name,
      heading: headingFor(this.data.greet, name),
      goal: goalView,
      dueCount: store.dueReviews().length,
      counts: {
        goals: st.goals.filter(function (g) {
          return g.status === "active";
        }).length,
        notes: st.knowledge.length,
        books: st.books.length
      },
      streakDays: util.streak(allQuiz),
      heatCols: util.heatmap(allQuiz, 12)
    });
  },

  /* ---- 跳转 ---- */
  goToday: function () {
    var g = this.data.goal;
    if (!g) return;
    if (!g.dayId) {
      wx.navigateTo({ url: "/pages/goal/goal?goalId=" + g.id });
      return;
    }
    wx.navigateTo({ url: "/pages/day/day?goalId=" + g.id + "&dayId=" + g.dayId });
  },

  goGoal: function () {
    var g = this.data.goal;
    if (g) wx.navigateTo({ url: "/pages/goal/goal?goalId=" + g.id });
  },

  goReview: function () {
    wx.navigateTo({ url: "/pages/review/review" });
  },

  /* 这三个都是 tab 页，必须用 switchTab（navigateTo 打不开 tab 页） */
  goLearn: function () {
    wx.switchTab({ url: "/pages/learn/learn" });
  },
  goBrain: function () {
    wx.switchTab({ url: "/pages/brain/brain" });
  },
  goCouncil: function () {
    wx.switchTab({ url: "/pages/council/council" });
  }
});
