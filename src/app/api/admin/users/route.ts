import { NextRequest } from "next/server";
import { dbGet, dbList, dbDelete, emailHash } from "@/lib/server/db";
import { getSessionUser } from "@/lib/server/auth";
import { isAdminEmail } from "@/lib/admin-emails";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 不再要管理密码：登上白名单账号就直接能用，鉴权与 /api/admin/overview 一致 */
async function requireAdmin(): Promise<{ error: string; status: number } | null> {
  const session = await getSessionUser();
  if (!session) return { error: "未登录", status: 401 };
  if (!isAdminEmail(session.email, process.env.ADMIN_EMAILS)) {
    return { error: "此账号没有管理权限", status: 403 };
  }
  return null;
}

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  createdAt: string;
}

/** 删除用户：连同其云端数据一并移除 */
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return Response.json({ error: "缺少 email" }, { status: 400 });

  const rec = await dbGet<{ userId: string }>(`users/${emailHash(email)}.json`, { encrypted: true });
  if (!rec) return Response.json({ error: "用户不存在" }, { status: 404 });

  await dbDelete(`users/${emailHash(email)}.json`, rec._sha ?? null);
  try {
    const dataFile = await dbGet(`data/${rec.userId}.json`, { encrypted: true });
    if (dataFile) await dbDelete(`data/${rec.userId}.json`, dataFile._sha ?? null);
  } catch { /* 数据文件删除失败不阻断 */ }
  return Response.json({ ok: true });
}

export async function POST() {
  const denied = await requireAdmin();
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const userFiles = await dbList("users");
  const users: Record<string, { userId: string; email: string; name: string; createdAt: string }> = {};
  for (const f of userFiles) {
    try {
      const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
      if (rec) users[rec.userId] = { userId: rec.userId, email: rec.email, name: rec.name, createdAt: rec.createdAt };
    } catch { /* 单个解密失败跳过 */ }
  }

  const dataFiles = await dbList("data");
  const rows: {
    email: string; name: string; createdAt: string; updatedAt: string;
    goals: { topic?: string; direction?: string }[]; knowledgeCount: number; booksCount: number; sessionsCount: number;
  }[] = [];
  for (const f of dataFiles) {
    try {
      const blob = await dbGet<{
        data: { goals?: { topic?: string; direction?: string }[]; knowledge?: unknown[]; books?: unknown[]; sessions?: unknown[] };
        updatedAt: string;
      }>(`data/${f.name}`, { encrypted: true });
      if (!blob) continue;
      const { _sha, ...rest } = blob;
      const d = (rest.data ?? {}) as { goals?: { topic?: string; direction?: string }[]; knowledge?: unknown[]; books?: unknown[]; sessions?: unknown[] };
      const u = users[f.name.replace(".json", "")] ?? { userId: f.name, email: "?", name: "?", createdAt: "?" };
      rows.push({
        email: u.email,
        name: u.name,
        createdAt: u.createdAt,
        updatedAt: rest.updatedAt ?? "?",
        goals: (d.goals ?? []).map((g) => ({ topic: g.topic, direction: g.direction })),
        knowledgeCount: (d.knowledge ?? []).length,
        booksCount: (d.books ?? []).length,
        sessionsCount: (d.sessions ?? []).length,
      });
    } catch { /* skip */ }
  }
  for (const u of Object.values(users)) {
    if (!rows.some((r) => r.email === u.email)) {
      rows.push({ email: u.email, name: u.name, createdAt: u.createdAt, updatedAt: "从未同步", goals: [], knowledgeCount: 0, booksCount: 0, sessionsCount: 0 });
    }
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return Response.json({ rows, total: rows.length });
}
