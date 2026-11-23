import { NextRequest } from "next/server";
import { verifyAnyAuth } from "@/lib/server/device-auth";
import { rateLimitPersistent } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";
import { readJsonBody } from "@/lib/server/body-limit";
import {
  deleteReminder,
  isValidItemId,
  listReminders,
  localNow,
  registerAutomationOwner,
  unregisterAutomationOwner,
  sanitizeReminderInput,
  saveReminder,
} from "@/lib/server/personal";

export const runtime = "nodejs";

/* 定时提醒（v24.0 二期）：用户说"每天早上 8 点提醒我复习"，这里存定义；
 * 到点由 /api/cron/tick（腾讯云 systemd timer 每分钟 / Vercel 每日兜底）发邮件。
 * 确定性发送：正文就是用户写的 prompt，不再调用模型（零 token 成本）。 */

async function guard(bucket: string, req: NextRequest) {
  const session = await verifyAnyAuth(req); // 会话 cookie 或设备令牌（插件）
  if (!session) return { error: Response.json({ error: "请先登录" }, { status: 401 }) };
  const ok = await rateLimitPersistent(`${bucket}:${session.userId}`, { capacity: 30, refillPerSec: 30 / 60 });
  if (!ok) return { error: Response.json({ error: "操作太频繁，稍后再试" }, { status: 429 }) };
  return { userId: session.userId, email: session.email };
}

