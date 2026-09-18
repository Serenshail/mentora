import { getSessionUser } from "@/lib/server/auth";
import { isAdminEmail } from "@/lib/admin-emails";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSessionUser();

  return Response.json({
    session: session
      ? {
          userId: session.userId,
          email: session.email,
          name: session.name,
        }
      : null,
    isAdmin: session ? isAdminEmail(session.email, process.env.ADMIN_EMAILS) : false,
    adminEmails: (process.env.ADMIN_EMAILS || "haow9508@gmail.com,laiyif68@gmail.com,text@qq.com")
      .split(",")
      .map((s) => s.trim().toLowerCase()),
    timestamp: new Date().toISOString(),
  });
}
