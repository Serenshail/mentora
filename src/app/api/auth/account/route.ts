import { NextRequest } from "next/server";
import { dbGet, dbDelete, dbDeleteDir, emailHash } from "@/lib/server/db";
import { verifySession, verifyPasswordAsync, clearSessionCookie } from "@/lib/server/auth";
import { logEvent } from "@/lib/server/config";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { dropRefCode } from "@/lib/server/referral";
import { purgePersonalData } from "@/lib/server/personal";
import { readJsonBody } from "@/lib/server/body-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 注销账号（自助删除）：必须密码二次确认；删除用户档案 + 云端数据，清除会话。
 *  与管理端删除同后果：不可恢复。本地设备数据由前端在成功后自行清仓。
 *  派生数据（data/ versions/ memory/ automations/）逐项 best-effort：单项失败不阻断注销
 *  （档案已删，阻断只会让用户卡在"删不掉也登不上"的半途），但每项失败都 logEvent 留痕，
 *  且任一失败时响应带 partial 数组——前端据此如实提示残留，不宣称"云端已删净"。 */
export async function DELETE(req: NextRequest) {
  if (!(await rateLimitPersistent(`delacc:${clientIp(req)}`, { capacity: 3, refillPerSec: 3 / 60 }))) {
    return Response.json({ error: "操作太频繁，请稍后再试" }, { status: 429 });
  }
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });

  /* 体积闸：注销确认载荷只有密码一项，超 512KB 必为滥用，直接 413 不缓冲 */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }
  const password = String(body.password ?? "");
  if (!password) return Response.json({ error: "请输入密码确认" }, { status: 400 });

  const path = `users/${emailHash(session.email)}.json`;
  let record: { userId: string; salt: string; hash: string; refCode?: string; _sha?: string } | null = null;
  try {
    record = await dbGet(path, { encrypted: true });
  } catch {
    return Response.json({ error: "账户数据暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!record) return Response.json({ error: "账户不存在" }, { status: 404 });
  /* 异步 scrypt：注销确认也要跑一次密码校验，同步版会在热路径独占事件循环（同 change-password） */
  if (!(await verifyPasswordAsync(password, record.salt, record.hash))) {
    return Response.json({ error: "密码不对" }, { status: 401 });
  }

  /* 邀请码索引必须在删档案「之前」取到 refCode：档案一删，再按 email 读 users/ 只会得到
   * null，索引永远清不掉（referral.ts dropRefCode 的入参因此改为 code 而非 email）。 */
  const refCode = record.refCode ?? null;
  try {
    await dbDelete(path, record._sha ?? null);
  } catch {
    return Response.json({ error: "删除失败，稍后再试" }, { status: 502 });
  }
  await dropRefCode(refCode);
  /* 档案已删、会话即将清掉——此后删除失败用户将永远失去重试入口，残留的加密数据
   * 也就再无任何路径可清。因此这里绝不阻断注销（残留不该反过来阻止用户删号，
   * 见 db.ts dbDeleteDir / personal.ts purgePersonalData 的既有纪律），但失败必须
   * 留痕：logEvent 进运维日志 + ok 里带 partial，前端据此如实告知而不是宣称"删净"。 */
  const partial: string[] = [];
  try {
    const dataFile = await dbGet(`data/${record.userId}.json`, { encrypted: true });
    if (dataFile) await dbDelete(`data/${record.userId}.json`, dataFile._sha ?? null);
  } catch (e) {
    partial.push("data");
    logEvent({ route: "account-delete", ev: "data-delete-fail", userId: record.userId, msg: e instanceof Error ? e.message : String(e) });
  }
  /* 历史快照也是用户数据：注销必须一并清掉，否则 versions/ 里留着最多 10 份加密全量备份，
   * 账号删了内容还在——这是隐私承诺上的漏洞（工程债清单 H4 的第 4 条，本条修复）。 */
  try {
    await dbDeleteDir(`versions/${record.userId}`);
  } catch (e) {
    partial.push("versions");
    logEvent({ route: "account-delete", ev: "versions-delete-fail", userId: record.userId, msg: e instanceof Error ? e.message : String(e) });
  }
  /* 长期记忆（memory/）与提醒（automations/ 含派发索引）一并清掉：
   * 不清索引的话 cron/tick 会按 automations/_index.json 对已注销账号照常到期发提醒邮件。 */
  await purgePersonalData(record.userId);

  await clearSessionCookie();
  return Response.json({ ok: true, userId: record.userId, ...(partial.length ? { partial } : {}) });
}
