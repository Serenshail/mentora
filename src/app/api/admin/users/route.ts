import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { dbGet, dbList } from "@/lib/server/db";

export const runtime = "nodejs";
export const maxDuration = 60;

function checkPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  createdAt: string;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!checkPassword(String(body.password ?? ""))) {
    return Response.json({ error: "管理密码不对" }, { status: 401 });
  }

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
