import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { dbPut } from "@/lib/server/db";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";
import { readJsonBody } from "@/lib/server/body-limit";

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
  /* 体积闸（与 auth 全系、feedback/reminders/linkcheck 同一纪律）：本端点未登录即可调，
   * 旧的 req.json() 先把整个请求体缓冲并解析后才截断 email/contact/note——自托管
   * （Caddy 默认不限 body）下限流额度内的 GB 级 JSON 足以 OOM 杀掉单进程 Node
   * （body-limit.ts 头注释的威胁模型）。512KB 声明闸 + 流式终闸，超标回 413；
   * 解析失败/空体回 {}，与旧 json().catch(() => ({})) 行为逐字对齐。 */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "提交内容太大，请精简后重试" }, { status: 413 });
  }
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
