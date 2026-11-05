import { verifySession } from "@/lib/server/auth";
import { isAdminEmail, parseAdminEmails } from "@/lib/admin-emails";

export const runtime = "nodejs";

export async function GET() {
  const session = await verifySession();
  // 调试端点曾未登录就返回管理员白名单=给攻击者递刀子；现整端点仅管理员会话可见。
  const isAdmin = session ? isAdminEmail(session.email, process.env.ADMIN_EMAILS) : false;
  if (!session || !isAdmin) {
    return Response.json({ error: "未登录或非管理员" }, { status: 401 });
  }

  // 守卫后 session 必非空，直接写非空形式（此前的三元 else 分支不可达）
  return Response.json({
    session: {
      userId: session.userId,
      email: session.email,
      name: session.name,
    },
    isAdmin,
    adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
    timestamp: new Date().toISOString(),
  });
}
