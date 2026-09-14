import { NextRequest } from "next/server";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { getSessionUser, setSessionCookie } from "@/lib/server/auth";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  avatar?: string;
  _sha?: string;
}

function publicUser(r: UserRecord) {
  return {
    userId: r.userId,
    email: r.email,
    name: r.name,
    ...(r.avatar ? { avatar: r.avatar } : {}),
  };
}

const EMAIL_HASH_PATH = (email: string) => `users/${emailHash(email)}.json`;

export async function GET() {
  const session = await getSessionUser();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(EMAIL_HASH_PATH(session.email), { encrypted: true });
  } catch {
    return Response.json({ error: "暂时读不到账户数据，稍后再试" }, { status: 503 });
  }
  if (!record) return Response.json({ error: "账户不存在" }, { status: 404 });
  return Response.json({ user: publicUser(record) });
}

export async function PATCH(req: NextRequest) {
  const session = await getSessionUser();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  const body = await req.json().catch(() => ({}));

  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(EMAIL_HASH_PATH(session.email), { encrypted: true });
  } catch {
    return Response.json({ error: "暂时读不到账户数据，稍后再试" }, { status: 503 });
  }
  if (!record) return Response.json({ error: "账户不存在" }, { status: 404 });

  const { _sha, ...clean } = record;
  const next: UserRecord = { ...clean };

  // 改名（同步重签会话，立即生效）
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 1 || name.length > 24) {
      return Response.json({ error: "称呼请控制在 1–24 个字" }, { status: 400 });
    }
    next.name = name;
  }

  // 换头像 / 移除头像（dataURL，上限约 300KB）
  if (body.avatar === null || body.avatar === "") {
    delete next.avatar;
  } else if (body.avatar !== undefined) {
    const avatar = String(body.avatar);
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(avatar)) {
      return Response.json({ error: "头像格式仅支持 PNG / JPG / WebP" }, { status: 400 });
    }
    if (avatar.length > 400_000) {
      return Response.json({ error: "头像图片太大，请换一张小一点的" }, { status: 400 });
    }
    next.avatar = avatar;
  }

  try {
    await dbPut(EMAIL_HASH_PATH(session.email), next, {
      encrypted: true,
      sha: _sha ?? null,
      overwriteOnConflict: true,
    });
  } catch {
    return Response.json({ error: "保存失败，稍后再试" }, { status: 503 });
  }

  const user = publicUser(next);
  // 名字写进了会话 cookie：重签后所有页面立即显示新称呼
  await setSessionCookie({ userId: user.userId, email: user.email, name: user.name });
  return Response.json({ user });
}
