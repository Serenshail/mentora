import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { dbList, dbGet } from "@/lib/server/db";
import { sendEmail, hasSmtp } from "@/lib/server/mail";
import { escapeHtml } from "@/lib/server/mail-html";
import { logEvent } from "@/lib/server/config";
import type { Goal, KnowledgeItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 时间预算（与 cron/tick、cron/expiry-reminder 的 BUDGET_MS 纪律同源）：
 * 两阶段循环若不做 deadline 检查，sendEmail 自带 10s 超时 + 5 路并发，最坏 wall time
 * ≈ ceil(mails/5)×10s + 第一阶段全量读——opt-in 用户偏多或 SMTP 偏慢时整轮超过
 * maxDuration=60 被平台强杀：本轮响应（含 ok/failed 统计）不会发出，尾部用户本周静默漏发
 * 且运维面零痕迹（周级任务错一周）。预算耗尽就停下并 503/truncated 如实上报，
 * 已发的不重发、未发的留待下周（宁可有痕迹的部分失败，不可无声的被强杀）。
 * 取 30s：耗尽后剩余工作最多再烧一块的最坏时长（db 读块 ≈22s / 发信块 10s），
 * 30s + 22s 仍留 8s+ 给响应，远低于 60s（expiry-reminder 用 20s 是因为单块起算更早）。 */
const BUDGET_MS = 30_000;

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
  // 比对走 sha256 定长 + timing-safe（与 open token / admin 密码同一纪律，不用 !== 明文比较）。
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers.get("authorization") || "";
  const authOk =
    secret && auth
      ? timingSafeEqual(
          createHash("sha256").update(`Bearer ${secret}`).digest(),
          createHash("sha256").update(auth).digest()
        )
      : false;
  if (!authOk) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (!hasSmtp()) {
    /* 必须带 503：这个分支的后果与下方「用户列表读取失败」完全相同（所有 digestWeekly
     * 用户整周收不到邮件、连续多周），却以 200 成功态返回——Vercel Cron / 运维告警
     * 只看状态码时该故障永久不可见（部署者已有人开周报但漏配 RESEND_API_KEY 的典型场景）。
     * 与姊妹路由 cron/tick 的 degraded 503、下方 :500 同一口径。 */
    return Response.json(
      { ok: false, error: "未配置发信服务（RESEND_API_KEY）", sent: 0 },
      { status: 503 }
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const site = (process.env.APP_URL || "").replace(/\/$/, "");

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const deadline = Date.now() + BUDGET_MS;
  /* 预算截断如实上报：truncated=true 时必有用户没扫到/没发到（unscanned/unsent 给出规模），
   * 结尾统一 503 告警——被平台强杀则连这份报告都不会有。 */
  let truncated = false;
  let unscanned = 0;
  let unsent = 0;

  /* 用户列表读取失败不能吞成空库：那会让全员静默漏发且响应与「空库」同形，
   * 周级任务失败要沉默一整周。logEvent 留痕 + ok:false 如实上报。 */
  let users: { name: string }[];
  try {
    users = await dbList("users");
  } catch (e) {
    logEvent({ route: "cron-digest", error: `用户列表读取失败：${e instanceof Error ? e.message : String(e)}` });
    return Response.json(
      { ok: false, error: "用户列表读取失败，本周未发送", total: 0, sent: 0, skipped: 0, failed: 0 },
      { status: 500 }
    );
  }

  /* 第一阶段：并发挑出 opt-in 且有话可说的用户，组装邮件（分块并发，100 用户也不至于串行拖满 maxDuration） */
  interface DigestMail {
    to: string;
    subject: string;
    html: string;
    due: number;
    doneDays: number;
  }
  const mails: DigestMail[] = [];
  const CHUNK = 8;
  for (let i = 0; i < users.length; i += CHUNK) {
    /* 第一阶段预算检查：耗尽就停，剩余用户数如实上报（isDue 式当天补发在这里不存在，
     * 周级任务被静默截断 = 错一周，必须让调度方/监控看见）。 */
    if (Date.now() > deadline) {
      truncated = true;
      unscanned = users.length - i;
      break;
    }
    await Promise.all(
      users.slice(i, i + CHUNK).map(async (f) => {
        try {
          const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
          if (!rec?.email || !rec.userId) {
            skipped += 1;
            return;
          }
          const snap = await dbGet<{ data?: SnapshotData } & SnapshotData>(
            `data/${rec.userId}.json`,
            { encrypted: true }
          );
          // 兼容两种快照形态：{ data: {...} } 与旧版字段平铺
          const data = (snap?.data ?? snap) as SnapshotData | undefined;
          if (!data?.settings?.digestWeekly) {
            skipped += 1;
            return;
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
            return;
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
          mails.push({ to: rec.email, subject, html, due: dueItems.length, doneDays });
        } catch (e) {
          failed += 1;
          logEvent({ route: "cron-digest", error: e instanceof Error ? e.message : String(e) });
        }
      })
    );
  }

  /* 第二阶段：分块并发发送（此前逐人串行 await，60 人即逼近 maxDuration，尾部用户静默漏发；
   * 单个中继挂起会拖死整轮——sendEmail 自带 10s 超时，这里 5 路并发兜住总量） */
  const SEND_CONCURRENCY = 5;
  for (let i = 0; i < mails.length; i += SEND_CONCURRENCY) {
    /* 第二阶段预算检查：耗尽就停，已组装未发送的邮件数如实上报（绝不悄悄停——
     * 那与「全部发完」在 ok:true 响应里不可区分，尾部用户静默漏发一整周）。 */
    if (Date.now() > deadline) {
      truncated = true;
      unsent = mails.length - i;
      break;
    }
    await Promise.all(
      mails.slice(i, i + SEND_CONCURRENCY).map(async (m) => {
        try {
          await sendEmail(m.to, m.subject, m.html);
          sent += 1;
          logEvent({ route: "cron-digest", to: `${m.to.slice(0, 3)}***`, due: m.due, doneDays: m.doneDays });
        } catch (e) {
          failed += 1;
          logEvent({ route: "cron-digest", error: e instanceof Error ? e.message : String(e), to: `${m.to.slice(0, 3)}***` });
        }
      })
    );
  }

  if (truncated) {
    logEvent({ route: "cron-digest", ev: "truncated", total: users.length, sent, skipped, failed, unscanned, unsent });
    return Response.json(
      {
        ok: false,
        truncated: true,
        error: "时间预算耗尽，本周部分用户未处理（unscanned=未组装，unsent=已组装未发送）",
        total: users.length,
        sent,
        skipped,
        failed,
        unscanned,
        unsent,
      },
      { status: 503 }
    );
  }
  return Response.json({ ok: true, total: users.length, sent, skipped, failed });
}
