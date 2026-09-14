import { NextRequest } from "next/server";
import { dbGet, emailHash } from "@/lib/server/db";
import { verifyPassword, setSessionCookie } from "@/lib/server/auth";

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
  await setSessionCookie(user);
  return Response.json({ user });
}
