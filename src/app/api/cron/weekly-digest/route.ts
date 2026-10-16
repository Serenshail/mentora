import { NextRequest } from "next/server";
import { dbList, dbGet } from "@/lib/server/db";
import { sendEmail, hasSmtp } from "@/lib/server/mail";
import { logEvent } from "@/lib/server/config";
import type { Goal, KnowledgeItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/* ============================================================
 * 每周复习召回邮件（Vercel Cron：周一 UTC 01:00 = 北京周一 09:00）
 *
 * 链路：users/{emailHash}.json（档案，拿 email/userId）
 *      → data/{userId}.json（加密数据快照，拿 settings.digestWeekly + 知识/计划）
 *      → 计算到期复习数 + 上周完成天数 → Resend 发信
 *
 * 纪律：
 * - 严格 opt-in：settings.digestWeekly 不为 true 一律不发（未经同意的邮件=垃圾邮件）
 * - 无事不打扰：到期 0 且上周 0 完成时不发
 * - 失败不中断：单用户失败只计数，继续下一个
 * ============================================================ */

interface UserRecord {
  userId: string;
  email: string;
  name?: string;
}

interface SnapshotData {
  settings?: { digestWeekly?: boolean };
  knowledge?: KnowledgeItem[];
  goals?: Goal[];
}

export async function GET(req: NextRequest) {
  // 鉴权：Vercel Cron 自动携带 Authorization: Bearer $CRON_SECRET。未配置 secret 一律拒绝（fail-closed）。
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers.get("authorization") || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (!hasSmtp()) {
    return Response.json({ ok: false, error: "未配置发信服务（RESEND_API_KEY）", sent: 0 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const site = (process.env.APP_URL || "").replace(/\/$/, "");

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  const users = await dbList("users").catch(() => []);
  for (const f of users) {
    try {
      const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
      if (!rec?.email || !rec.userId) {
        skipped += 1;
        continue;
      }
      const snap = await dbGet<{ data?: SnapshotData } & SnapshotData>(
        `data/${rec.userId}.json`,
        { encrypted: true }
      );
      // 兼容两种快照形态：{ data: {...} } 与旧版字段平铺
      const data = (snap?.data ?? snap) as SnapshotData | undefined;
      if (!data?.settings?.digestWeekly) {
        skipped += 1;
        continue;
      }

      const knowledge = data.knowledge ?? [];
      const dueItems = knowledge.filter(
        (k) => k && !k.unresolved && k.nextReviewAt && k.nextReviewAt <= today
      );
      const goals = data.goals ?? [];
      let doneDays = 0;
      const activeTopics: string[] = [];
      for (const g of goals) {
        if (g?.status === "active" && g.topic) activeTopics.push(g.topic);
        for (const d of Object.values(g?.plan?.days ?? {})) {
          if (d?.completedAt && d.completedAt >= weekAgo) doneDays += 1;
        }
      }

      // 无事不打扰
      if (dueItems.length === 0 && doneDays === 0) {
        skipped += 1;
        continue;
      }

      const name = rec.name || rec.email.split("@")[0];
      const dueList = dueItems
        .slice(0, 5)
        .map((k) => `<li style="margin:4px 0;">${escapeHtml(k.title)}</li>`)
        .join("");
      const more =
        dueItems.length > 5
          ? `<li style="margin:4px 0;color:#71717a;">…以及另外 ${dueItems.length - 5} 条</li>`
          : "";

      const html = `
<div style="background:#ffffff;color:#18181b;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;">
  <h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(name)}，这是你本周的学习周报</h1>
  <p style="font-size:14px;line-height:1.7;color:#3f3f46;margin:0 0 16px;">
    ${dueItems.length > 0
      ? `有 <b>${dueItems.length}</b> 条知识到了复习日。间隔重复的关键是按时回来——今天花几分钟过一遍，记忆曲线就接上了。`
      : `上周你完成了 <b>${doneDays}</b> 天学习任务，没有到期复习，继续保持。`}
  </p>
  ${dueList || doneDays > 0 ? `<div style="font-size:14px;"><b style="font-size:13px;color:#71717a;">${dueItems.length > 0 ? "本次到期：" : "上周完成："}</b><ul style="padding-left:20px;margin:8px 0 16px;">${dueList}${more}${dueItems.length === 0 ? `<li style="margin:4px 0;">${doneDays} 天学习任务</li>` : ""}</ul></div>` : ""}
  ${activeTopics.length > 0 ? `<p style="font-size:13px;color:#71717a;margin:0 0 16px;">进行中的目标：${activeTopics.slice(0, 3).map(escapeHtml).join(" · ")}</p>` : ""}
  ${site ? `<a href="${site}/brain" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;padding:10px 20px;border-radius:10px;">去复习</a>` : ""}
  <p style="font-size:12px;color:#a1a1aa;margin:24px 0 0;">这封邮件因为你开启了「每周复习邮件」而发送，可在 设置→账户 关闭。</p>
</div>`;

      const subject =
        dueItems.length > 0
          ? `Mentora 周报：${dueItems.length} 条知识到了复习日`
          : `Mentora 周报：上周完成了 ${doneDays} 天学习`;
      await sendEmail(rec.email, subject, html);
      sent += 1;
      logEvent({ route: "cron-digest", to: `${rec.email.slice(0, 3)}***`, due: dueItems.length, doneDays });
    } catch (e) {
      failed += 1;
      logEvent({ route: "cron-digest", error: e instanceof Error ? e.message : String(e) });
    }
  }

  return Response.json({ ok: true, total: users.length, sent, skipped, failed });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
