var store = require("../../utils/store.js");
var chat = require("../../utils/chat.js");
var schema = require("../../utils/schema.js");
var util = require("../../utils/util.js");

var STATUS_META = {
  locked: { label: "未解锁", tone: "dim" },
  active: { label: "进行中", tone: "accent" },
  passed: { label: "已通过", tone: "ok" },
  skipped: { label: "已跳过", tone: "warn" }
};

Page({
  data: {
    goal: null,
    phases: [],
    genBusy: false
  },

  onLoad: function (query) {
    this.goalId = query.goalId;
    /* 流式回调的卸载纪律（coach.js/review.js 同款）：离开页面后不再对已销毁的
     * 页面实例 setData、不再把失败 toast 弹到用户刚到达的新页面。 */
    this._unloaded = false;
  },

  onShow: function () {
    this.render();
  },

  onUnload: function () {
    this._unloaded = true;
    if (this._cancelGen) this._cancelGen();
  },

  render: function () {
    var goal = store.goalById(this.goalId);
    if (!goal) {
      this.setData({ goal: null, phases: [] });
      return;
    }
    var phases = [];
    var totalDays = 0;
    var doneDays = 0;
    if (goal.plan) {
      goal.plan.phases.forEach(function (ph) {
        /* 「阶段有哪些天」的判定收在 util.phaseDayIds（catalog 优先、老目标回落
         * dayIds），与 needCatalog / store.setDayDetail / overview 共用同一口径。
         * （原 util.phaseEntries 已并入 phaseDayIds：它按注释承诺带出的
         * title/knowledgePoints 没有任何消费方——这里只用 entry.id，且 catalog
         * 与 dayIds 两条路径返回的 knowledgePoints 形状还不一致。） */
        var dayIds = util.phaseDayIds(ph);
        var days = dayIds
          .map(function (id, di) {
            var d = goal.plan.days[id];
            if (!d) return null;
          var meta = STATUS_META[d.status] || STATUS_META.locked;
          totalDays += 1;
          if (d.status === "passed" || d.status === "skipped") doneDays += 1;
          return {
            id: d.id,
            title: d.title,
            status: d.status,
            statusLabel: meta.label,
            tone: meta.tone,
            stub: Boolean(d.stub),
            gated: Boolean(d.pendingUnlock),
            index: di + 1
          };
          })
          .filter(Boolean);
        phases.push({
          id: ph.id,
          title: ph.title,
          outcome: ph.outcome || "",
          statusLabel: (STATUS_META[ph.status] || STATUS_META.locked).label,
          tone: (STATUS_META[ph.status] || STATUS_META.locked).tone,
          isActive: ph.status === "active",
          needCatalog: ph.status !== "locked" && !util.phaseDayIds(ph).length,
          days: days,
          outline: ph.outline || []
        });
      });
    }
    /* 折叠态：按 phase id 保留用户手动展开/收起的结果。
     * render 在每次 onShow（含从 day 页返回）和目录生成完都会跑；旧实现无条件
     * 重推「首个未完成阶段展开」，于是用户展开阶段 3 → 点进某天 → 返回，
     * 阶段 3 又被收起、默认阶段重新弹开（手动折叠状态在生成目录后同样归零）。
     * 只有本次渲染里**新出现**的阶段（首进页面/新生成）才做默认展开推导。 */
    var prevOpen = {};
    (this.data.phases || []).forEach(function (p) {
      if (typeof p.open === "boolean") prevOpen[p.id] = p.open;
    });
    var opened = false;
    phases.forEach(function (ph) {
      if (Object.prototype.hasOwnProperty.call(prevOpen, ph.id)) {
        ph.open = prevOpen[ph.id];
        opened = true; // 已有用户态：不再对后续新阶段做默认展开
        return;
      }
      if (opened) return;
      var hasUndone = ph.days.some(function (d) {
        return d.status === "active" || d.status === "locked";
      }) || ph.needCatalog;
      if (hasUndone) {
        ph.open = true;
        opened = true;
      }
    });

    var goalStatusLabel =
      goal.status === "active"
        ? "进行中"
        : goal.status === "done"
          ? "已完成"
          : goal.status === "draft"
            ? "引导中"
            : "已暂停";

    this.setData({
      goal: {
        id: goal.id,
        topic: goal.topic,
        direction: goal.direction,
        summary: goal.plan ? goal.plan.summary : "",
        status: goal.status,
        statusLabel: goalStatusLabel,
        graduated: Boolean(goal.graduatedAt),
        done: doneDays,
        total: totalDays,
        progress: totalDays ? Math.round((doneDays / totalDays) * 100) : 0
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
  },

  /* ---------------- 天目录生成（task=plan mode=phase-list，与 Web 同链路） ---------------- */

  genCatalog: function (e) {
    var that = this;
    var phaseId = e.currentTarget.dataset.phase;
    if (that.data.genBusy) return;
    var goal = store.goalById(this.goalId);
    if (!goal || !goal.plan) return;
    var phase = null;
    goal.plan.phases.forEach(function (ph) {
      if (ph.id === phaseId) phase = ph;
    });
    if (!phase) return;
    that.setData({ genBusy: true });
    var c = schema.buildPhaseCtx(goal, phase);
    chat
      .streamChat({
        task: "plan",
        args: { mode: "phase-list", ctx: c.ctx, maxDays: c.maxDays },
        messages: [{ role: "user", content: "先只输出这个阶段的学习日目录（最多 " + c.maxDays + " 天，只要 JSON）。" }],
        register: function (cancel) {
          that._cancelGen = cancel;
        },
        onDelta: function () {}
      })
      .then(function (full) {
        /* 生成恰好在落地前完成的竞态：同样不要再对已卸载页面 toast/setData */
        if (that._unloaded) return;
        var list = schema.normPhaseList(chat.extractJson(full));
        var days = list.days.slice(0, c.maxDays);
        /* 老目标已有部分展开的天：按顺序沿用旧 id（Web 同语义），其余新 id。
         * used 是去重守卫：旧 id 若在脏数据里重复，沿用同一个 id 会让目录里的
         * 两天塌成一天（setPhaseCatalog 按 id 建 days 键），所以撞了必须换新 id。 */
        var oldIds = (phase.dayIds || []).slice();
        var used = {};
        var catalog = days.map(function (d, i) {
          var id = oldIds[i];
          if (!id || !goal.plan.days[id] || used[id]) id = util.uid("day");
          used[id] = true;
          return { id: id, title: d.title, knowledgePoints: d.knowledgePoints };
        });
        store.setPhaseCatalog(that.goalId, phaseId, list.boundary || phase.boundary || "", catalog);
        util.toast("已排出 " + catalog.length + " 天", "success");
        that.render();
      })
      .catch(function (e2) {
        /* 目录生成约半分钟，期间返回退出很常见：cancel 会 reject「生成已停止」，
         * 不能在已卸载的页面上下文里 toast（提示会弹到用户刚到达的新页面，
         * coach.js/review.js 已修的同款问题，这里是同一纪律的第三处）。 */
        if (that._unloaded) return;
        util.toast(e2.message || "目录生成失败，稍后再试");
      })
      .then(function () {
        if (that._unloaded) return;
        that.setData({ genBusy: false });
      });
  }
});
