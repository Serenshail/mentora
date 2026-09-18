/* 管理员邮箱白名单：客户端（侧栏/底栏入口）与服务端（接口鉴权）共用这一份，
   否则会出现"看得见入口、进不去后台"的错位。
   内置名单永远有效；ADMIN_EMAILS / NEXT_PUBLIC_ADMIN_EMAILS 只能往里加人，
   不能把内置账号挤掉——环境变量配错也不会把自己锁在门外。 */

export const DEFAULT_ADMIN_EMAILS = "haow9508@gmail.com,laiyif68@gmail.com,text@qq.com";

export function parseAdminEmails(raw: string | undefined): string[] {
  const emails = new Set(
    DEFAULT_ADMIN_EMAILS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const s of (raw ?? "").split(",")) {
    const e = s.trim().toLowerCase();
    if (e) emails.add(e);
  }
  return [...emails];
}

export function isAdminEmail(email: string | undefined, raw?: string): boolean {
  if (!email) return false;
  return parseAdminEmails(raw).includes(email.trim().toLowerCase());
}
