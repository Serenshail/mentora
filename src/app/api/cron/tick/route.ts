import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { dbGet, dbPut, dbPutIfAbsent, dbDelete } from "@/lib/server/db";
import { sendEmail, hasSmtp } from "@/lib/server/mail";
import { escapeHtml } from "@/lib/server/mail-html";
import { logEvent } from "@/lib/server/config";
import { isDue, listAutomationOwners, listReminders } from "@/lib/server/personal";

export const runtime = "nodejs";
export const maxDuration = 60;

/* ============================================================
 * 定时提醒派发（v24.0 二期）
 *
 * 触发源：腾讯云 systemd timer 每分钟（主力）/ Vercel Cron 每日兜底。
 * 只扫 automations/_index.json 里的用户（全量遍历 users/ 实测 46s，会超 Vercel 60s 上限）。
 * 幂等：lastRunKey（"YYYY-MM-DD HH:mm"）是「已投递」水位，跨天错过的不追发。
 * 但水位只能在发信**之后**写，而两个触发源会重叠（Vercel 那一次正好落在腾讯云 timer 的
 * 某一分钟内）：两边都会先读到 due=true 再各自发信，光靠 lastRunKey 挡不住重复邮件。
 * 因此发信前另用 dbPutIfAbsent 抢一把按提醒粒度的短锁（lock/run/<userId>/<reminderId>.json），
 * 发完写水位后才释放——见下方 claimPath 处的注释。
 * 投递与触发解耦：配了邮件就发信；没配也标记触发，应用内横幅（firedToday）兜底。
 * ============================================================ */

const MAX_SEND_PER_RUN = 20;
const BUDGET_MS = 20_000;

/* 单条提醒的发送权短锁路径。
 * 必须放在 lock/ 而不是 automations/<userId>/ 下：listReminders 会把该目录里每个
 * .json 都当提醒读回来，锁文件混进去会被当成一条没有 title/time 的提醒。
 * 键不含日期：锁只覆盖"本轮这一次投递"，发完就释放；幂等仍由 lastRunKey 负责。
 * 段内字符收窄到 [A-Za-z0-9_-]：这是写操作，路径里绝不允许出现 `..`/`/`。
 * （id 本身已由 isValidItemId 白名单约束，这里再收一道是纵深防御。） */
const safeSeg = (s: string) => s.replace(/[^0-9A-Za-z_-]/g, "-").slice(0, 80);
const runClaimPath = (userId: string, reminderId: string) =>
  `lock/run/${safeSeg(userId)}/${safeSeg(reminderId)}.json`;

/* 锁的崩溃接管阈值：正常一轮 sendEmail 最长 10s（mail.ts AbortSignal.timeout），
 * 加写水位远小于此值。超过 60s 仍是同一条提醒的锁，只可能是持有者进程被杀，
 * 允许接管（与 entitlement.ts LOCK_STALE_MS=30s 同思路，这里放宽以覆盖慢通道）。 */
const CLAIM_STALE_MS = 60_000;

/* 邮件模板转义：r.title / r.prompt 是用户任意输入（限 60/600 字），未转义就拼进 HTML
 * 会让提醒邮件变成可投递任意 HTML 的通道（伪造按钮/链接/追踪像素的钓鱼样式）。
 * 实现收口在 lib/server/mail-html.ts——此前本文件与 weekly-digest 各复制过一份逐字相同的
 * escapeHtml（漂移即事故隐患），现已共用单一实现。 */

