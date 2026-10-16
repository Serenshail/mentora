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
    void fetch("/api/track", {
      method: "POST",
      body,
      keepalive: true,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    /* 埋点失败不影响产品 */
  }
}
