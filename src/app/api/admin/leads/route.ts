import { NextRequest } from "next/server";
import { dbGet, dbPut, dbList } from "@/lib/server/db";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { createBatch } from "@/lib/server/license";

export const runtime = "nodejs";
export const maxDuration = 60;

interface LeadRecord {
  id: string;
  email: string;
  contact: string;
  note: string;
  createdAt: string;
  status: "new" | "invited" | "ignored";
  licenseCode?: string;
}

async function guard(req: NextRequest): Promise<{ error: string; status: number } | null> {
  if (!(await rateLimitPersistent(`admin:leads:${clientIp(req)}`, { capacity: 20, refillPerSec: 20 / 60 }))) {
    return { error: "请求过于频繁", status: 429 };
  }
  if (!(await authorizeAdmin(req))) return { error: "未授权", status: 401 };
  return null;
}

const leadPath = (id: string) => `leads/${id}.json`;

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const files = await dbList("leads");
  const leads: LeadRecord[] = [];
  for (const f of files) {
    try {
      const rec = await dbGet<LeadRecord>(`leads/${f.name}`, { encrypted: true });
      if (rec) leads.push(rec);
    } catch { /* 单条跳过 */ }
  }
  leads.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return Response.json({ leads });
}

/** 一键发体验码：生成 1 张 trial 码并把这一条申请标成已邀请 */
export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) return Response.json({ error: "缺少申请 id" }, { status: 400 });

  const lead = await dbGet<LeadRecord>(leadPath(id), { encrypted: true });
  if (!lead) return Response.json({ error: "申请不存在" }, { status: 404 });

  const days = Number(body.days ?? 7);
  const { codes, batch } = await createBatch({
    count: 1,
    plan: "trial",
    days: Number.isFinite(days) && days >= 1 && days <= 365 ? Math.floor(days) : 7,
    note: `体验申请 ${lead.email}`.slice(0, 80),
    createdBy: "admin",
  });
  const next: LeadRecord = { ...lead, status: "invited", licenseCode: codes[0] };
  await dbPut(leadPath(id), next, { encrypted: true });
  return Response.json({ ok: true, lead: next, code: codes[0], batchId: batch.id });
}

export async function PATCH(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  const status = String(body.status ?? "");
  if (!id || !["new", "invited", "ignored"].includes(status)) {
    return Response.json({ error: "参数不对" }, { status: 400 });
  }
  const lead = await dbGet<LeadRecord>(leadPath(id), { encrypted: true });
  if (!lead) return Response.json({ error: "申请不存在" }, { status: 404 });
  const next = { ...lead, status: status as LeadRecord["status"] };
  await dbPut(leadPath(id), next, { encrypted: true });
  return Response.json({ ok: true, lead: next });
}
