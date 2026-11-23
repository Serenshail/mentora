import { NextRequest } from "next/server";
import { dbEventStats, eventStatsChannelReady } from "@/lib/server/db";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";

/* 管理统计（替代 Vercel Analytics 的自有漏斗出口）：
   events 漏斗（intake_start→intake_complete→plan_generated→day_pass→review_done）
   + chat-usage 用量概要（按 provider 聚合 calls/tokens/byok，最近 500 条窗口）。
   仅管理员（白名单会话 / 后台密码 x-admin-password）；响应只含聚合计数，绝无 account/PII。 */
export async function GET(req: NextRequest) {
  if (!(await rateLimitPersistent(`admin:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 }))) {
    return Response.json({ error: "操作太频繁，请稍后再试" }, { status: 429 });
  }
  const you = await authorizeAdmin(req);
  if (!you) {
    logEvent({ ev: "admin", msg: "stats-denied", ip: clientIp(req) });
    return Response.json({ error: "未登录" }, { status: 401 });
  }
  logEvent({ ev: "admin", msg: "stats", by: you.email });

  const stats = await dbEventStats();
  if (!stats) {
    /* dbEventStats 的 null 有两种来源（db.ts）：通道未配置（!hasRds/!hasD1）与
     * 远端库故障（catch，已留 event-stats-failed 日志）。混成一句「未配置」会把
     * 管理员引去检查 env，实际可能是远端库抖动——按 eventStatsChannelReady 分流，
     * 故障分支同时落 logEvent，与上方成功/401 路径同口径留痕。 */
    if (!eventStatsChannelReady()) {
      return Response.json({ error: "事件库不可用（未配置任何事件存储通道）" }, { status: 503 });
    }
    logEvent({ ev: "admin", msg: "stats-events-fault", by: you.email });
    return Response.json({ error: "事件库暂时不可用（事件存储通道故障），稍后再试" }, { status: 503 });
  }
  return Response.json(stats, { headers: { "Cache-Control": "no-store" } });
}