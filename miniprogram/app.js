var store = require("./utils/store.js");
var api = require("./utils/api.js");
/* util 已删（死导入）：app 入口不再加载执行 util.js，toast 都在页面层 */

/* 会话探测在途去重：弱网下 me() 还没返回时切后台再回，onShow 会再发一个——
 * 第二个 me() 触发 onLogin→force 拉取，刚做的本地编辑会被云端快照覆盖。 */
var meInFlight = null;

/* 会话探测失败的重试模态（me() 网络失败与 me() 成功但快照拉取失败共用）。
 * 防重入标志放 globalData.sessionFailModalOpen，utils/session.js 同读同写这一份：
 * 页面探测的失败模态还开着时，这条路径的探测再失败不能在它上面叠出第二张
 * （本文件不 require session.js——App.onShow 先于页面模块加载，require 面也被
 * mp-cold-start-refresh 回归锁钉死，两条探测路径只能经 globalData 互认）。 */
function showSessionFailModal(app) {
  if (app.globalData.sessionFailModalOpen) return;
  if (typeof wx.showModal !== "function") return;
  app.globalData.sessionFailModalOpen = true;
  wx.showModal({
    title: "连接失败",
    content: "网络似乎不可用，暂时没能恢复你的数据。",
    confirmText: "重试",
    cancelText: "暂不",
    success: function (res) {
      app.globalData.sessionFailModalOpen = false;
      if (res.confirm) app.onShow();
    },
    fail: function () {
      app.globalData.sessionFailModalOpen = false;
    }
  });
}

/* 会话已被服务端吊销（Web 端改密/重置密码 bump sv、30 天会话过期、账号注销）：
 * /api/auth/me 对失效会话回 200+user:null，但 /api/sync 回 401——两套语义。
 * 与下方 user:null 分支同一自愈：清掉本机 cookie 回登录页，而不是把 401
 * 误报成网络故障（旧实现此后每次回前台都弹「请检查网络」且永不自愈）。 */
function sessionRevoked(app) {
  api.clearSession();
  app.globalData.user = null;
  wx.reLaunch({ url: "/pages/login/login" });
}

/* 会话恢复完必须让当前页重渲染。
 * 为什么：冷启动进 tab/分享直达页时，各页 onShow 先于 me() 返回就以空 store 渲染完
 * （overview 因 hasSession() 为真跳过自身 probe；book 直达页直接渲染成空白），
 * 而 store.onLogin→pullIfSafe→adoptCloud 只写 state+本机缓存、不 emitStatus，
 * 数据落地后没有任何人通知页面 → 回访用户一直停在「还没有进行中的目标」等误导性空态。
 * 只调 render()：有它的页面（overview/learn/brain/book/day/goal/note/profile/council）才需要补刷；
 * 没有 render() 的页面（review，一次性复习流）维持各自 onShow 的处理，这里不越权猜测入口。 */
function refreshCurrentPage() {
  try {
    var pages = getCurrentPages();
    var cur = pages[pages.length - 1];
    if (cur && typeof cur.render === "function") cur.render();
  } catch (err) {
    /* 页面已销毁/取不到栈：忽略，下次 onShow 自会渲染 */
    void err;
  }
}

App({
  globalData: {
    user: null,
    /* 在途的会话恢复探测：tab 页的 session.js 守卫复用它，
     * 避免同一个冷启动发两次 me()（第二次 onLogin 会再拉一遍全量快照）。 */
    sessionProbe: null
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
      /* App.onShow 与页面 onShow 的先后不保证（冷启动通常 App 先、切 tab 时页面先）：
       * 若 tab 页守卫已经在探测，复用它而不是再发一次。 */
      var pageProbe = that.globalData.sessionProbe;
      if (pageProbe && typeof pageProbe.then === "function") {
        /* 复用页面已在跑的探测：落地后同样补一次重渲染（探测发起方若已不是栈顶页，
         * 没人会替它刷），但不重复拉快照。 */
        var settle = function () {
          meInFlight = null;
          refreshCurrentPage();
        };
        meInFlight = pageProbe.then(settle, settle);
        return;
      }
      meInFlight = api
        .me()
        .then(function (j) {
          if (j && j.user) {
            that.globalData.user = j.user;
            return store.onLogin(j.user.userId).then(function (r) {
              /* 会话恢复 + 本地缓存/云端快照已落地：当前页此前是以空 store 渲染的，
               * 这里补一次重渲染（含 pull 失败只剩本地缓存的场景——数据同样变了）。 */
              refreshCurrentPage();
              if (r === "unauthorized") {
                /* me() 过了但快照拉取途中会话被吊销：与 user:null 同一自愈 */
                sessionRevoked(that);
                return r;
              }
              /* me() 过了但全量快照没拉下来（MB 级全量 + 60s 超时，弱网现实可发生，
               * me() 体量小通常能过）：失败必须可见。旧实现把 r 扔掉——本机无缓存时
               * 直达页停在「书不存在」式假空态，用户既不知道是网络问题也没有重试
               * 入口；me() 网络失败的那条保护实际只覆盖了恢复链路的一半。 */
              if (r === "error") {
                showSessionFailModal(that);
              }
              return r;
            });
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
          /* 网络失败不能清会话（弱网也会 reject）；保持现状，下次 onShow 重试。
           * 但失败必须可见：这条链路是带 cookie 冷启动的常规路径，静默吞掉会让
           * 用户停在空态/「书不存在」，既不知道是网络问题也没有重试入口
           * （与 overview probe 的「连接失败 + 重试/暂不」模态同一模式）。 */
          showSessionFailModal(that);
        })
        .then(function () {
          meInFlight = null;
          that.globalData.sessionProbe = null;
        });
      that.globalData.sessionProbe = meInFlight;
    } else {
      /* 回前台对齐的失败要可见：旧实现把 "error" 返回值扔掉，
       * 拉取悄悄失败，用户以为数据已是最新。 */
      store.pullIfSafe(false).then(function (r) {
        if (r === "unauthorized") {
          /* 会话已被服务端吊销（Web 端改密/30 天过期/注销，/api/sync 对失效会话
           * 回 401 而非 user:null）：清会话回登录页自愈，而不是每次回前台都
           * 弹误导性的「请检查网络」。 */
          sessionRevoked(that);
          return;
        }
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
