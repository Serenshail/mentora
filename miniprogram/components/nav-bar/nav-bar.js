/* ============================================================
 * 导航栏（自定义 navigationStyle）
 *
 * 为什么自绘：系统导航栏和页面内容之间总有一条断层——它固定 44px、
 * 居中标题、不能承载"返回 + 动作"的层级。手机版只保留两种：
 *   · tab 页（home=true）：只显示 Mentora 字标，没有返回
 *   · 详情页（home=false）：返回箭头 + 当前页面语境
 *
 * 顶部高度 = 状态栏高度 + 44px，状态栏高度由 wx.getWindowInfo 取（多机型安全）。
 * ============================================================ */
var metrics = null;

function getMetrics() {
  if (metrics) return metrics;
  var statusBar = 20;
  try {
    var info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    statusBar = info.statusBarHeight || 20;
  } catch (e) {
    /* 取不到就用默认值：宁可偏 20px，也不让导航塌掉 */
  }
  // 导航条本体 = 44px（Apple HIG 最小可触摸高度）
  var navBar = 44;
  metrics = {
    statusBar: statusBar,
    navBar: navBar,
    // 整块高度（px），页面顶部需要留这么多 padding
    total: statusBar + navBar
  };
  return metrics;
}

Component({
  options: {
    // 允许宿主页面通过 class 覆盖外边距
    addGlobalClass: true
  },

  properties: {
    /** 主标题。tab 页留空即只显示字标 */
    title: { type: String, value: "" },
    /** 是否是 tab 页（不显示返回箭头） */
    home: { type: Boolean, value: false },
    /** 导航权交宿主页：触发 back 事件后组件不再自己导航。
     * 为什么需要：tab 页（council）内部的 pick/chat 视图共用一个页面实例，
     * getCurrentPages() 栈长恒为 1，下面的 switchTab 兜底会把用户甩到
     * 「今天」tab 而不是本页的列表视图——宿主绑定 back 后自行切内部视图。 */
    hostNav: { type: Boolean, value: false },
    /** 是否给页面内容留出导航高度（false = 仅画背景，内容自己处理） */
    spacer: { type: Boolean, value: true },
    /** 滚动后是否显示底部分割线 */
    bordered: { type: Boolean, value: false }
  },

  data: {
    m: { statusBar: 20, navBar: 44, total: 64 }
  },

  lifetimes: {
    attached: function () {
      var m = getMetrics();
      this.setData({ m: m });
      /* 把真实导航高度写到页面级 CSS 变量上：
       * 全屏对话类页面（council/book）需要用它算内容区高度，
       * 而它们各自在 wxss 里无法知道状态栏高度。 */
      try {
        var pages = getCurrentPages();
        var cur = pages[pages.length - 1];
        if (cur && cur.setData) cur.setData({ navH: m.total + "px" });
      } catch (e) {
        /* 取不到就退回默认值，不影响渲染 */
      }
    }
  },

  methods: {
    onBack: function () {
      /* 先通知宿主页：tab 页的返回走 switchTab，不会触发 onUnload，
       * 在途的长任务（圆桌多席串行、计费）需要页面自己在导航前中止。 */
      try {
        this.triggerEvent("back");
      } catch (e) {
        /* 无监听方/组件已销毁：忽略 */
      }
      /* host-nav：宿主全权接管导航（tab 页内部视图返回 = 切本页视图，不能
       * 落到下面的 switchTab 兜底）。未声明时保持原行为。 */
      if (this.data.hostNav) return;
      var pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ delta: 1 });
      } else {
        // 从分享/收藏直接进来时没有上一页，回 tab 首页而不是白屏
        wx.switchTab({ url: "/pages/overview/overview" });
      }
    }
  }
});
