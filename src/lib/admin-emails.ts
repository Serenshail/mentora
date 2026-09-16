/* 管理员邮箱白名单：客户端（侧栏入口）与服务端（接口鉴权）必须同一份默认值，
   否则会出现"看得见入口、进不去后台"的错位。
   线上用 ADMIN_EMAILS 覆盖；NEXT_PUBLIC_ADMIN_EMAILS 只决定侧栏是否显示入口。 */

export const DEFAULT_ADMIN_EMAILS = "haow9508@gmail.com,text@qq.com";

export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw && raw.trim() ? raw : DEFAULT_ADMIN_EMAILS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | undefined, raw?: string): boolean {
  if (!email) return false;
  return parseAdminEmails(raw).includes(email.trim().toLowerCase());
}
