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
    /* 「有 cookie」不等于「会话有效」：服务端对失效会话回 200 + {user:null} 且不清 cookie，
     * 30 天过期后 userId 恒 null、hasSession() 恒 true → 守卫永不跳登录、pullIfSafe 恒 skip，
     * 五个 tab 全部永久空态且不自愈。这里补一次显式探测，明确失效就清会话回登录页。 */
    if (!store.state.userId) {
      api
        .me()
        .then(function (j) {
          if (j && j.user) {
            getApp().globalData.user = j.user;
            return store.onLogin(j.user.userId).then(function () {
              that.render();
            });
          }
          api.clearSession();
          getApp().globalData.user = null;
          wx.reLaunch({ url: "/pages/login/login" });
          return null;
        })
        .catch(function () {
          /* 网络失败保留会话（弱网也会 reject），下次 onShow 重试 */
        });
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
    // 进行中的排最前；同级按创建时间倒序（新目标在前）——次级排序此前只在注释里存在
    var srcGoals = store.state.goals.slice().sort(function (a, b) {
      if ((a.status === "active") !== (b.status === "active")) {
        return a.status === "active" ? -1 : 1;
      }
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
    var goals = srcGoals.map(function (g) {
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

    /* V26.2-H2 书籍真实性核查（与 Web 同语义，PRD §5）：先核查再生成。
     * 核实通过 → verified；核实不过/服务不可用 → 暂停并弹窗，用户坚持且粘贴了材料
     * 才允许基于材料生成（user_material）——绝不给编造的书生成目录。 */
    var generate = function (verification) {
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
          store.createBookFromPlan(title, author, pasted, plan, verification);
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
    };
    var pauseWithModal = function (message) {
      wx.showModal({
        title: "暂时无法核实这本书",
        content: message,
        confirmText: "用我的材料生成",
        cancelText: "换个书名",
        success: function (r) {
          if (r.confirm && pasted) {
            generate("user_material");
          } else if (r.confirm) {
            util.toast("请先在表单里粘贴这本书的原文片段或目录");
            that.setData({ creating: false });
          } else {
            that.setData({ creating: false });
          }
        }
      });
    };
    api
      .searchBooks(title + " " + author + " 书 书籍")
      .then(function (vj) {
        var hits = (vj && vj.results) || [];
        /* 与 Web book-verify.judgeBookEvidence 同判据：可信书目来源 + 标题含书名前 8 字 + 作者匹配 */
        var key = title.replace(/[《》\s：:·、！!？?，,。（()）]/g, "").toLowerCase();
        if (!key) key = title.toLowerCase();
        var credible = hits.filter(function (r) {
          var hay = (r.title || "") + " " + (r.url || "");
          return /豆瓣|百科|出版社|读书|京东|当当|图书|book|douban|baike|wikipedia|图书馆|书目/i.test(hay) &&
            (r.title || "").toLowerCase().indexOf(key.slice(0, 8)) >= 0;
        });
        if (credible.length === 0) {
          pauseWithModal(
            "没有找到《" + title + "》的可信图书来源（豆瓣/百科/出版社记录等）" +
              (author ? "，或来源与作者「" + author + "」不符" : "") +
              "。为避免虚构作者和目录，已暂停生成。可以核对书名后重试，或粘贴这本书的原文材料继续。"
          );
          return;
        }
        if (author && !credible.some(function (r) { return ((r.title || "") + " " + (r.snippet || "")).indexOf(author) >= 0; })) {
          pauseWithModal(
            "找到《" + title + "》的图书记录，但与作者「" + author + "」不符（可能是同名不同作者）。" +
              "请确认作者，或粘贴这本书的原文材料继续。"
          );
          return;
        }
        generate("verified");
      })
      .catch(function () {
        pauseWithModal(
          "核查服务暂时不可用，无法确认《" + title + "》的真实性。为避免虚构内容已暂停生成——可稍后重试，或粘贴这本书的原文材料继续。"
        );
      });
  }
});
