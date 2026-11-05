import { verifySession } from "@/lib/server/auth";
import { referralSummary } from "@/lib/server/referral";
import { REFERRAL } from "@/lib/pricing";

export const runtime = "nodejs";

/** 我的邀请码与拉新战绩（会员页用）。没有邀请码的老用户在这里懒生成。 */
export async function GET() {
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const summary = await referralSummary(session.email, session.userId);
    return Response.json({ ...summary, rewardDays: REFERRAL.rewardDays });
  } catch {
    return Response.json({ error: "邀请码暂时取不到，稍后再试" }, { status: 503 });
  }
}
