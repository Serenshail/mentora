import { NextRequest } from "next/server";
import { dbPut } from "@/lib/server/db";
import { sendEmail, hasSmtp } from "@/lib/server/mail";
import { logEvent } from "@/lib/server/config";
import { isDue, listAutomationOwners, listReminders, type Reminder } from "@/lib/server/personal";

export const runtime = "nodejs";
export const maxDuration = 60;

/* ============================================================
 * 定时提醒派发（v24.0 二期）
 *
 * 触发源：腾讯云 systemd timer 每分钟（主力）/ Vercel Cron 每日兜底。
 * 只扫 automations/_index.json 里的用户（全量遍历 users/ 实测 46s，会超 Vercel 60s 上限）。
 * 幂等：lastRunKey（"YYYY-MM-DD HH:mm"）——同一时刻只触发一次；跨天错过的不追发。
 * 投递与触发解耦：配了邮件就发信；没配也标记触发，应用内横幅（firedToday）兜底。
 * ============================================================ */

const MAX_SEND_PER_RUN = 20;
const BUDGET_MS = 20_000;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers.get("authorization") || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const mailReady = hasSmtp();
  const site = (process.env.APP_URL || "").replace(/\/$/, "");
  const deadline = Date.now() + BUDGET_MS;

  let sent = 0;
  let scanned = 0;
  let failed = 0;
  const byChannel = { email: 0, inapp: 0 };

  const owners = await listAutomationOwners().catch(() => []);
  for (const owner of owners) {
    if (sent >= MAX_SEND_PER_RUN || Date.now() > deadline) break;
    try {
      const reminders = await listReminders(owner.userId).catch(() => [] as Reminder[]);
      if (reminders.length === 0) continue;
      scanned += reminders.length;
      for (const r of reminders) {
        if (sent >= MAX_SEND_PER_RUN || Date.now() > deadline) break;
        const { due, key } = isDue(r);
        if (!due) continue;
        if (dryRun) {
          sent += 1;
          continue;
        }
        let via: "email" | "inapp" = "inapp";
        if (mailReady) {
          await sendEmail(
            owner.email,
            `Mentora 提醒：${r.title}`,
            `<div style="font-family:system-ui,sans-serif;line-height:1.7">
               <p style="font-size:15px"><b>${r.title}</b></p>
               <p>${r.prompt.replace(/\n/g, "<br/>")}</p>
               ${site ? `<p style="color:#888;font-size:12px"><a href="${site}">打开 Mentora</a></p>` : ""}
             </div>`
          );
          via = "email";
        }
        await dbPut(
          `automations/${owner.userId}/${r.id}.json`,
          { ...r, lastRunKey: key, lastRunAt: new Date().toISOString(), lastDeliveredVia: via },
          { encrypted: true }
        );
        sent += 1;
        byChannel[via] += 1;
        logEvent({ route: "cron-tick", reminder: r.id, title: r.title.slice(0, 40), via });
      }
    } catch {
      failed += 1; // 单用户失败不中断
    }
  }
  return Response.json({
    ok: true,
    sent,
    scanned,
    failed,
    owners: owners.length,
    mailReady,
    byChannel,
    dryRun,
  });
}
