import { NextRequest } from "next/server";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { listBatches, createBatch, revokeLicense } from "@/lib/server/license";
import type { PlanId } from "@/lib/pricing";
import { PLANS } from "@/lib/pricing";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 卡密管理（外部后台走 x-admin-password 头，与 overview 同一套鉴权） */

async function guard(req: NextRequest): Promise<{ error: string; status: number } | null> {
  if (!(await rateLimitPersistent(`admin:licenses:${clientIp(req)}`, { capacity: 20, refillPerSec: 20 / 60 }))) {
    return { error: "请求过于频繁", status: 429 };
  }
  if (!(await authorizeAdmin(req))) return { error: "未授权", status: 401 };
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });
  const batches = await listBatches();
  return Response.json({ batches });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const count = Number(body.count ?? 1);
  const plan = String(body.plan ?? "month") as PlanId;
  if (!(plan in PLANS)) return Response.json({ error: "套餐不存在" }, { status: 400 });
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    return Response.json({ error: "一次生成 1-500 张" }, { status: 400 });
  }
  // null/undefined/空串都算"用套餐默认"——前端留空时发的是 null，此前只认 undefined
  // 导致后台留空必报"天数需在 1-3650 之间"，只能手动填数（2026-11-06 用户实测抓到）。
  const rawDays = body.days ?? undefined;
  const days = rawDays === undefined || rawDays === "" ? undefined : Number(rawDays);
  if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 3650)) {
    return Response.json({ error: "天数需在 1-3650 之间" }, { status: 400 });
  }
  const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)).toISOString() : null;
  if (body.expiresAt && Number.isNaN(Date.parse(expiresAt ?? ""))) {
    return Response.json({ error: "卡密有效期格式不对" }, { status: 400 });
  }

  const { batch, codes } = await createBatch({
    count,
    plan,
    days,
    note: String(body.note ?? ""),
    createdBy: "admin",
    expiresAt,
  });
  return Response.json({ ok: true, batch, codes });
}

export async function PATCH(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });
  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? "").trim();
  if (!code) return Response.json({ error: "缺少激活码" }, { status: 400 });
  const rec = await revokeLicense(code);
  if (!rec) return Response.json({ error: "找不到这张激活码" }, { status: 404 });
  return Response.json({ ok: true, license: rec });
}
