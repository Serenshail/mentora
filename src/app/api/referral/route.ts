import { verifySession } from "@/lib/server/auth";
import { referralSummary } from "@/lib/server/referral";
import { REFERRAL } from "@/lib/pricing";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";

/** 我的邀请码与拉新战绩（会员页用）。没有邀请码的老用户在这里懒生成。 */
export async function GET() {
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  try {
    const summary = await referralSummary(session.email, session.userId);
    return Response.json({ ...summary, rewardDays: REFERRAL.rewardDays });
  } catch (e) {
    /* catch{} 吞掉全部异常且零日志（连 admin/stats 连 401 拒绝都写了 logEvent）会让线上
     * KV 抖动时该端点故障完全无迹可查。referralSummary 有三种可区分失败，至少留痕分级：
     *  -「账号不存在」：verifySession 降级放行后档案被并发删除的竞态 → 401（重新登录），
     *    误报成「暂时性错误」会误导排障方向；
     *  -「邀请码生成失败」（连续 5 次码碰撞）/ KV 故障 → 503 照旧。 */
    const msg = e instanceof Error ? e.message : String(e);
    logEvent({ route: "referral", ev: "summary-fail", userId: session.userId, msg });
    if (msg.includes("账号不存在")) {
      return Response.json({ error: "登录状态已失效，请重新登录" }, { status: 401 });
    }
    return Response.json({ error: "邀请码暂时取不到，稍后再试" }, { status: 503 });
  }
}
