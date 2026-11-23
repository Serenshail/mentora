/* 登录后回跳目标的唯一守卫（login-form 消费）。
 * 独立成模块以便单测锁定：只认站内绝对路径，其余一律回首页。
 *
 * 为什么不能只做正则黑名单：WHATWG URL 解析在 new URL(href, base) 之前会
 * 剥离所有 ASCII tab/LF/CR（U+0009/000A/000D），也会把 \ 归一成 /。历史上
 * 的黑名单式正则 /^\/[^/\\]/ 既漏掉控制字符变体（/\t//evil.com → //evil.com
 * → 出站），又会误伤带查询串的合法路径。
 *
 * 现在的做法：白名单式——
 *   1. 拒绝任何控制字符（C0 + DEL）与反斜杠；
 *   2. 必须以单个 / 开头（排除 //、/\ 协议相对）；
 *   3. 再用与浏览器同源的 URL 解析复核一次，确保解析后仍在本站。
 * 任一不满足即回首页。 */
const CONTROL_OR_BACKSLASH = /[\u0000-\u001F\u007F\\]/;

export function safeNext(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  // 控制字符（含 tab/LF/CR）与反斜杠：浏览器解析时会剥离/归一，必须直接拒绝
  if (CONTROL_OR_BACKSLASH.test(raw)) return "/";
  // 必须以单个 / 开头：排除 //evil.com、http://、javascript: 等
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  // 同源复核：用固定 base 解析，确认解析结果仍落在该 base 内（防止编码/畸形路径绕过）
  try {
    const base = "https://mentora.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return "/";
  } catch {
    return "/";
  }
  return raw;
}
