var store = require("../../utils/store.js");
var api = require("../../utils/api.js");
var chat = require("../../utils/chat.js");
var util = require("../../utils/util.js");

Page({
  data: {
    loading: true,
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

  render: function () {
    var books = store.state.books.map(function (b) {
      var done = b.chapters.filter(function (c) {
        return c.status === "done";
      }).length;
      return {
        id: b.id,
        title: b.title,
        author: b.author || "",
        status: b.status,
        statusLabel: b.status === "reading" ? "在读" : b.status === "done" ? "读完" : "想读",
        progress: b.chapters.length ? Math.round((done / b.chapters.length) * 100) : 0,
        chapters: done + "/" + b.chapters.length
      };
    });
    this.setData({ loading: false, books: books });
  },

  onTitle: function (e) { this.setData({ title: e.detail.value }); },
  onAuthor: function (e) { this.setData({ author: e.detail.value }); },
  onPasted: function (e) { this.setData({ pasted: e.detail.value }); },
  toggleAdd: function () { this.setData({ adding: !this.data.adding, title: "", author: "", pasted: "" }); },

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
      "书名：《" + title + "》" +
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
          throw new Error("计划不完整");
        }
        store.createBookFromPlan(title, author, pasted, plan);
        util.toast("已建档", "success");
        that.setData({ adding: false, title: "", author: "", pasted: "" });
        that.render();
      })
      .catch(function (e) {
        util.toast(e.message || "建档失败，稍后再试");
      })
      .then(function () {
        that.setData({ creating: false });
      });
  },

  openBook: function (e) {
    wx.navigateTo({
      url: "/pages/book/book?bookId=" + e.currentTarget.dataset.id
    });
  }
});
