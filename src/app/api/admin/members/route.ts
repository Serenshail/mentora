import { NextRequest } from "next/server";
import { dbGet, dbList, emailHash } from "@/lib/server/db";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { computeEntitlement, extendMembership, setExpiry, type UserPlanRecord } from "@/lib/server/entitlement";
import { issueResetCode } from "@/lib/server/reset-code";
import type { PlanId } from "@/lib/pricing";
import { PLANS } from "@/lib/pricing";

export const runtime = "nodejs";
export const maxDuration = 60;

interface UserRecord extends UserPlanRecord {
  userId: string;
  email: string;
  name: string;
  createdAt: string;
  avatar?: string;
  planHistory?: { licenseId: string; days: number; at: string }[];
  refCode?: string;
  invitedBy?: string;
  referrals?: { email: string; at: string; rewarded: boolean; ip?: string }[];
}

async function guard(req: NextRequest): Promise<{ error: string; status: number } | null> {
  if (!(await rateLimitPersistent(`admin:members:${clientIp(req)}`, { capacity: 20, refillPerSec: 20 / 60 }))) {
    return { error: "请求过于频繁", status: 429 };
  }
  if (!(await authorizeAdmin(req))) return { error: "未授权", status: 401 };
  return null;
}

export interface MemberRow {
  email: string;
  name: string;
  userId: string;
  createdAt: string;
  plan: string | null;
  planExpiresAt: string | null;
  status: string;
  daysLeft: number | null;
  history: { licenseId: string; days: number; at: string }[];
  /** 拉新：自己的邀请码 / 已结算的邀请人数（人工反查刷单用） */
  refCode: string | null;
  referred: number;
  /** 谁邀请来的：解析成邀请人邮箱；解析不到就给原始码 */
  invitedByEmail: string | null;
  invitedByCode: string | null;
}

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const files = await dbList("users");
  const members: MemberRow[] = [];
  // 邀请码 → 邮箱 的索引：把"这个人是谁邀请的"解析成看得懂的邮箱
  const refOwner = new Map<string, string>();
  for (const f of files) {
    try {
      const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
      if (!rec) continue;
      if (rec.refCode) refOwner.set(rec.refCode.toUpperCase(), rec.email);
      const ent = computeEntitlement(rec);
      members.push({
        email: rec.email,
        name: rec.name,
        userId: rec.userId,
        createdAt: rec.createdAt,
        plan: ent.plan,
        planExpiresAt: ent.expiresAt,
        status: ent.status,
        daysLeft: ent.daysLeft,
        history: rec.planHistory ?? [],
        refCode: rec.refCode ?? null,
        referred: (rec.referrals ?? []).filter((r) => r.rewarded).length,
        invitedByEmail: null,
        invitedByCode: rec.invitedBy ?? null,
      });
    } catch { /* 单个解密失败跳过 */ }
  }
  for (const m of members) {
    if (m.invitedByCode) m.invitedByEmail = refOwner.get(m.invitedByCode.toUpperCase()) ?? null;
  }
  members.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const summary = {
    total: members.length,
    active: members.filter((m) => m.status === "active" || m.status === "legacy").length,
    expiring: members.filter((m) => m.status === "expiring").length,
    expired: members.filter((m) => m.status === "expired").length,
    legacy: members.filter((m) => m.status === "legacy").length,
  };
  return Response.json({ members, summary });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return Response.json({ error: "缺少 email" }, { status: 400 });

  const plan = body.plan && String(body.plan) in PLANS ? (String(body.plan) as PlanId) : undefined;

  if (action === "extend") {
    const days = Number(body.days ?? 30);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return Response.json({ error: "天数需在 1-3650 之间" }, { status: 400 });
    }
    const entitlement = await extendMembership(email, Math.floor(days), plan);
    return Response.json({ ok: true, entitlement });
  }

  if (action === "setExpiry") {
    const raw = body.expiresAt;
    let expiresAt: string | null = null;
    if (raw) {
      const t = new Date(String(raw));
      if (Number.isNaN(t.getTime())) return Response.json({ error: "日期格式不对" }, { status: 400 });
      expiresAt = t.toISOString();
    }
    const entitlement = await setExpiry(email, expiresAt, plan);
    return Response.json({ ok: true, entitlement });
  }

  if (action === "revoke") {
    const entitlement = await setExpiry(email, new Date(Date.now() - 60_000).toISOString(), plan);
    return Response.json({ ok: true, entitlement });
  }

  if (action === "issueResetCode") {
    const rec = await dbGet<{ email: string }>(`users/${emailHash(email)}.json`, { encrypted: true });
    if (!rec) return Response.json({ error: "账号不存在" }, { status: 404 });
    const { code, expiresAt } = await issueResetCode(email);
    return Response.json({ ok: true, code, expiresAt });
  }

  return Response.json({ error: "未知操作" }, { status: 400 });
}
