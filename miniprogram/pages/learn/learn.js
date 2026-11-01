var store = require("../../utils/store.js");
var api = require("../../utils/api.js");
var util = require("../../utils/util.js");

Page({
  data: {
    loading: true,
    syncHint: "",
    goals: []
  },

  onShow: function () {
    var that = this;
    if (!store.state.userId && !api.hasSession()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    that._offSync = store.onSyncStatus(function (st) {
      that.setData({ syncHint: st === "saving" ? "同步中" : st === "error" ? "同步失败" : "" });
    });
    that.render();
    store.pullIfSafe(false).then(function () {
      that.render();
    });
  },

  onHide: function () {
    if (this._offSync) { this._offSync(); this._offSync = null; }
  },

  onPullDownRefresh: function () {
    var that = this;
    store.pullIfSafe(true).then(function () {
      that.render();
      wx.stopPullDownRefresh();
    });
  },

  render: function () {
    var goals = store.state.goals.map(function (g) {
      var total = 0;
      var passed = 0;
      if (g.plan) {
        Object.keys(g.plan.days).forEach(function (k) {
          var d = g.plan.days[k];
          total += 1;
          if (d.status === "passed" || d.status === "skipped") passed += 1;
        });
      }
      var statusLabel =
        g.status === "active" ? "进行中" : g.status === "done" ? "已完成" : g.status === "draft" ? "引导中" : "已暂停";
      var statusTone =
        g.status === "active" ? "accent" : g.status === "done" ? "ok" : "dim";
      return {
        id: g.id,
        topic: g.topic,
        direction: g.direction || "",
        progress: total ? Math.round((passed / total) * 100) : 0,
        passed: passed,
        total: total,
        statusLabel: statusLabel,
        tone: g.status === "active" ? "accent" : g.status === "done" ? "ok" : "dim",
        active: g.status === "active"
      };
    });
    // active 在前，其余按创建时间倒序
    goals.sort(function (a, b) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return 0;
    });
    this.setData({ loading: false, goals: goals });
  },

  openGoal: function (e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/goal/goal?goalId=" + id });
  },

  seedSample: function () {
    store.seedSampleGoal();
    util.toast("示例目标已加入", "success");
    this.render();
  }
});
