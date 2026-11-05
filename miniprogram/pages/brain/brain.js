var store = require("../../utils/store.js");
var api = require("../../utils/api.js");
var md = require("../../utils/md.js");

Page({
  data: {
    loading: true,
    total: 0,
    linkCount: 0,
    dueCount: 0,
    query: "",
    folders: [],
    activeFolder: "",
    notes: []
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
    var st = store.state;
    var linkCount = 0;
    st.knowledge.forEach(function (k) {
      linkCount += (k.links || []).length;
    });
    var folders = {};
    st.knowledge.forEach(function (k) {
      var top = (k.domain || "").split("/")[0];
      if (top) folders[top] = true;
    });
    this._folders = Object.keys(folders).sort();
    this.setData({
      loading: false,
      total: st.knowledge.length,
      linkCount: linkCount,
      dueCount: store.dueReviews().length,
      folders: this._folders
    });
    this.filter();
  },

  filter: function () {
    var st = store.state;
    var q = this.data.query.trim().toLowerCase();
    var folder = this.data.activeFolder;
    var today = new Date().toISOString().slice(0, 10);

    /* 摘要缓存：md.plain 是全正文正则清洗，几百篇笔记每次按键全跑一遍
     * 是明显的输入卡顿源。缓存放页面实例上（跟着页面生命周期）。
     * 键 = id + updatedAt：withMoc 原地更新 MOC 正文或云端 pull 后，旧摘要不该继续展示。 */
    if (!this._excerptCache) this._excerptCache = {};
    var cache = this._excerptCache;
    function excerptOf(k) {
      var key = k.id + "|" + (k.updatedAt || "");
      if (!cache[key]) {
        cache[key] = md.plain((k.body || "").replace(/^#{1,6}\s+/gm, "")).slice(0, 80);
      }
      return cache[key];
    }

    var notes = st.knowledge
      .filter(function (k) {
        if (folder && (k.domain || "").split("/")[0] !== folder) return false;
        if (!q) return true;
        return (
          (k.title || "").toLowerCase().indexOf(q) >= 0 ||
          (k.body || "").toLowerCase().indexOf(q) >= 0 ||
          (k.tags || []).join(" ").toLowerCase().indexOf(q) >= 0
        );
      })
      .slice(0, 300)
      .map(function (k) {
        return {
          id: k.id,
          title: k.title,
          domain: k.domain || "",
          excerpt: excerptOf(k),
          due: Boolean(k.nextReviewAt && k.nextReviewAt <= today),
          unresolved: Boolean(k.unresolved)
        };
      });
    this.setData({ notes: notes });
  },

  onQuery: function (e) {
    var that = this;
    this.setData({ query: e.detail.value });
    /* 搜索节流：输入法组合期每键都全表过滤（几百篇 × 3 字段 indexOf）
     * 会卡输入。200ms 防抖对打字手感无感知。 */
    if (this._queryTimer) clearTimeout(this._queryTimer);
    this._queryTimer = setTimeout(function () {
      that._queryTimer = null;
      that.filter();
    }, 200);
  },

  onUnload: function () {
    if (this._queryTimer) clearTimeout(this._queryTimer);
    this._excerptCache = null;
  },

  pickFolder: function (e) {
    var f = e.currentTarget.dataset.f;
    this.setData({ activeFolder: this.data.activeFolder === f ? "" : f });
    this.filter();
  },

  openNote: function (e) {
    wx.navigateTo({
      url: "/pages/note/note?noteId=" + e.currentTarget.dataset.id
    });
  },

  goReview: function () {
    wx.navigateTo({ url: "/pages/review/review" });
  }
});
