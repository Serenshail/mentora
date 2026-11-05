import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { dbPut } from "@/lib/server/db";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";

/* 体验申请（公开）：首页「申请 7 天体验」留资。
 * 不做自动发码——冷启动阶段每一个申请都值得你看一眼、聊两句，
 * 也顺手挡掉批量薅羊毛。后台「卡密管理」里一键发码。 */

export interface LeadRecord {
  id: string;
  email: string;
  contact: string;
  note: string;
  createdAt: string;
  status: "new" | "invited" | "ignored";
  licenseCode?: string;
}

export async function POST(req: NextRequest) {
  if (!(await rateLimitPersistent(`trial:${clientIp(req)}`, { capacity: 3, refillPerSec: 3 / 60 }))) {
    return Response.json({ error: "提交太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 120);
  const contact = String(body.contact ?? "").trim().slice(0, 80);
  const note = String(body.note ?? "").trim().slice(0, 300);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "邮箱格式不对" }, { status: 400 });
  }

  const now = new Date();
  const id = `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
  const rec: LeadRecord = {
    id,
    email,
    contact,
    note,
    createdAt: now.toISOString(),
    status: "new",
  };
  try {
    await dbPut(`leads/${id}.json`, rec, { encrypted: true });
  } catch {
    return Response.json({ error: "提交失败，稍后再试" }, { status: 503 });
  }
  logEvent({ ev: "lead", msg: "trial-request" });
  return Response.json({ ok: true });
}
