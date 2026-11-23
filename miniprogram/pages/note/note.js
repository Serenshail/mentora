var store = require("../../utils/store.js");
var md = require("../../utils/md.js");
var mastery = require("../../utils/mastery.js");
var util = require("../../utils/util.js");

Page({
  data: {
    note: null,
    blocks: [],
    outLinks: [],
    backLinks: [],
    chips: [],
    masteryLabel: ""
  },

  onLoad: function (query) {
    this.noteId = query.noteId;
  },

  onShow: function () {
    this.render();
  },

  render: function () {
    var k = store.knowledgeById(this.noteId);
    if (!k) {
      this.setData({ note: null });
      return;
    }
    var parsed = md.parse(k.body || "");
    var st = store.state;
    var byId = {};
    st.knowledge.forEach(function (x) {
      byId[x.id] = x;
    });
    var outLinks = (k.links || [])
      .map(function (id) {
        return byId[id] ? { id: id, title: byId[id].title } : null;
      })
      .filter(Boolean);
    var backLinks = st.knowledge
      .filter(function (x) {
        return (x.links || []).indexOf(k.id) >= 0;
      })
      .map(function (x) {
        return { id: x.id, title: x.title };
      });
    // 标题由自绘 nav-bar 组件展示（app.json 全局 navigationStyle: custom），
    // wx.setNavigationBarTitle 在这套导航下没有可见效果；且它的 k.title.slice
    // 是 render 里唯一没兜底的字段访问（云端快照可能带缺 title 的脏条目）。
    // 元信息收成 chips：掌握度有值才显示，避免"未测"占位噪音
    var masteryLabel = mastery.LABELS[k.masteryStatus || "unknown"];
    var chips = [];
    if (masteryLabel && masteryLabel !== "未测") chips.push({ text: masteryLabel, tone: "accent" });
    if (k.nextReviewAt) chips.push({ text: "复习 " + k.nextReviewAt, tone: "dim" });
    if (k.unresolved) chips.push({ text: "未解析链接", tone: "dim" });
    (k.tags || []).forEach(function (t) {
      chips.push({ text: "#" + t, tone: "dim" });
    });

    this.setData({
      note: {
        id: k.id,
        title: k.title || "",
        domain: k.domain || "",
        sourceTitle: k.sourceTitle || "",
        tags: k.tags || [],
        nextReviewAt: k.nextReviewAt || "",
        body: k.body || ""
      },
      chips: chips,
      blocks: parsed.blocks,
      outLinks: outLinks,
      backLinks: backLinks,
      masteryLabel: masteryLabel
    });
  },

  copyCode: function (e) {
    util.copyText(e.currentTarget.dataset.code || "", "代码已复制");
  },

  /* 笔记互链跟随：与站内其余详情跳转（brain→note、goal→day）同为 navigateTo，
   * 保留页面栈，返回手势能沿阅读路径逐篇回溯。redirectTo 会销毁当前页，
   * 连续跟两篇双链就再也回不到上一篇。
   * 小程序页面栈上限 10 层：栈满时 navigateTo 会静默失败（点了没反应），
   * 因此显式降级到 redirectTo——深度浏览仍能继续，只是不再保留回溯。 */
  openLinked: function (e) {
    var id = e.currentTarget.dataset.id;
    var url = "/pages/note/note?noteId=" + id;
    /* 页面栈上限 10 层：留一层余量给后续跳转，栈满时降级 redirectTo，
     * 至少不让点击变成"没反应"。 */
    var depth = 0;
    try {
      depth = getCurrentPages().length;
    } catch (err) {
      /* 非页面环境（测试）：按未满栈处理 */
      void err;
      depth = 0;
    }
    if (depth >= 9) {
      wx.redirectTo({ url: url });
      return;
    }
    wx.navigateTo({
      url: url,
      fail: function () {
        /* 其它失败原因（如页面配置问题）同样不能"点了没反应" */
        wx.redirectTo({ url: url });
      }
    });
  }
});
