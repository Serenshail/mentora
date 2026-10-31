var store = require("./utils/store.js");
var api = require("./utils/api.js");
var util = require("./utils/util.js");

App({
  globalData: {
    user: null
  },

  onLaunch: function () {
    // 会话探测放页面里做（tab 页 onShow 各自守卫），这里只挂同步状态
  },

  onShow: function () {
    // 回前台对齐云端：本地有未推送改动时 store 内部会拒绝拉取
    var that = this;
    if (!api.hasSession()) return;
    if (!store.state.userId) {
      // 冷启动直接进内页（分享/收藏入口）：先恢复会话再拉数据
      api
        .me()
        .then(function (j) {
          if (j && j.user) {
            that.globalData.user = j.user;
            return store.onLogin(j.user.userId);
          }
          return null;
        })
        .catch(function () {});
    } else {
      store.pullIfSafe(false);
    }
  },

  onHide: function () {
    store.flushPush();
  },

  onError: function (err) {
    console.error("[mentora]", err);
  }
});