export async function GET(req: NextRequest) {
  /* 鉴权：sha256 定长 + timingSafeEqual，与 weekly-digest / open token / admin 密码
   * 同一纪律，不用 !== 明文比较（代码库自声明的安全不变量）。 */
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
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const mailReady = hasSmtp();
  const site = (process.env.APP_URL || "").replace(/\/$/, "");
  const deadline = Date.now() + BUDGET_MS;

  let sent = 0;
  let scanned = 0;
  let failed = 0;
  let degraded = false;
  /* 预算/上限截断标记：因 MAX_SEND_PER_RUN 或 BUDGET_MS 提前收尾时如实上报，
   * 调用方才能区分「全部处理完」与「预算耗尽提前收尾」。主链路（腾讯云每分钟）下轮即补发，
   * 但仅靠 Vercel Cron 每日兜底 + isDue 只补当天的部署，截断即当天到期部分被永久漏发——
   * 响应必须能告警（与下方 degraded 的 503 同一「成功假象不可见」反模式的收口）。 */
  let truncated = false;
  const byChannel = { email: 0, inapp: 0 };

  /* 索引读失败绝不能折叠成空数组：isDue 只补发当天（跨天错过的不追发），
   * 把 KV 故障当成"没人配提醒"会让这次故障窗口内的提醒永久丢失，
   * 且响应 ok:true / sent:0 / failed 不增——运维面（systemd timer 拉 JSON）看不出任何异常。
   * fail-closed：照常扫已拿到的 owner（尽量追当天补发窗口），结尾 503 + degraded=true 告警。
   * 403 认证分支除外（未授权请求不需要 degraded 提示）。 */
  let owners: Awaited<ReturnType<typeof listAutomationOwners>> = [];
  try {
    owners = await listAutomationOwners();
  } catch (e) {
    degraded = true;
    logEvent({ route: "cron-tick", ev: "owners-read-fail", msg: e instanceof Error ? e.message : String(e) });
  }
  for (const owner of owners) {
    if (sent >= MAX_SEND_PER_RUN || Date.now() > deadline) {
      truncated = true;
      break;
    }
    try {
      /* 单用户读失败同样不计入扫描：折叠成 [] 会让该用户本轮到期提醒在循环外被静默跳过。 */
      const reminders = await listReminders(owner.userId);
      if (reminders.length === 0) continue;
      scanned += reminders.length;
      for (const r of reminders) {
        if (sent >= MAX_SEND_PER_RUN || Date.now() > deadline) {
          truncated = true;
          break;
        }
        const { due, key } = isDue(r);
        if (!due) continue;
        if (dryRun) {
          sent += 1;
          continue;
        }
        let via: "email" | "inapp" = "inapp";
        /* 发信前原子抢占发送权。lastRunKey 只能发完才写，而 Vercel Cron 那一次与
         * 腾讯云 timer 的某一分钟重叠时，两边都会先读到 due=true：不抢占就会各发一封
         * （isDue 的幂等只在"串行"下成立）。dbPutIfAbsent 是 license/referral 同款
         * 「只能有一个赢家」原子占位。
         * 占位是短锁（不是当天的永久标记）：发完写水位后释放，崩溃遗留按
         * CLAIM_STALE_MS 判定后可接管——与 entitlement.ts withUserLock 同一纪律，
         * 既不会永久吞掉当天提醒，也不会因为残留键把后续几天的提醒一起挡掉。 */
        const claimPath = runClaimPath(owner.userId, r.id);
        /* owned：锁确实是本实例写进去的。只有 owned 才允许在收尾时删锁——
         * 抢占报错时若也去删，会把另一个实例正在持有的锁删掉。
         * claimErrored：抢占本身失败（通道故障），必须与"没抢到（锁在别人手里）"
         * 严格区分，否则会把 KV 故障误判成并发竞争而跳过发送。 */
        let owned = false;
        let claimErrored = false;
        try {
          owned = await dbPutIfAbsent(claimPath, { at: Date.now() }, { encrypted: true });
        } catch (e) {
          /* 抢占本身失败 = KV 不健康。此处**不跳过**：锁与 lastRunKey 走同一套通道，
           * 通道挂了水位也写不进去，跳过只会让当天提醒彻底丢失（isDue 只补当天，
           * 跨天不追发）；重复一封邮件是可容忍的降级。保持修复前的 at-least-once
           * 语义，同时打 run-claim-fail 让故障可见。 */
          claimErrored = true;
          logEvent({ route: "cron-tick", ev: "run-claim-fail", reminder: r.id, msg: e instanceof Error ? e.message : String(e) });
        }
        if (!owned && !claimErrored) {
          /* 确实没抢到：可能是另一个实例正在发（正常跳过），也可能是持有者崩溃留下的
           * 残留。只有"读到锁且其时间戳证明已超时"才接管——读失败绝不能当 stale 去删。 */
          const prev = await dbGet<{ at?: number }>(claimPath, { encrypted: true }).catch(() => null);
          const takeover = prev != null && (!prev.at || Date.now() - prev.at > CLAIM_STALE_MS);
          if (takeover) {
            await dbDelete(claimPath, null).catch(() => {});
            owned = await dbPutIfAbsent(claimPath, { at: Date.now() }, { encrypted: true }).catch(() => false);
          }
          if (!owned) {
            logEvent({ route: "cron-tick", ev: "run-claim-lost", reminder: r.id, key });
            continue;
          }
        }
        /* 抢到锁之后必须重读一次提醒再判到期。上面的 r 是本轮 listReminders 的快照：
         * 若另一个实例在我们列目录之后、抢锁之前已经发完并写了 lastRunKey，
         * 我们手上的 r 仍是旧的（due=true），而锁此刻恰好是空的——只凭锁会重复发。
         * 锁 + 锁内重读水位才是完整的临界区（读失败则维持"照发"，at-least-once）。 */
        const fresh = await dbGet<{ lastRunKey?: string }>(
          `automations/${owner.userId}/${r.id}.json`,
          { encrypted: true }
        ).catch(() => null);
        if (fresh && fresh.lastRunKey === key) {
          if (owned) await dbDelete(claimPath, null).catch(() => {});
          logEvent({ route: "cron-tick", ev: "run-claim-superseded", reminder: r.id, key });
          continue;
        }
        try {
          if (mailReady) {
            await sendEmail(
              owner.email,
              `Mentora 提醒：${r.title}`,
              `<div style="font-family:system-ui,sans-serif;line-height:1.7">
                 <p style="font-size:15px"><b>${escapeHtml(r.title)}</b></p>
                 <p>${escapeHtml(r.prompt).replace(/\n/g, "<br/>")}</p>
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
        } catch (e) {
          /* 投递/写水位失败：先释放锁再抛，让下一分钟那轮重试（与修复前的
           * at-least-once 语义一致）。不释放就会把当天这条提醒静默吞掉。
           * 只在 owned 时删——抢占报错的降级放行没有锁可放，删了会误伤别人。 */
          if (owned) await dbDelete(claimPath, null).catch(() => {});
          throw e;
        }
        /* 成功：先写水位（上面 dbPut 已完成），再释放锁。
         * 释放放在水位之后是刻意的——锁一放开，另一个实例可能立刻抢到并重读提醒，
         * 此时它读到的 lastRunKey 已经是新值，isDue 直接判 false，不会重复发信。 */
        if (owned) await dbDelete(claimPath, null).catch(() => {});
        sent += 1;
        byChannel[via] += 1;
        logEvent({ route: "cron-tick", reminder: r.id, title: r.title.slice(0, 40), via });
      }
    } catch (e) {
      failed += 1; // 单用户失败不中断（listReminders 读失败 / 投递中途抛错都在此计入）
      logEvent({ route: "cron-tick", ev: "owner-fail", userId: owner.userId, msg: e instanceof Error ? e.message : String(e) });
    }
  }
  /* degraded（本轮索引读失败）时返回 503：ok:true + sent:0 与"真的没人配提醒"完全
   * 不可区分，而跨天错过即永久丢失——让调用方（systemd timer / Vercel Cron）能告警。
   * sent>0 时仍可能带 degraded=true（索引挂了但缓存到部分 owner），同样如实呈现。 */
  if (degraded) {
    return Response.json(
      {
        ok: false,
        degraded: true,
        truncated,
        sent,
        scanned,
        failed,
        owners: owners.length,
        mailReady,
        byChannel,
        dryRun,
      },
      { status: 503 }
    );
  }
  return Response.json({
    ok: true,
    truncated,
    sent,
    scanned,
    failed,
    owners: owners.length,
    mailReady,
    byChannel,
    dryRun,
  });
}
