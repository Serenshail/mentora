var store = require("../../utils/store.js");
var api = require("../../utils/api.js");
var chat = require("../../utils/chat.js");
var util = require("../../utils/util.js");

/* 可信书目来源：与 Web src/lib/book-verify.ts 同一份域名白名单。
 * 不能用标题/URL 关键词匹配——"facebook.com/.../《某书》读书会"、"booking.com"、
 * "notebook.example.com" 标题常含书名，命中关键词就会被当成书目证据。 */
var CREDIBLE_HOSTS = [
  "douban.com",
  "jd.com",
  "dangdang.com",
  "baike.baidu.com",
  "wikipedia.org",
  "openlibrary.org",
  "worldcat.org",
  "nlc.cn",
  "books.google.com",
  "amazon.cn",
  "amazon.com",
  "weread.qq.com",
  "book.qq.com"
];

function isCredibleSource(url) {
  var m = /^https?:\/\/([^/?#]+)/i.exec(String(url || "").trim());
  if (!m) return false;
  var host = m[1].toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  return CREDIBLE_HOSTS.some(function (d) {
    return host === d || host.slice(-(d.length + 1)) === "." + d;
  });
}

/* 学习页 = 目标 + 书架。
 * 合并的理由：这两个都是"我在系统学习的东西"，用户心里的模型是"我要学什么"，
 * 不是"技能"和"书"分属两个模块。分成两个 tab 是照抄网页的侧栏结构，
 * 在手机上等于用掉 40% 的导航位去表达一个概念。 */

Page({
  data: {
    loading: true,
    // 会话探测失败（弱网/服务不可达）：给可见失败态 + 重试，别停在 loading
    loadError: false,
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
    this._hidden = false;
    if (!store.state.userId && !api.hasSession()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    /* 「有 cookie」不等于「会话有效」：服务端对失效会话回 200 + {user:null} 且不清 cookie，
     * 30 天过期后 userId 恒 null、hasSession() 恒 true → 守卫永不跳登录、pullIfSafe 恒 skip，
     * 五个 tab 全部永久空态且不自愈。这里补一次显式探测，明确失效就清会话回登录页。 */
    if (!store.state.userId) {
      that.probe();
      return;
    }
    that.render();
    /* 拉取失败要可见：与 day.js:62-63 / app.js / overview / brain 同一口径。
     * 旧实现把返回值扔掉，用户在过期列表上继续编辑后 markDirty→pushNow 会以本机
     * 旧快照整体覆盖云端，抹掉他端改动。 */
    store.pullIfSafe(false).then(function (r) {
      that.render();
      if (r === "error") util.toast("云端对齐失败，请检查网络");
    });
  },

  /* 会话探测。失败不再静默吞掉：弱网下 me() 会 reject，页面停在 loading
   * 就既没有列表也没有空态/错误/重试（两处空态卡都被 !loading 守卫挡住）。
   * 失败时落 loadError，模板给「连接失败 + 重试」，下拉刷新也走这里重新探测。 */
  probe: function () {
    var that = this;
    return api
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
        /* 网络失败保留会话（弱网也会 reject），但必须让失败可见 */
        that.setData({ loading: false, loadError: true });
      });
  },

  /* 切 tab 不卸载页面（learn 是 tab 页），但页面已经不可见：生成完成/失败的 toast
   * 会弹在用户当前停留的另一个 tab 上，用户看不到「已建好阅读路线」，回来只见表单
   * 已关，容易再建一本同书名的重复书（createBookFromPlan 没有同名去重）。
   * 记录可见性，结果只在本页可见时才 toast；书照常建好，onShow 的 render 会把
   * 它列出来——回到本页就能看见，不再靠一条错位的 toast。 */
  onHide: function () {
    this._hidden = true;
  },

  onUnload: function () {
    this._unloaded = true;
    if (this._cancelCreate) this._cancelCreate();
  },

  retry: function () {
    this.setData({ loading: true, loadError: false });
    return this.probe();
  },

  onPullDownRefresh: function () {
    var that = this;
    /* 会话未确认时 pullIfSafe 直接 skip，render 会把「还没有学习目标」错误空态
     * 展示给已登录用户——这里改为重新探测。 */
    if (!store.state.userId) {
      that.retry().then(function () {
        wx.stopPullDownRefresh();
      });
      return;
    }
    store.pullIfSafe(true).then(function (r) {
      that.render();
      wx.stopPullDownRefresh();
      /* 拉取失败要可见：overview.js:73 / brain.js:40 的下拉刷新同口径——下拉是
       * 用户主动动作，静默失败会让用户只看到菊花转完、列表纹丝不动，还可能在
       * 过期快照上继续编辑（onShow 的注释描述过这种覆盖云端的风险）。 */
      if (r === "error") util.toast("同步失败，请检查网络后重试");
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

    this.setData({ loading: false, loadError: false, goals: goals, books: books });
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

  /* 新建目标 → 学习教练引导页（intake → 目标卡 → 总纲要） */
  startCoach: function () {
    wx.navigateTo({ url: "/pages/coach/coach" });
  },

  /* ---- 建档 ---- */
  toggleAdd: function () {
    /* 核查+生成在途（10-30s，creating=true）不允许关弹层：mask 误触会把
     * title/author/pasted（最多 6000 字的粘贴材料）一并清空，书虽照常建成，
     * 但页面没有任何在途指示、失败也只剩一条 2.4s toast——材料只能凭记忆重填。
     * 在途提示就是表单里的「正在解剖这本书…」loading 按钮，所以弹层必须留在这。 */
    if (this.data.creating) return;
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
          /* 生成 10-30s：页面被销毁（reLaunch/返回登录）时中止，别让流跑满 180s
           * 并对已销毁页面 setData。切 tab 只触发 onHide，不取消——书要照常建成。 */
          register: function (cancel) {
            that._cancelCreate = cancel;
          },
          onDelta: function () {}
        })
        .then(function (full) {
          that._cancelCreate = null;
          var plan = chat.extractJson(full);
          if (!plan || !Array.isArray(plan.chapters) || plan.chapters.length < 1) {
            throw new Error("计划不完整，再试一次");
          }
          store.createBookFromPlan(title, author, pasted, plan, verification);
          /* 只在本页可见时提示：否则 toast 弹在别的 tab 上，用户以为没建成而重复建档 */
          if (!that._hidden && !that._unloaded) util.toast("已建好阅读路线", "success");
          that.setData({ adding: false, title: "", author: "", pasted: "", tab: "books" });
          that.render();
        })
        .catch(function (e) {
          that._cancelCreate = null;
          if (that._unloaded) return;
          if (!that._hidden) util.toast(e.message || "建档失败，稍后再试");
        })
        .then(function () {
          if (that._unloaded) return;
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
          return isCredibleSource(r.url) &&
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
