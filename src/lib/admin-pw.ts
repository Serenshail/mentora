/* 后台独立密码（x-admin-password）的客户端暂存，admin/page.tsx 与
 * components/admin/reading-experiment.tsx 共用同一份，改纪律只改这里。
 *
 * 只存模块级内存变量，不落 sessionStorage：sessionStorage 在整个标签页生命周期内
 * 对任意同源脚本可读，明文主密码一旦被 XSS / 供应链投毒读走即可在任意设备永久重放——
 * ADMIN_PASSWORD 是长期不变的全量数据访问凭证，不像管理员会话 cookie 还有
 * verifySession 吊销机制兜底。改存内存后，刷新/新开标签需要重输一次密码，
 * 这是有意付出的成本，换「凭证不落任何可被脚本枚举的存储」。 */

let memPw: string | null = null;

export function pwHeaders(): Record<string, string> {
  return memPw ? { "x-admin-password": memPw } : {};
}

export function rememberPw(pw: string) {
  memPw = pw;
}

export function forgetPw() {
  memPw = null;
}
