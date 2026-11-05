/* 管理员邮箱白名单：客户端（侧栏/底栏入口）与服务端（接口鉴权）共用这一份，
   否则会出现"看得见入口、进不去后台"的错位。
   两个 env 各喂一侧、无同步机制：NEXT_PUBLIC_ADMIN_EMAILS 构建期内联喂客户端入口，
   ADMIN_EMAILS 运行时喂服务端鉴权（isAdminEmail 的 raw 参数）——只配其一会出现
   "进得去后台、看不见入口"或反之，加人时两边都要配。
   内置名单永远有效；ADMIN_EMAILS / NEXT_PUBLIC_ADMIN_EMAILS 只能往里加人，
   不能把内置账号挤掉——环境变量配错也不会把自己锁在门外。
   ⚠️ 内置名单只放真实持有、邮箱前缀不可被他人抢注的账号；泛化前缀（如 text@qq.com）
   一旦被他人注册即获得后台全权（看全量用户数据/删用户），一律走 env 添加，不进源码。 */

export const DEFAULT_ADMIN_EMAILS = "haow9508@gmail.com,laiyif68@gmail.com";

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
