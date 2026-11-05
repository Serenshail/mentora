import { NextRequest } from "next/server";
import { dbGet, dbPut, dbList, emailHash } from "@/lib/server/db";
import { sendEmail } from "@/lib/server/mail";
import { computeEntitlement, type UserPlanRecord } from "@/lib/server/entitlement";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 到期提醒：提前 7/3/1 天和到期当天各发一封。
 * 付费工具最常见的流失不是"不想续"，而是"忘了"。邮件是最便宜的挽回手段。
 * 鉴权与 weekly-digest 一致：Vercel Cron 带 Authorization: Bearer $CRON_SECRET，未配置一律拒绝。 */

interface UserRecord extends UserPlanRecord {
  userId: string;
  email: string;
  name: string;
}

const REMIND_DAYS = new Set([7, 3, 1, 0]);
const today = () => new Date().toISOString().slice(0, 10);

function html(name: string, daysLeft: number, site: string): string {
  const expired = daysLeft <= 0;
  return `
<div style="background:#ffffff;color:#18181b;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
  <h1 style="font-size:18px;margin:0 0 12px;">${expired ? "你的 Mentora 会员今天到期" : `你的 Mentora 会员还有 ${daysLeft} 天`}</h1>
  <p style="font-size:14px;line-height:1.7;color:#3f3f46;margin:0 0 16px;">
    ${
      expired
        ? "AI 生成已暂停，但账号、学习计划、笔记和导出都还在。续费后立刻恢复，一天都不会丢。"
        : "到期后 AI 生成会暂停；笔记和数据不会删除，随时可以导出带走。"
    }
  </p>
  ${site ? `<a href="${site}/membership" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;padding:10px 20px;border-radius:10px;">${expired ? "去续费" : "查看会员"}</a>` : ""}
  <p style="font-size:12px;color:#a1a1aa;margin:24px 0 0;">这封邮件只发给有到期时间的账号，不需要可以忽略。</p>
</div>`;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers.get("authorization") || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const site = (process.env.APP_URL || "").replace(/\/$/, "");
  const files = await dbList("users");
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of files) {
    try {
      const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
      if (!rec?.email) continue;
      const ent = computeEntitlement(rec);
      if (ent.daysLeft === null || !REMIND_DAYS.has(ent.daysLeft)) continue;

      const marker = `reminder/${emailHash(rec.email)}/${today()}.json`;
      const already = await dbGet(marker, { encrypted: false }).catch(() => "skip");
      if (already) {
        skipped += 1;
        continue;
      }
      const r = await sendEmail(
        rec.email,
        ent.daysLeft <= 0
          ? "Mentora 会员今天到期（数据都还在）"
          : `Mentora 会员还有 ${ent.daysLeft} 天到期`,
        html(rec.name || rec.email.split("@")[0], ent.daysLeft, site)
      );
      // 发信通道未配置时也写标记：避免每次 cron 都重试同一批（dev 环境日志已提示）
      await dbPut(marker, { at: new Date().toISOString(), sent: r.sent }, { encrypted: false }).catch(() => {});
      if (r.sent) sent += 1;
      else skipped += 1;
    } catch (e) {
      failed += 1;
      logEvent({ route: "cron-expiry", error: e instanceof Error ? e.message : String(e) });
    }
  }

  return Response.json({ ok: true, total: files.length, sent, skipped, failed });
}
