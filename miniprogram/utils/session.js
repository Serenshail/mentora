/* ========= 会话守卫（tab 页共用） =========
 * 冷启动/分享直达时 store.userId 还没恢复，但 cookie 可能有效。此前各页各写一套守卫，
 * 同一问题出现五种行为：
 *  · council 只看 userId/globalData.user → 探测还没返回就 reLaunch 登录页，
 *    把 cookie 其实有效的用户踢走（login 页也没有已有会话自动跳回）；
 *  · brain/profile 只看「有没有 cookie」→ 有 cookie 就既不探测也不跳转，
 *    停在「第二大脑还是空的」/「未登录」误导性空态且不自愈；
 *  · learn/overview 各自探测（语义正确，但各写一遍）。
 * 这里统一语义：
 *   userId 已恢复            → 直接 onReady()
 *   没有 cookie              → 明确未登录，回登录页
 *   有 cookie 但 userId 为空 → me() 探测：成功 → onLogin 后 onReady()；
 *                              服务端明确回 user:null → 清会话回登录页；
 *                              网络失败 → 保留会话，弹「重试/暂不」（不踢人）。
 * 探测在途去重：多个 tab 同时 onShow 只发一个 me()；App.onShow 也复用同一个，
 * 避免同一次冷启动把全量快照拉两遍。 */
var api = require("./api.js");

/* 在途探测（resolve 是否恢复成功） */
var probing = null;
/* 等待渲染的页面回调（每次 onShow 传一个新闭包，无法按函数身份去重）。
 * 队列只保留最近若干个：探测在途期间反复切 tab 时不能无限增长，
 * 真正需要补刷的也只是栈顶那几页。 */
var WAITER_MAX = 8;
var waiters = [];
/* 模态防重入标志放 globalData（app.js 同读同写这一份）：
 * app.js 的冷启动探测不 require 本模块（App.onShow 先于页面模块加载，
 * require 面也被 mp-cold-start-refresh 回归锁钉死），两条探测路径只能经
 * globalData 互认——否则页面探测的失败模态还开着时，App.onShow 的探测
 * 再失败会在它上面叠出第二张一模一样的模态。 */
var failModalOpen = false;

function addWaiter(fn) {
  waiters.push(fn);
  if (waiters.length > WAITER_MAX) waiters = waiters.slice(-WAITER_MAX);
}

/* 读（v 省略）/写（v 传值）共享的模态防重入标志；无 app 实例（测试/异常）退回模块内标志 */
function modalOpen(v) {
  try {
    var app = getApp();
    if (app && app.globalData) {
      if (v === undefined) return Boolean(app.globalData.sessionFailModalOpen);
      app.globalData.sessionFailModalOpen = Boolean(v);
      return Boolean(v);
    }
  } catch (e) {
    /* 无 app 实例：退回模块内标志 */
  }
  if (v === undefined) return failModalOpen;
  failModalOpen = Boolean(v);
  return failModalOpen;
}

function showFailModal(onRetry) {
  if (modalOpen() || typeof wx.showModal !== "function") return;
  modalOpen(true);
  wx.showModal({
    title: "连接失败",
    content: "网络似乎不可用，暂时没能恢复你的数据。",
    confirmText: "重试",
    cancelText: "暂不",
    success: function (res) {
      modalOpen(false);
      if (res.confirm) {
        onRetry();
      } else {
        /* 「暂不」后的悬置收口：onRetry 不执行、waiters 原样保留，当前页停在
         * booting/loading 态且页内没有任何失败残留或重试入口。唯一恢复路径是
         * 下一次 onShow 重新探测（waiters 还在，重试成功会照样渲染）——至少把
         * 「为什么停在这」和「怎么恢复」讲出来，别让用户对着空白页猜。 */
        try {
          wx.showToast({
            title: "已暂跳恢复，切换页签或稍后再回来会自动重试",
            icon: "none",
            duration: 3000
          });
        } catch (e) { /* 无 toast 环境忽略：模态本身已让失败可见 */ }
      }
    },
    fail: function () {
      modalOpen(false);
    }
  });
}

