var api = require("../../utils/api.js");
var store = require("../../utils/store.js");
var config = require("../../config.js");
var util = require("../../utils/util.js");

var BASE_LABELS = {
  prod: "官方部署（Vercel）",
  tunnel: "本机隧道（UUMit）",
  local: "本机开发（localhost）"
};

Page({
  data: {
    user: null,
    sync: "",
    counts: { goals: 0, notes: 0, books: 0, sessions: 0 },
    baseId: "prod",
    baseLabel: "",
    switching: false,
    busy: false
  },

  onShow: function () {
    var that = this;
    if (!store.state.userId && !api.hasSession()) {
      wx.reLaunch({ url: "/pages/login/login" });
      return;
    }
    that._offSync = store.onSyncStatus(function (s) {
      that.setData({
        sync:
          s === "saving"
            ? "同步中…"
            : s === "saved"
              ? "已同步"
              : s === "error"
                ? "同步失败"
                : ""
      });
    });
    that.render();
  },

  onHide: function () {
    if (this._offSync) this._offSync();
  },

  render: function () {
    var st = store.state;
    this.setData({
      user: getApp().globalData.user,
      counts: {
        goals: st.goals.length,
        notes: st.knowledge.length,
        books: st.books.length,
        sessions: st.sessions.length
      },
      baseId: config.currentId(),
      baseLabel: BASE_LABELS[config.currentId()] || ""
    });
  },

  pullNow: function () {
    var that = this;
    if (that.data.busy) return;
    that.setData({ busy: true });
    store
      .pullIfSafe(true)
      .then(function (r) {
        util.toast(
          r === "pulled" ? "已采用云端数据" : r === "pushed" ? "本机数据已推上云" : "云端与本机已一致"
        );
        that.render();
      })
      .then(function () {
        that.setData({ busy: false });
      });
  },

  pushNow: function () {
    var that = this;
    if (that.data.busy) return;
    that.setData({ busy: true });
    store
      .pushNow()
      .then(function (ok) {
        util.toast(ok ? "已推送到云端" : "推送失败，稍后自动重试");
      })
      .then(function () {
        that.setData({ busy: false });
      });
  },

  copyWebUrl: function () {
    wx.setClipboardData({
      data: "https://mentora-orpin.vercel.app",
      success: function () {
        util.toast("网址已复制，去浏览器打开网页版");
      }
    });
  },

  noop: function () {},

  switchBase: function (e) {
    var that = this;
    var id = e.currentTarget.dataset.id;
    if (!id || id === config.currentId() || !config.BASES[id]) return;
    wx.showModal({
      title: "切换后端？",
      content: "切换到「" + BASE_LABELS[id] + "」后需要重新登录。",
      success: function (res) {
        if (!res.confirm) return;
        store.onLogout();
        api.clearSession();
        getApp().globalData.user = null;
        config.set(id);
        wx.reLaunch({ url: "/pages/login/login" });
      }
    });
  },

  logout: function () {
    var that = this;
    wx.showModal({
      title: "退出登录？",
      content: "本机数据已同步到云端，退出后随时可以登录回来。",
      success: function (res) {
        if (!res.confirm) return;
        store.onLogout();
        api.logout();
        getApp().globalData.user = null;
        api.clearSession();
        wx.reLaunch({ url: "/pages/login/login" });
      }
    });
  }
});
