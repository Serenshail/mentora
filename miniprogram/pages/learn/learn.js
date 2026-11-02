var store = require("../../utils/store.js");
var api = require("../../utils/api.js");
var chat = require("../../utils/chat.js");
var util = require("../../utils/util.js");

/* 学习页 = 目标 + 书架。
 * 合并的理由：这两个都是"我在系统学习的东西"，用户心里的模型是"我要学什么"，
 * 不是"技能"和"书"分属两个模块。分成两个 tab 是照抄网页的侧栏结构，
 * 在手机上等于用掉 40% 的导航位去表达一个概念。 */

Page({
  data: {
    loading: true,
    tab: "goals", // goals | books
    goals: [],
    books: [],
    // 建档
    adding: false,
    title: "",
    author: "",
    pasted: "",
    creating: false
  },

  onShow: function () {
    var that = this;
    if (!store.state.userId && !api.hasSession()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
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

  setTab: function (e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  render: function () {
    var goals = store.state.goals.map(function (g) {
      var total = 0;
      var done = 0;
      if (g.plan) {
        Object.keys(g.plan.days).forEach(function (k) {
          var d = g.plan.days[k];
          total += 1;
          if (d.status === "passed" || d.status === "skipped") done += 1;
        });
      }
      return {
        id: g.id,
        topic: g.topic,
        direction: g.direction || "",
        progress: total ? Math.round((done / total) * 100) : 0,
        done: done,
        total: total,
        statusLabel:
          g.status === "active"
            ? "进行中"
            : g.status === "done"
              ? "已完成"
              : g.status === "draft"
                ? "引导中"
                : "已暂停",
        tone: g.status === "active" ? "accent" : g.status === "done" ? "ok" : "dim",
        active: g.status === "active"
      };
    });
    // 进行中的排最前；其余按创建时间倒序（之前次级排序缺失，比较函数恒返回 0）
    goals.sort(function (a, b) {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return 0;
    });

    var books = store.state.books.map(function (b) {
      var doneCh = b.chapters.filter(function (c) {
        return c.status === "done";
      }).length;
      return {
        id: b.id,
        title: b.title,
        author: b.author || "",
        statusLabel: b.status === "reading" ? "在读" : b.status === "done" ? "读完" : "想读",
        progress: b.chapters.length ? Math.round((doneCh / b.chapters.length) * 100) : 0,
        chapters: doneCh + "/" + b.chapters.length + " 章"
      };
    });

    this.setData({ loading: false, goals: goals, books: books });
  },

  openGoal: function (e) {
    wx.navigateTo({ url: "/pages/goal/goal?goalId=" + e.currentTarget.dataset.id });
  },

  openBook: function (e) {
    wx.navigateTo({ url: "/pages/book/book?bookId=" + e.currentTarget.dataset.id });
  },

  seedSample: function () {
    store.seedSampleGoal();
    util.toast("示例目标已加入", "success");
    this.render();
  },

  /* ---- 建档 ---- */
  toggleAdd: function () {
    this.setData({ adding: !this.data.adding, title: "", author: "", pasted: "" });
  },
  onTitle: function (e) {
    this.setData({ title: e.detail.value });
  },
  onAuthor: function (e) {
    this.setData({ author: e.detail.value });
  },
  onPasted: function (e) {
    this.setData({ pasted: e.detail.value });
  },

  create: function () {
    var that = this;
    var title = that.data.title.trim();
    if (!title) {
      util.toast("先写个书名");
      return;
    }
    if (that.data.creating) return;
    that.setData({ creating: true });
    var author = that.data.author.trim();
    var pasted = that.data.pasted.trim();
    var desc =
      "书名：《" +
      title +
      "》" +
      (author ? " 作者：" + author : "") +
      (pasted ? "\n用户粘贴的内容/笔记：\n" + pasted.slice(0, 6000) : "");
    chat
      .streamChat({
        args: { desc: desc },
        messages: [{ role: "user", content: "生成阅读计划。" }],
        temperature: 0.5,
        task: "reading-plan",
        onDelta: function () {}
      })
      .then(function (full) {
        var plan = chat.extractJson(full);
        if (!plan || !Array.isArray(plan.chapters) || plan.chapters.length < 1) {
          throw new Error("计划不完整，再试一次");
        }
        store.createBookFromPlan(title, author, pasted, plan);
        util.toast("已建好阅读路线", "success");
        that.setData({ adding: false, title: "", author: "", pasted: "", tab: "books" });
        that.render();
      })
      .catch(function (e) {
        util.toast(e.message || "建档失败，稍后再试");
      })
      .then(function () {
        that.setData({ creating: false });
      });
  }
});
