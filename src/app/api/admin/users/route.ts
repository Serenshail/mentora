import { NextRequest } from "next/server";
import { dbGet, dbList, dbDelete, dbDeleteDir, emailHash } from "@/lib/server/db";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { dropRefCode } from "@/lib/server/referral";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 双鉴权:白名单会话 OR 后台密码头(外部后台管理系统走后者),与 overview 同源 */
async function requireAdmin(req: NextRequest): Promise<{ error: string; status: number } | null> {
  /* 这两条路由此前没有专项限流，只靠 proxy 的进程内桶——多实例/自托管下等于没有，
   * 后台密码可被无限轮询爆破（DELETE 成功后是数据不可逆丢失）。对齐 overview/stats。 */
  if (!(await rateLimitPersistent(`admin:users:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 }))) {
    return { error: "请求过于频繁", status: 429 };
  }
  const admin = await authorizeAdmin(req);
  if (!admin) return { error: "未授权", status: 401 };
  return null;
}

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  createdAt: string;
}

/** 删除用户：连同其云端数据与历史快照一并移除 */
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return Response.json({ error: "缺少 email" }, { status: 400 });

  const rec = await dbGet<{ userId: string }>(`users/${emailHash(email)}.json`, { encrypted: true });
  if (!rec) return Response.json({ error: "用户不存在" }, { status: 404 });

  /* 主档案删除此前未包 try/catch：存储通道故障抛裸 500（无 JSON 错误体），
   * 与同函数次级删除及 account 路由的包裹口径不一致 */
  try {
    await dbDelete(`users/${emailHash(email)}.json`, rec._sha ?? null);
  } catch {
    return Response.json({ error: "删除失败，稍后再试" }, { status: 502 });
  }
  // 邀请码索引指向已删账号会变成死码，一并清掉
  await dropRefCode(email);
  try {
    const dataFile = await dbGet(`data/${rec.userId}.json`, { encrypted: true });
    if (dataFile) await dbDelete(`data/${rec.userId}.json`, dataFile._sha ?? null);
  } catch { /* 数据文件删除失败不阻断 */ }
  /* 与自助注销同口径：versions/<userId>/ 的历史快照同样是用户数据，删号就要删干净 */
  try {
    await dbDeleteDir(`versions/${rec.userId}`);
  } catch { /* 列目录失败不阻断 */ }
  return Response.json({ ok: true });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const userFiles = await dbList("users");
  const users: Record<string, { userId: string; email: string; name: string; createdAt: string }> = {};
  /* 读取/解密失败此前静默跳过：损坏用户从列表整体消失，管理端分不清
   * 「加载失败」和「不存在/从未同步」。计数要回给 UI。 */
  let skipped = 0;
  /* 两个循环都是串行 await 远端加密读：100 用户量级就会顶到 maxDuration。
   * 分块并发（块内并行、块间串行）把后台列表从"打不开"拉回秒级。 */
  const CHUNK = 8;
  for (let i = 0; i < userFiles.length; i += CHUNK) {
    const part = await Promise.all(
      userFiles.slice(i, i + CHUNK).map(async (f) => {
        try {
          const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
          return rec
            ? { rec: { userId: rec.userId, email: rec.email, name: rec.name, createdAt: rec.createdAt }, failed: false }
            : null;
        } catch {
          return { rec: null, failed: true };
        }
      })
    );
    for (const p of part) {
      if (p?.failed) skipped++;
      if (p?.rec) users[p.rec.userId] = p.rec;
    }
  }

  const dataFiles = await dbList("data");
  const rows: {
    email: string; name: string; createdAt: string; updatedAt: string;
    goals: { topic?: string; direction?: string }[]; knowledgeCount: number; booksCount: number; sessionsCount: number;
  }[] = [];
  for (let i = 0; i < dataFiles.length; i += CHUNK) {
    const part = await Promise.all(
      dataFiles.slice(i, i + CHUNK).map(async (f) => {
        try {
          const blob = await dbGet<{
            data: { goals?: { topic?: string; direction?: string }[]; knowledge?: unknown[]; books?: unknown[]; sessions?: unknown[] };
            updatedAt: string;
          }>(`data/${f.name}`, { encrypted: true });
          if (!blob) return null;
          const { _sha, ...rest } = blob;
          const d = (rest.data ?? {}) as { goals?: { topic?: string; direction?: string }[]; knowledge?: unknown[]; books?: unknown[]; sessions?: unknown[] };
          const u = users[f.name.replace(".json", "")] ?? { userId: f.name, email: "?", name: "?", createdAt: "?" };
          return {
            email: u.email,
            name: u.name,
            createdAt: u.createdAt,
            updatedAt: rest.updatedAt ?? "?",
            goals: (d.goals ?? []).map((g) => ({ topic: g.topic, direction: g.direction })),
            knowledgeCount: (d.knowledge ?? []).length,
            booksCount: (d.books ?? []).length,
            sessionsCount: (d.sessions ?? []).length,
          };
        } catch {
          return { failed: true as const };
        }
      })
    );
    for (const p of part) {
      if (!p) continue;
      if ("failed" in p) skipped++;
      else rows.push(p);
    }
  }
  for (const u of Object.values(users)) {
    if (!rows.some((r) => r.email === u.email)) {
      rows.push({ email: u.email, name: u.name, createdAt: u.createdAt, updatedAt: "从未同步", goals: [], knowledgeCount: 0, booksCount: 0, sessionsCount: 0 });
    }
  }
  rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return Response.json({ rows, total: rows.length, skipped });
}
