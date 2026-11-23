var api = require("../../utils/api.js");
var store = require("../../utils/store.js");
var config = require("../../config.js");
var util = require("../../utils/util.js");
var sessionGuard = require("../../utils/session.js");

var BASE_META = {
  prod: { label: "官方部署", desc: "Vercel，开发者工具里走代理可达" },
  tunnel: { label: "本机隧道", desc: "UUMit 映射，真机预览用，需电脑服务在跑" },
  local: { label: "本机开发", desc: "localhost:3000，只在开发者工具里用" }
};

Page({
  data: {
    user: null,
    /* 会话恢复中：头部不能先显示「未登录」、计数也不该先报 0 */
    booting: true,
    sync: "",
    syncTone: "idle",
    counts: { goals: 0, notes: 0, books: 0, sessions: 0 },
    baseId: "prod",
    bases: [],
    busy: false
  },

  onShow: function () {
    var that = this;
    that._offSync = store.onSyncStatus(function (s) {
      that.setData({
        sync:
          s === "saving"
            ? "同步中…"
            : s === "saved"
              ? "已同步"
              : s === "error"
                ? "同步失败，稍后自动重试"
                : s === "conflict"
                  ? "数据分叉，请在上方选择恢复或推送"
                  : "",
        syncTone: s === "saved" ? "ok" : s === "error" || s === "conflict" ? "bad" : s === "saving" ? "accent" : "idle"
      });
    });
    /* 旧守卫只判「有没有 cookie」：冷启动时 userId 未恢复就 render，头部显示
     * 「未登录」、计数全 0；store 又不会自己 loadLocal。统一走 session.ensure，
     * 会话恢复后再渲染。 */
    sessionGuard.ensure(function () {
      that.render();
    });
  },

  onHide: function () {
    this.unbindSync();
  },

  /* 本页唯一的销毁路径（logout/switchBase 的 reLaunch）只触发 onUnload，不触发 onHide：
   * 只挂 onHide 会让监听器残留，并且继续对已销毁的页面 setData。 */
  onUnload: function () {
    this.unbindSync();
  },

  unbindSync: function () {
    if (this._offSync) {
      this._offSync();
      this._offSync = null;
    }
  },

  render: function () {
    var st = store.state;
    var baseId = config.currentId();
    // 只列当前环境允许的后端（正式包只有 prod，避免用户切到不可达地址后锁死）
    var bases = Object.keys(config.availableBases()).map(function (id) {
      var meta = BASE_META[id] || { label: id, desc: "" };
      return { id: id, label: meta.label, desc: meta.desc };
    });
    this.setData({
      booting: false,
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
      /* 这一项的字面语义就是「以云端快照为准，覆盖本机」：用户显式点了它，
       * 分叉时（云端有他端更新 + 本机有未推送改动）必须真的采用云端，
       * 不能被脏标记守卫挡回来。 */
      .pullIfSafe(true, { restore: true })
      .then(function (r) {
        util.toast(
          r === "pulled"
            ? "已采用云端数据"
            : r === "pushed"
              ? "本机数据已推上云"
              : r === "conflict"
                ? "云端已有他端更新，本机还有未推送改动：请确认后再选「从云端恢复」或「推送到云端」"
                : r === "error"
                  ? "同步失败，请检查网络后重试"
                  : "云端与本机已一致"
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
        // 等最后一批改动推上云再切后端：onLogout 内部会排空在途推送
        store.onLogout().then(function () {
          api.clearSession();
          getApp().globalData.user = null;
          config.set(id);
          wx.reLaunch({ url: "/pages/login/login" });
        });
      }
    });
  },

  logout: function () {
    wx.showModal({
      title: "退出登录？",
      content: "本机数据已同步到云端，退出后随时可以登录回来。",
      success: function (res) {
        if (!res.confirm) return;
        // 先让在途推送落地，避免退出瞬间的改动被丢掉
        store.onLogout().then(function () {
          api.logout();
          getApp().globalData.user = null;
          api.clearSession();
          wx.reLaunch({ url: "/pages/login/login" });
        });
      }
    });
  }
});
