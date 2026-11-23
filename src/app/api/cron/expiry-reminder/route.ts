import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { dbGet, dbPut, dbList, emailHash } from "@/lib/server/db";
import { sendEmail } from "@/lib/server/mail";
import { computeEntitlement, type UserPlanRecord } from "@/lib/server/entitlement";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 到期提醒：提前 7/3/1 天和到期当天各发一封。
 * 付费工具最常见的流失不是"不想续"，而是"忘了"。邮件是最便宜的挽回手段。
 * 鉴权与 weekly-digest 一致：Vercel Cron 带 Authorization: Bearer $CRON_SECRET，未配置一律拒绝。
 *
 * 时间预算：cron/tick/route.ts:14 记录「全量遍历 users/ 实测 46s，会超 Vercel 60s 上限」。
 * 本路由同样要扫全部用户（到期档位只命中一天，漏扫=永久丢失），故用分块并发把
 * 串行 N+1 压到 1/8 左右，并在每块前卡预算：宁可本轮 503 让调度方重试，
 * 也绝不让平台在写到一半时把请求杀掉。 */

const CHUNK = 8;
/* 平台 maxDuration=60s，但必须给"最后一块"留够余量：单块 8 路并发最坏要烧满
 * 4 次 5s 硬超时 + 退避（db.ts withRetry ≈22s），20s 起点 + 22s 仍远低于 60s。
 * 取 20s 与 cron/tick 的 BUDGET_MS 同口径。 */
const BUDGET_MS = 20_000;

interface UserRecord extends UserPlanRecord {
  userId: string;
  email: string;
  name: string;
}

const REMIND_DAYS = new Set([7, 3, 1, 0]);
const today = () => new Date().toISOString().slice(0, 10);

/* name 参数已移除：模板从未渲染过称呼（死参数），调用方却专门计算
 * rec.name || rec.email.split("@")[0] 传入，误导读者以为邮件有个性化称呼、
 * 且做 HTML 注入审计时会被带偏。将来要加称呼时再显式加回并做转义。 */
function html(daysLeft: number, site: string): string {
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
  /* 鉴权：sha256 定长 + timingSafeEqual，与 weekly-digest / tick / open token 同一纪律，
   * 不用 !== 明文比较。 */
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

  const site = (process.env.APP_URL || "").replace(/\/$/, "");
  /* 目录读失败不能折叠成空列表：那会让全员静默漏发，且响应与「一个用户都没有」同形。
   * 与 weekly-digest 同纪律：logEvent 留痕 + 非 200，让调度方/监控看得见。 */
  let files: { name: string; sha: string }[];
  try {
    files = await dbList("users");
  } catch (e) {
    logEvent({ route: "cron-expiry", error: `用户列表读取失败：${e instanceof Error ? e.message : String(e)}` });
    return Response.json(
      { ok: false, error: "用户列表读取失败，本次未发送", total: 0, sent: 0, skipped: 0, failed: 0 },
      { status: 500 }
    );
  }

  const deadline = Date.now() + BUDGET_MS;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;
  let truncated = false;

  /* 分块并发：串行 N+1（每人一次加密读 + 一次标记读 + 发信）是 46s 超时的成因，
   * 与 admin/members、admin/overview、weekly-digest 同款修法——块内并行、块间串行，
   * 既不一次打爆远端，又把往返摊薄。 */
  for (let i = 0; i < files.length; i += CHUNK) {
    /* 预算已尽就停下并如实上报（见下方 truncated 分支），绝不让平台在中途杀掉请求：
     * 被杀时尚未处理到的用户，其当天档位提醒会永久错过。 */
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    await Promise.all(
      files.slice(i, i + CHUNK).map(async (f) => {
        try {
          const rec = await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
          if (!rec?.email) return;
          const ent = computeEntitlement(rec);
          /* daysLeft 永不为 0（entitlement.ts:44-45：diff>0 → ceil≥1，diff<0 → floor≤-1），
           * REMIND_DAYS 的 0 档（到期当天）改由「过期后首个 cron」承接：daily 调度下
           * 必落在过期后 0-24h 内、daysLeft 恰为 -1，与 0 档一一对应；再过一天 daysLeft
           * 变 -2 不命中，天然只发一次。下面的 subject/html 的 daysLeft<=0 分支对 -1 同样成立。 */
          if (ent.daysLeft === null) return;
          const remindDay = ent.daysLeft === -1 ? 0 : ent.daysLeft;
          if (!REMIND_DAYS.has(remindDay)) return;

          const marker = `reminder/${emailHash(rec.email)}/${today()}.json`;
          /* 标记读失败必须按「未发」处理：把故障当已发（原 `.catch(() => "skip")` 的
           * 返回值是 truthy）会让该用户当天的档位提醒永久消失——明天 daysLeft 已不在
           * {7,3,1,-1}，不会再补发。宁可多发一封，不可静默丢一封。 */
          let already: unknown = null;
          try {
            already = await dbGet(marker, { encrypted: false });
          } catch {
            already = null;
          }
          if (already) {
            skipped += 1;
            return;
          }
          const r = await sendEmail(
            rec.email,
            ent.daysLeft <= 0
              ? "Mentora 会员今天到期（数据都还在）"
              : `Mentora 会员还有 ${ent.daysLeft} 天到期`,
            html(ent.daysLeft, site)
          );
          // 发信通道未配置时也写标记：避免每次 cron 都重试同一批（dev 环境日志已提示）
          await dbPut(marker, { at: new Date().toISOString(), sent: r.sent }, { encrypted: false }).catch(() => {});
          if (r.sent) sent += 1;
          else skipped += 1;
        } catch (e) {
          failed += 1;
          logEvent({ route: "cron-expiry", error: e instanceof Error ? e.message : String(e) });
        } finally {
          processed += 1;
        }
      })
    );
  }

  /* 截断 = 还有用户没扫到。已处理的用户有当日 marker 兜底、重跑幂等（只会补发未发的），
   * 但若这里报 ok:true，调度方不会重试，被截断用户的档位提醒就永久丢失——故 503。 */
  if (truncated) {
    logEvent({ route: "cron-expiry", ev: "truncated", total: files.length, processed });
    return Response.json(
      { ok: false, truncated: true, total: files.length, processed, sent, skipped, failed },
      { status: 503 }
    );
  }

  return Response.json({ ok: true, total: files.length, processed, sent, skipped, failed });
}
