import { verifySession } from "@/lib/server/auth";
import { isAdminEmail, parseAdminEmails } from "@/lib/admin-emails";

export const runtime = "nodejs";

export async function GET() {
  const session = await verifySession();
  // 调试端点曾未登录就返回管理员白名单=给攻击者递刀子；现整端点仅管理员会话可见。
  if (!session || !isAdminEmail(session.email, process.env.ADMIN_EMAILS)) {
    return Response.json({ error: "未登录或非管理员" }, { status: 401 });
  }

  return Response.json({
    session: session
      ? {
          userId: session.userId,
          email: session.email,
          name: session.name,
        }
      : null,
    isAdmin: session ? isAdminEmail(session.email, process.env.ADMIN_EMAILS) : false,
    adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
    timestamp: new Date().toISOString(),
  });
}
