import { NextRequest } from "next/server";
import { dbGet, emailHash } from "@/lib/server/db";
import { verifyPassword, setSessionCookie } from "@/lib/server/auth";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  avatar?: string;
}

export async function POST(req: NextRequest) {
  // 防暴力破解：每 IP 突发 10 次、每分钟回填 10 次
  if (!rateLimit(`login:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 })) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(`users/${emailHash(email)}.json`, { encrypted: true });
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!record || !verifyPassword(password, record.salt, record.hash)) {
    return Response.json({ error: "邮箱或密码不对" }, { status: 401 });
  }

  const user = {
    userId: record.userId,
    email: record.email,
    name: record.name,
    ...(record.avatar ? { avatar: record.avatar } : {}),
  };
  // 头像（base64 data-URL，可达数百 KB）绝不能进会话 cookie：cookie 的 name+value 超过 4096 字节
  // 会被浏览器直接丢弃，造成"登录成功但浏览器没有会话"——内页全被当未登录弹走、/api/sync 全 401。
  // 头像只通过响应体交给前端展示。
  await setSessionCookie({ userId: user.userId, email: user.email, name: user.name });
  return Response.json({ user });
}
