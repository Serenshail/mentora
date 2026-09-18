import { getSessionUser } from "@/lib/server/auth";
import { isAdminEmail, parseAdminEmails } from "@/lib/admin-emails";

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
    adminEmails: parseAdminEmails(process.env.ADMIN_EMAILS),
    timestamp: new Date().toISOString(),
  });
}
