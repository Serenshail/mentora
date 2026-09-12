import { NextRequest } from "next/server";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { hashPassword, setSessionCookie } from "@/lib/server/auth";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim() || email.split("@")[0];

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }
  if (password.length < 6) {
    return Response.json({ error: "密码至少 6 位" }, { status: 400 });
  }

  const path = `users/${emailHash(email)}.json`;
  let existing = null;
  try {
    existing = await dbGet<UserRecord>(path, { encrypted: true });
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (existing) {
    return Response.json({ error: "这个邮箱已经注册过了，直接登录" }, { status: 409 });
  }

  const { salt, hash } = hashPassword(password);
  const record: UserRecord = {
    userId: crypto.randomUUID(),
    email,
    name,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  };
  try {
    await dbPut(path, record, { encrypted: true });
  } catch {
    return Response.json({ error: "注册写入失败，稍后再试" }, { status: 503 });
  }

  const user = { userId: record.userId, email, name };
  await setSessionCookie(user);
  return Response.json({ user });
}
