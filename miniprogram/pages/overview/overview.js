var api = require("../../utils/api.js");
var store = require("../../utils/store.js");
var util = require("../../utils/util.js");

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
    var app = getApp();
    if (!api.hasSession() && !app.globalData.user) {
      that.probe();
      return;
    }
    that.setData({ greet: periodGreet() });
    that.render();
    store.pullIfSafe(false).then(function () {
      that.render();
    });
  },

  onPullDownRefresh: function () {
    var that = this;
    store.pullIfSafe(true).then(function () {
      that.render();
      wx.stopPullDownRefresh();
    });
  },

  probe: function () {
    var that = this;
    api
      .me()
      .then(function (j) {
        if (j && j.user) {
          getApp().globalData.user = j.user;
          return store.onLogin(j.user.userId).then(function () {
            that.render();
          });
        }
        wx.reLaunch({ url: "/pages/login/login" });
      })
      .catch(function () {
        wx.reLaunch({ url: "/pages/login/login" });
      });
  },

  syncLabel: function (s) {
    var text =
      s === "saving" ? "同步中…" : s === "saved" ? "已同步" : s === "error" ? "同步失败，稍后自动重试" : "";
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
        for (var j = 0; j < ph.dayIds.length; j++) {
          var d = goal.plan.days[ph.dayIds[j]];
          if (d && d.status === "active") {
            activeDay = d;
            break;
          }
        }
        if (activeDay) break;
      }
      var total = 0;
      var passed = 0;
      Object.keys(goal.plan.days).forEach(function (k) {
        var d = goal.plan.days[k];
        total += 1;
        if (d.status === "passed" || d.status === "skipped") passed += 1;
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
