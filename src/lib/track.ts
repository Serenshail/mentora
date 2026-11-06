"use client";

/* ============================================================
 * 产品漏斗埋点（客户端 fire-and-forget）
 * - 无 PII：不传邮箱/内容原文，账号维度由服务端从会话派生（emailHash）
 * - 绝不影响主流程：任何失败静默丢弃
 * - 核心漏斗：intake_start → intake_complete → plan_generated → day_pass → review_done
 * ============================================================ */

export function track(name: string, props: Record<string, unknown> = {}): void {
  if (typeof window === "undefined") return;
  try {
    const body = JSON.stringify({
      n: name,
      p: props,
      path: location.pathname.slice(0, 200),
      t: Date.now(),
    });
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon("/api/track", blob)) return;
    /* 兜底 fetch 的 rejection 也要接住：fire-and-forget 不许产生 unhandled rejection */
    void fetch("/api/track", {
      method: "POST",
      body,
      keepalive: true,
      headers: { "Content-Type": "application/json" },
    }).catch(() => {});
  } catch {
    /* 埋点失败不影响产品 */
  }
}

/* v26.1 阅读实验事件：统一带 sid（学习会话）与 experiment_version。
 * sid 由页面写入 sessionStorage（reading-sid-<bookId>），store 层动作也能关联到会话。
 * 防重纪律：成功型事件只在 store 数据动作成功后发（数据落库=事件成功），UI 层只发 intent 型。 */
export function trackReading(name: string, props: { bookId: string; [k: string]: unknown }): void {
  let sid: string | undefined;
  try {
    sid = sessionStorage.getItem(`reading-sid-${props.bookId}`) ?? undefined;
  } catch {
    /* 隐私模式无 sessionStorage：事件照发，只是无会话关联 */
  }
  track(name, { ...props, sid, v: "v26.1" });
}
