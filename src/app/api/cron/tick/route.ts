import { NextRequest } from "next/server";
import { dbList, dbGet, dbPut } from "@/lib/server/db";
import { sendEmail, hasSmtp } from "@/lib/server/mail";
import { logEvent } from "@/lib/server/config";
import { isDue, listReminders, type Reminder } from "@/lib/server/personal";

export const runtime = "nodejs";
export const maxDuration = 60;

/* ============================================================
 * 定时提醒派发（v24.0 二期）
 *
 * 触发源：腾讯云 systemd timer 每分钟（主力）/ Vercel Cron 每日（兜底）。
 * 幂等：每条提醒写 lastRunKey（"YYYY-MM-DD HH:mm"），同一时刻只发一次；
 *       只补发"当天已到点但未发"的，跨天错过的不追（防重启后轰炸）。
 * 单次最多处理 N 条，避免一次跑太久被平台掐断。
 * ============================================================ */

const MAX_SEND_PER_RUN = 20;

interface UserRecord {
  userId: string;
  email: string;
  name?: string;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers.get("authorization") || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  if (!hasSmtp() && !dryRun) {
    return Response.json({ ok: false, error: "未配置发信服务", sent: 0 });
  }

  let sent = 0;
  let scanned = 0;
  let failed = 0;
  const users = await dbList("users").catch(() => []);
  for (const f of users) {
    if (sent >= MAX_SEND_PER_RUN) break;
    try {
      const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
      if (!rec?.userId || !rec.email) continue;
      const reminders = await listReminders(rec.userId).catch(() => [] as Reminder[]);
      if (reminders.length === 0) continue;
      scanned += reminders.length;
      for (const r of reminders) {
        if (sent >= MAX_SEND_PER_RUN) break;
        const { due, key } = isDue(r);
        if (!due) continue;
        if (dryRun) {
          sent += 1;
          continue;
        }
        const site = (process.env.APP_URL || "").replace(/\/$/, "");
        await sendEmail(
          rec.email,
          `Mentora 提醒：${r.title}`,
          `<div style="font-family:system-ui,sans-serif;line-height:1.7">
             <p style="font-size:15px"><b>${r.title}</b></p>
             <p>${r.prompt.replace(/\n/g, "<br/>")}</p>
             ${site ? `<p style="color:#888;font-size:12px"><a href="${site}">打开 Mentora</a></p>` : ""}
           </div>`
        );
        await dbPut(
          `automations/${rec.userId}/${r.id}.json`,
          { ...r, lastRunKey: key, lastRunAt: new Date().toISOString() },
          { encrypted: true }
        );
        sent += 1;
        logEvent({ route: "cron-tick", reminder: r.id, title: r.title.slice(0, 40) });
      }
    } catch {
      failed += 1; // 单用户失败不中断
    }
  }
  return Response.json({ ok: true, sent, scanned, failed, dryRun });
}
