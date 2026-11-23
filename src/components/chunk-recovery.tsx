/* 部署后旧标签页白屏自愈：页面 HTML 引用的 JS chunk 在新部署下 404，
 * hydration 永不发生 → 整页空白（用户感知"进不去还一直卡"）。
 *
 * 注册点必须是「随 HTML 解析即执行的内联脚本」，不能是 useEffect：
 * 本组件自身就打在初始 entry chunk 里，entry chunk 404 时 React 根本不执行，
 * useEffect 里的监听器永远不会注册——那正是上面点名的冷启动场景
 * （缓存/CDN 旧 HTML + 新部署）。内联脚本不依赖任何 Next chunk，HTML 一解析
 * 就注册，与后续 chunk 是否加载成功无关；监听器常驻整个文档生命周期，
 * hydration 之后旧标签页内导航、动态 import 的 chunk 失败走同一 error 捕获
 * 路径，同样被覆盖。也不能用 next/script beforeInteractive：app 目录下它只是
 * push 到 self.__next_s，由 app-bootstrap 在 entry chunk 执行后才加载，
 * entry 404 时同样不会跑（node_modules/next/dist/client/script.js:274、
 * app-bootstrap.js:52）。
 *
 * 位置：layout.tsx 里 <head> 中，早于 <AppShell>。
 * 为什么必须在 head 而不是 body 首个节点：Next 把 <link rel=stylesheet> 放在
 * head 最前，挂起的样式表会阻塞解析器；body 起始处的脚本要等 CSS 才执行，
 * 慢 CSS 下会晚于最早几个 chunk 的 error 事件（实测 5s CSS 延迟时 body 版
 * 有 12/13 个 error 先于注册而漏掉）。移到 head（样式表之后、其余 async chunk
 * 之前）后同一场景实测 0 个 error 先于注册。
 *
 * 命中 _next/static/chunks/ 的 JS chunk 加载失败就强制刷新一次（只认 chunk，不认
 * 图片/样式等其它 _next/static 资源：它们失败不影响 hydration，不该拖整页刷新）；
 * sessionStorage 记时间戳
 * 防循环（TTL 内不重复刷，此后允许再自愈一次——旧实现整个会话永不复位，
 * 同会话第二次 chunk 404 就没人管了）。隐私模式下 sessionStorage 读写会抛错，
 * 因此都包 try/catch：宁可放弃防循环，也要自愈一次。 */

/* 内联脚本内容（ES5 写法）：不依赖 React/Next 运行时，HTML 解析到这里就执行。
 * 脚本可能因 HTML 被重复内联而执行两次，用 window 标记保证只挂一个监听器。 */
const SCRIPT = `(function(){
  if (window.__mentoraChunkRecovery) return;
  window.__mentoraChunkRecovery = 1;
  var KEY = "mentora-chunk-retry";
  var TTL_MS = 120000;
  window.addEventListener("error", function (e) {
    var t = e && e.target;
    var src = (t && t.src) || "";
    /* 只认 JS chunk：/<script src> 之外的资源（图片 /_next/static/media、
       样式 /_next/static/css、字体等）失败不影响 hydration，不该拖整页 reload——
       弱网下一次瞬时图片失败就刷新会打断进行中的 AI 流式生成与内存态。 */
    if (!src || src.indexOf("/_next/static/chunks/") === -1) return;
    var last = 0;
    try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch (_) {}
    if (last && Date.now() - last < TTL_MS) return;
    try { sessionStorage.setItem(KEY, String(Date.now())); } catch (_) {}
    location.reload();
  }, true);
})();`;

/* 服务端组件（无 hooks、无 "use client"）：输出的 <script> 直接进 SSR/预渲染
 * HTML，不经过客户端 hydration 才生效。 */
export function ChunkRecovery() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}

/* 导出脚本正文仅供回归锁单测断言（生产代码不读取）。 */
export const CHUNK_RECOVERY_SCRIPT = SCRIPT;
