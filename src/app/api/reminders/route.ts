import { NextRequest } from "next/server";
import { verifySession } from "@/lib/server/auth";
import { rateLimitPersistent } from "@/lib/server/rate-limit";
import { isDeployed } from "@/lib/server/deploy-env";
import {
  deleteReminder,
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

async function guard(bucket: string) {
  const session = await verifySession();
  if (!session) return { error: Response.json({ error: "请先登录" }, { status: 401 }) };
  const ok = await rateLimitPersistent(`${bucket}:${session.userId}`, { capacity: 30, refillPerSec: 30 / 60 });
  if (!ok) return { error: Response.json({ error: "操作太频繁，稍后再试" }, { status: 429 }) };
  void isDeployed();
  return { userId: session.userId, email: session.email };
}

export async function GET() {
  const g = await guard("reminders-read");
  if (g.error) return g.error;
  const reminders = await listReminders(g.userId).catch(() => []);
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
  const g = await guard("reminders-write");
  if (g.error) return g.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const clean = sanitizeReminderInput(body);
  if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
  try {
    const reminder = await saveReminder(g.userId, clean, typeof body.id === "string" ? body.id : undefined);
    /* 维护派发索引：让 tick 只扫"真有提醒"的用户（全量遍历在自托管上要 46s） */
    await registerAutomationOwner(g.userId, g.email).catch(() => {});
    return Response.json({ reminder });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "保存失败" }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guard("reminders-write");
  if (g.error) return g.error;
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
  await deleteReminder(g.userId, id);
  const rest = await listReminders(g.userId).catch(() => []);
  if (rest.length === 0) await unregisterAutomationOwner(g.userId).catch(() => {});
  return Response.json({ ok: true });
}
