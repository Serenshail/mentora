var store = require("./utils/store.js");
var api = require("./utils/api.js");
/* util 已删（死导入）：app 入口不再加载执行 util.js，toast 都在页面层 */

/* 会话探测在途去重：弱网下 me() 还没返回时切后台再回，onShow 会再发一个——
 * 第二个 me() 触发 onLogin→force 拉取，刚做的本地编辑会被云端快照覆盖。 */
var meInFlight = null;

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
      if (meInFlight) return;
      meInFlight = api
        .me()
        .then(function (j) {
          if (j && j.user) {
            that.globalData.user = j.user;
            return store.onLogin(j.user.userId);
          }
          /* 服务端明确回了 user:null（会话已失效/被吊销）：清掉本机 cookie 并回登录页。
           * 旧实现只 return null——各 tab 的守卫看到"cookie 还在"就跳过自身探测，
           * 于是 store.userId 恒 null、pullIfSafe 全 skip，页面永久空白且不自愈。 */
          api.clearSession();
          that.globalData.user = null;
          wx.reLaunch({ url: "/pages/login/login" });
          return null;
        })
        .catch(function () {
          /* 网络失败不能清会话（弱网也会 reject）；保持现状，下次 onShow 重试 */
        })
        .then(function () {
          meInFlight = null;
        });
    } else {
      /* 回前台对齐的失败要可见：旧实现把 "error" 返回值扔掉，
       * 拉取悄悄失败，用户以为数据已是最新。 */
      store.pullIfSafe(false).then(function (r) {
        if (r === "error") {
          wx.showToast({ title: "云端对齐失败，请检查网络", icon: "none", duration: 2400 });
        }
      });
    }
  },

  onHide: function () {
    store.flushPush();
  },

  onError: function (err) {
    console.error("[mentora]", err);
  }
});