function flushWaiters() {
  var list = waiters;
  waiters = [];
  for (var i = 0; i < list.length; i++) {
    try {
      list[i]();
    } catch (e) {
      /* 隔离意图不变：单页渲染异常不影响其它页的恢复。但不能无痕吞掉——
       * 该页会永久停在 booting/loading 态且无 toast，线上排查全靠这里留痕
       * （前缀口径与 app.js onError 的 "[mentora]" 一致）。 */
      try {
        console.error("[mentora] flushWaiters 单页恢复回调异常:", e);
      } catch (e2) { /* 极端环境无 console：维持原静默行为 */ }
    }
  }
}

function publishProbe(p) {
  try {
    var app = getApp();
    if (app && app.globalData) app.globalData.sessionProbe = p;
  } catch (e) {
    /* 无 app 实例（测试/异常）：不登记，行为退化为各自探测 */
  }
}

function clearPublishedProbe() {
  try {
    var app = getApp();
    if (app && app.globalData) app.globalData.sessionProbe = null;
  } catch (e) {
    /* 忽略 */
  }
}

/* 真正发 me()：成功 → onLogin（loadLocal + 拉快照）；user:null → 清会话回登录页；
 * 网络失败 → 保留会话 + 可见重试。 */
function probeOnce(store) {
  return api
    .me()
    .then(function (j) {
      if (j && j.user) {
        getApp().globalData.user = j.user;
        return store.onLogin(j.user.userId).then(function (r) {
          /* onLogin 的返回值是 force-pull 的结果，不能扔掉：
           * · "unauthorized"：全量拉取途中会话被吊销（改密/过期/注销），
           *   与 user:null 同一自愈——清会话回登录页；
           * · "error"：me() 过了但快照没拉下来（MB 级全量 + 60s 超时，弱网现实
           *   可发生）。本机无缓存时页面停在「书不存在」式假空态且无重试入口，
           *   与 me() 失败同模态给重试（标志互认，不会叠出第二张）。 */
          if (r === "unauthorized") {
            api.clearSession();
            getApp().globalData.user = null;
            wx.reLaunch({ url: "/pages/login/login" });
            return false;
          }
          if (r === "error") {
            showFailModal(function () {
              startProbe(store);
            });
          }
          return true;
        });
      }
      /* 服务端明确回 user:null：会话已失效/被吊销，cookie 不清会永远跳过探测 */
      api.clearSession();
      getApp().globalData.user = null;
      wx.reLaunch({ url: "/pages/login/login" });
      return false;
    })
    .catch(function () {
      /* 网络失败 ≠ 未登录：保留 cookie，给可见失败与重试入口。
       * 重试直接重跑探测，等待中的页面回调原样保留——重试成功要照样渲染。 */
      showFailModal(function () {
        startProbe(store);
      });
      return false;
    });
}

/* 发起（或复用）一次探测，落地后统一通知等待者。 */
function startProbe(store) {
  if (probing) return probing;

  /* App.onShow 也可能已经在探测：复用它，别再发一次（第二次 onLogin 会再拉全量快照）。
   * 它自己处理 user:null→回登录页 与网络失败→重试模态，这里只关心是否恢复成功。 */
  var appProbe = null;
  try {
    var app = getApp();
    appProbe = app && app.globalData ? app.globalData.sessionProbe : null;
  } catch (e) {
    appProbe = null;
  }

  var started;
  if (appProbe && typeof appProbe.then === "function") {
    var settled = function () {
      return Boolean(require("./store.js").state.userId);
    };
    started = appProbe.then(settled, settled);
  } else {
    started = probeOnce(store);
    publishProbe(started);
  }

  probing = started.then(function (ok) {
    probing = null;
    /* 探测已落地：撤掉登记，别让后续 onShow 复用一个已结束的探测，
     * 否则重试会永远不发新请求。 */
    clearPublishedProbe();
    if (ok) flushWaiters();
    return ok;
  });
  return probing;
}

/* 页面 onShow 的入口。onReady 在该页可以渲染时调用（同步或探测成功后）。 */
function ensure(onReady) {
  /* 惰性 require：store 是模块级单例，跟随调用时刻的实例（测试里会重载模块） */
  var store = require("./store.js");

  if (store.state.userId) {
    if (onReady) onReady();
    return Promise.resolve(true);
  }
  if (!api.hasSession()) {
    wx.reLaunch({ url: "/pages/login/login" });
    return Promise.resolve(false);
  }
  if (onReady) addWaiter(onReady);
  return startProbe(store);
}

module.exports = { ensure: ensure };
