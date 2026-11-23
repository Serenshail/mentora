import { NextRequest } from "next/server";
import { getProviderAttempts } from "@/lib/server/provider-attempts";

export const runtime = "nodejs";

/* 只读：本进程内实际发往 provider 的尝试次数（含上游重试）。
 * 仅开发环境开放——生产不暴露内部计数。权威记录是 events 表里的 chat-upstream 日志。 */
export async function GET(_req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "not available" }, { status: 404 });
  }
  return Response.json(getProviderAttempts());
}