export async function GET(req: NextRequest) {
  const g = await guard("reminders-read", req);
  if (g.error) return g.error;
  /* 读失败必须与"真的没有提醒"可区分：listReminders 抛错（dbList 通道故障）时
   * 旧实现 .catch(() => []) 会返回 200 + 空列表，消费方 lib/agent/tool-executors.ts:478
   * 拿到 ok:true 后直接对用户说「还没有定时提醒」——用户据 AI 回答以为提醒全丢了而重建，
   * 产生重复提醒与重复邮件。返回 503 后横幅侧（app-shell.tsx:176 的 r.ok 判断）照常忽略，
   * agent 侧则走「获取失败」分支，不再谎报空态。 */
  let reminders: Awaited<ReturnType<typeof listReminders>>;
  try {
    reminders = await listReminders(g.userId);
  } catch (e) {
    logEvent({ route: "reminders", ev: "list-read-fail", userId: g.userId, msg: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "提醒列表暂时读取失败，稍后再试" }, { status: 503 });
  }
  /* 自愈对账（2026-11 复核）：tick 只扫 automations/_index.json（全量遍历 users/ 要 46s，
   * 超 Vercel 60s 上限，做不了兜底扫描）。所以"提醒已存在但索引里没有本人"是永久静默失效，
   * 只能在这里修：每次读列表时若本人确有提醒而索引缺条目，就补登记一次。
   * registerAutomationOwner 内部先读索引、已存在则跳过，故正常用户只多一次读、不产生写。
   * best-effort：GET 是只读语义，补登记失败只记日志，绝不把列表读取变成失败响应
   * （POST 才是承诺点，那边注册失败会显式 503）。 */
  if (reminders.length > 0) {
    await registerAutomationOwner(g.userId, g.email).catch((e: unknown) => {
      logEvent({ route: "reminders", ev: "owner-repair-fail", userId: g.userId, msg: e instanceof Error ? e.message : String(e) });
    });
  }
  const now = new Date();
  return Response.json({
    reminders: reminders.map((r) => {
      const { date } = localNow(r.timezone, now);
      return {
        ...r,
        /** 今天已经发过的提醒（应用内横幅用；横幅本身按天可关闭） */
        firedToday: Boolean(r.lastRunKey && r.lastRunKey.startsWith(date)),
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const g = await guard("reminders-write", req);
  if (g.error) return g.error;
  /* 体积闸（与 auth 全系同一纪律）：req.json() 会把整个请求体缓冲并解析后才进
   * sanitizeReminderInput 的字段截断——30 次/30s 的限流管不住单个 GB 级请求体，
   * 自托管（Caddy 默认不限 body）下 JSON.parse 的内存尖峰足以 OOM 杀掉单进程 Node
   * （body-limit.ts 头注释的威胁模型）。512KB 声明闸 + 流式终闸，超标回 413；
   * 解析失败/空体回退 {} 的语义与旧 req.json().catch(() => ({})) 逐字对齐。 */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
  const clean = sanitizeReminderInput(body);
  if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
  /* 编辑已有提醒时 body.id 是原 id，saveReminder 会保留它；新建（或无此 id 的幽灵 id）时
   * saveReminder 生成新 id（personal.ts:162）。据此判断本次是否真的新增了一条记录——
   * 新增失败必须整体回滚，编辑失败绝不能删掉用户原有的提醒。 */
  let saved: Awaited<ReturnType<typeof saveReminder>> | null = null;
  try {
    saved = await saveReminder(g.userId, clean, typeof body.id === "string" ? body.id : undefined);
    /* 维护派发索引：让 tick 只扫"真有提醒"的用户（全量遍历在自托管上要 46s）。
     * 失败必须显式失败：索引写不进去，tick 就永远扫不到这位用户，提醒静默失效——
     * 索引挂了说明远端 KV 也挂了，本轮保存本来就不该承诺成功。 */
    await registerAutomationOwner(g.userId, g.email).catch((e: unknown) => {
      logEvent({ route: "reminders", ev: "register-owner-fail", userId: g.userId, msg: e instanceof Error ? e.message : String(e) });
      throw new Error("派发索引注册失败，稍后请重试");
    });
    return Response.json({ reminder: saved });
  } catch (e) {
    /* 本次新增的半成品必须回滚：否则「返回失败」的同时库里多出一条 tick 扫不到的孤儿提醒，
     * 用户按提示重试就会积出重复提醒（上限 20 条）。回滚本身失败也不影响响应——
     * 那条孤儿会被 GET 的自愈对账补登记（见上面 GET），不会永久静默。 */
    if (saved && saved.id !== body.id) {
      await deleteReminder(g.userId, saved.id).catch((err: unknown) => {
        logEvent({ route: "reminders", ev: "rollback-reminder-fail", userId: g.userId, msg: err instanceof Error ? err.message : String(err) });
      });
    }
    return Response.json({ error: e instanceof Error ? e.message : "保存失败" }, { status: 503 });
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guard("reminders-write", req);
  if (g.error) return g.error;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
  if (!isValidItemId(id)) return Response.json({ error: "id 不合法" }, { status: 400 });
  /* 删除失败必须如实回 503：旧实现 deleteReminder 吞掉 dbDelete 失败、这里无条件
   * ok:true，UI 显示"删除成功"但提醒仍在索引里、cron/tick 到点继续发信，刷新后"复活"。 */
  try {
    await deleteReminder(g.userId, id);
  } catch (e) {
    logEvent({ route: "reminders", ev: "delete-fail", userId: g.userId, id, msg: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "删除失败，请稍后再试" }, { status: 503 });
  }
  /* 关键：列表读失败时绝不能当成"没有提醒"去撤索引——那会把仍有效的派发条目删掉，
   * 之后 tick 永远扫不到这位用户（提醒静默失效）。只有确认列表为空才撤；撤失败不阻断。 */
  const rest = await listReminders(g.userId).catch((e: unknown) => {
    logEvent({ route: "reminders", ev: "list-after-delete-fail", userId: g.userId, msg: e instanceof Error ? e.message : String(e) });
    return null;
  });
  if (rest && rest.length === 0) {
    await unregisterAutomationOwner(g.userId).catch((e: unknown) => {
      logEvent({ route: "reminders", ev: "unregister-owner-fail", userId: g.userId, msg: e instanceof Error ? e.message : String(e) });
    });
  }
  return Response.json({ ok: true });
}
