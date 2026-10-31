var store = require("../../utils/store.js");

var STATUS_META = {
  locked: { label: "未解锁", tone: "dim" },
  active: { label: "进行中", tone: "accent" },
  passed: { label: "已通过", tone: "ok" },
  skipped: { label: "已跳过", tone: "warn" }
};

Page({
  data: {
    goal: null,
    phases: []
  },

  onLoad: function (query) {
    this.goalId = query.goalId;
  },

  onShow: function () {
    this.render();
  },

  render: function () {
    var goal = store.goalById(this.goalId);
    if (!goal) {
      this.setData({ goal: null, phases: [] });
      return;
    }
    var phases = [];
    if (goal.plan) {
      goal.plan.phases.forEach(function (ph, pi) {
        var days = (ph.dayIds || []).map(function (id, di) {
          var d = goal.plan.days[id];
          var meta = STATUS_META[d.status] || STATUS_META.locked;
          return {
            id: id,
            title: d.title,
            status: d.status,
            statusLabel: meta.label,
            tone: meta.tone,
            stub: Boolean(d.stub),
            gated: Boolean(d.pendingUnlock),
            index: di + 1
          };
        });
        phases.push({
          id: ph.id,
          title: ph.title,
          outcome: ph.outcome || "",
          statusLabel: (STATUS_META[ph.status] || STATUS_META.locked).label,
          tone: (STATUS_META[ph.status] || STATUS_META.locked).tone,
          days: days,
          outline: ph.outline || []
        });
      });
    }
    wx.setNavigationBarTitle({ title: goal.topic.slice(0, 12) });
    this.setData({
      goal: {
        id: goal.id,
        topic: goal.topic,
        direction: goal.direction,
        summary: goal.plan ? goal.plan.summary : "",
        status: goal.status,
        graduated: Boolean(goal.graduatedAt)
      },
      phases: phases
    });
  },

  openDay: function (e) {
    var d = e.currentTarget.dataset;
    if (d.status === "locked") return;
    wx.navigateTo({
      url: "/pages/day/day?goalId=" + this.goalId + "&dayId=" + d.id
    });
  },

  togglePhase: function (e) {
    var idx = e.currentTarget.dataset.idx;
    var key = "phases[" + idx + "].open";
    var cur = this.data.phases[idx].open;
    this.setData({ [key]: !cur });
  }
});
