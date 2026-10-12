import { verifySession } from "@/lib/server/auth";
import { dbGet, emailHash } from "@/lib/server/db";

export const runtime = "nodejs";

export async function GET() {
  // verifySession：签名+过期+sv 版本三重校验；DB 故障降级为"仅校验签名"（不因故障踢人）
  const session = await verifySession();
  if (!session) return Response.json({ user: null });

  // 头像存在用户档案里（base64 data-URL），为守住 cookie 4096 上限不进会话；
  // 这里按需回读补头像。数据库不可用时降级为仅会话信息——绝不因此判定未登录。
  try {
    const record = await dbGet<{ avatar?: string }>(
      `users/${emailHash(session.email)}.json`,
      { encrypted: true }
    );
    if (record?.avatar) {
      return Response.json({ user: { ...session, avatar: record.avatar } });
    }
  } catch {
    /* 降级：仅返回会话信息 */
  }
  return Response.json({ user: session });
}
