var api = require("../../utils/api.js");
var store = require("../../utils/store.js");
var config = require("../../config.js");
var util = require("../../utils/util.js");

var BASE_META = {
  prod: { label: "官方部署", desc: "Vercel，开发者工具里走代理可达" },
  tunnel: { label: "本机隧道", desc: "UUMit 映射，真机预览用，需电脑服务在跑" },
  local: { label: "本机开发", desc: "localhost:3000，只在开发者工具里用" }
};

Page({
  data: {
    user: null,
    sync: "",
    syncTone: "idle",
    counts: { goals: 0, notes: 0, books: 0, sessions: 0 },
    baseId: "prod",
    bases: [],
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
                ? "同步失败，稍后自动重试"
                : "",
        syncTone: s === "saved" ? "ok" : s === "error" ? "bad" : s === "saving" ? "accent" : "idle"
      });
    });
    that.render();
  },

  onHide: function () {
    if (this._offSync) {
      this._offSync();
      this._offSync = null;
    }
  },

  render: function () {
    var st = store.state;
    var baseId = config.currentId();
    // 用 config.BASES 的键序生成列表，保证与可切换集合一致（不硬编码三个字符串）
    var bases = Object.keys(config.BASES).map(function (id) {
      var meta = BASE_META[id] || { label: id, desc: "" };
      return { id: id, label: meta.label, desc: meta.desc };
    });
    this.setData({
      user: getApp().globalData.user,
      counts: {
        goals: st.goals.length,
        notes: st.knowledge.length,
        books: st.books.length,
        sessions: st.sessions.length
      },
      baseId: baseId,
      bases: bases
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
        util.toast("网址已复制，去浏览器打开");
      }
    });
  },

  switchBase: function (e) {
    var that = this;
    var id = e.currentTarget.dataset.id;
    if (!id || id === config.currentId() || !config.BASES[id]) return;
    wx.showModal({
      title: "切换连接？",
      content: "切换后需要重新登录。",
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
