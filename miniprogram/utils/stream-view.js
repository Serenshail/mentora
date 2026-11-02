/* ============================================================
 * 流式渲染节流器（性能基础设施）
 *
 * 为什么存在：setData 每次调用都要把数据从逻辑线程序列化传到渲染线程
 * （官方性能纪律：developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/runtime_setData.html）。
 * AI 流式输出每个 delta 都想刷一次 UI——一篇 4000 字讲义会产生几百个
 * delta，每个都全文 md.parse + 整包 setData 就是 O(n²) 的卡顿源。
 *
 * 收口成一个节流器：
 *   · delta 只累积到本地缓冲（零传输、零解析）
 *   · 最多每 ~180ms 才真正回调一次（解析 + setData）
 *   · flush() 在流结束时做最后一次完整刷新（保证不丢尾）
 *   · cancel() 在失败/取消时丢弃挂起的刷新
 * ============================================================ */

function createStreamRenderer(fn, interval) {
  var timer = null;
  var cancelled = false;
  return {
    /** delta 到达时调用：只安排一次延迟刷新，重复调用合并 */
    push: function () {
      if (cancelled || timer) return;
      timer = setTimeout(function () {
        timer = null;
        fn();
      }, interval || 180);
    },
    /**
     * 流结束：无条件执行最后一次完整刷新（保证不丢尾）。
     * 为什么不判断"有没有挂起"：定时器可能刚触发过、fn 已用旧缓冲跑过，
     * 而最后几个 delta 还在缓冲里没被刷出——流结束时必须以最终状态再刷一次。
     */
    flush: function () {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      cancelled = true; // flush 后视为流已结束，后续 push 无效
      fn();
    },
    /** 流失败/取消：丢弃挂起的刷新，且后续 push 不再触发 */
    cancel: function () {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

module.exports = {
  createStreamRenderer: createStreamRenderer
};
