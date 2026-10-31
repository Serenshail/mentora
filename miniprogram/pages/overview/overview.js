var api = require("../../utils/api.js");
var store = require("../../utils/store.js");
var util = require("../../utils/util.js");

Page({
  data: {
    loading: true,
    logged: false,
    name: "",
    sync: "idle",
    goal: null,        // {id, topic, direction, progress, phaseTitle, dayId, dayTitle, dayStatus}
    dueCount: 0,
    counts: { goals: 0, notes: 0, books: 0 },
    heatCols: [],      // 热力墙 12 列
    heatDays: [],
    streakDays: 0,
    goalCount: 0
  },

  onLoad: function () {
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
    that.render();
    store.pullIfSafe(false).then(function () {
      that.render();
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
    var text = s === "saving" ? "同步中…" : s === "saved" ? "已同步" : s === "error" ? "同步失败，稍后自动重试" : "";
    this.setData({ sync: text });
  },

  render: function () {
    var st = store.state;
    var user = getApp().globalData.user;
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
      goalView = {
        id: goal.id,
        topic: goal.topic,
        direction: goal.direction,
        progress: total ? Math.round((passed / total) * 100) : 0,
        phaseTitle: activePhase ? activePhase.title : "",
        dayId: activeDay ? activeDay.id : "",
        dayTitle: activeDay ? activeDay.title : "",
        gated: Boolean(activeDay && activeDay.pendingUnlock)
      };
    }
    var due = store.dueReviews();
    var allQuiz = [];
    st.goals.forEach(function (g) {
      (g.quizLog || []).forEach(function (q) {
        allQuiz.push(q);
      });
    });
    this.setData({
      loading: false,
      logged: true,
      name: (user && user.name) || "",
      goal: goalView,
      dueCount: due.length,
      counts: {
        goals: st.goals.filter(function (g) { return g.status === "active"; }).length,
        notes: st.knowledge.length,
        books: st.books.length
      },
      streakDays: util.streak(allQuiz),
      goalCount: st.goals.length,
      heatCols: util.heatmap(allQuiz, 12)
    });
  },

  goToday: function () {
    var g = this.data.goal;
    if (!g || !g.dayId) {
      wx.navigateTo({ url: "/pages/goal/goal?goalId=" + g.id });
      return;
    }
    wx.navigateTo({
      url: "/pages/day/day?goalId=" + g.id + "&dayId=" + g.dayId
    });
  },

  goGoal: function () {
    var g = this.data.goal;
    if (g) wx.navigateTo({ url: "/pages/goal/goal?goalId=" + g.id });
  },

  goReview: function () {
    wx.navigateTo({ url: "/pages/review/review" });
  },

  goBrain: function () { wx.switchTab({ url: "/pages/brain/brain" }); },
  goCouncil: function () { wx.navigateTo({ url: "/pages/council/council" }); },
  goLearn: function () { wx.switchTab({ url: "/pages/learn/learn" }); },
  goRead: function () { wx.switchTab({ url: "/pages/read/read" }); }
});
