import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbDelete, dbPutIfAbsent, emailHash } from "./db";

/* 忘记密码：不再用共享邀请码（拿到一张就能重置任意账号，等于没有锁）。
 * 改为管理员在后台点「发重置码」，一次性 8 位码，24 小时有效、用后即删。
 * 手动卖卡密阶段，用户本来就会加你微信——这条通道比邮箱验证码更可靠。 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const TTL_MS = 24 * 3600_000;
const MAX_ATTEMPTS = 8;

export interface ResetCodeRecord {
  code: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

const path = (email: string) => `reset/${emailHash(email)}.json`;

function generate(): string {
  // 逐位 randomInt：避免字节取模偏置与映射到 undefined 时静默少一位
  const chars = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export async function issueResetCode(email: string): Promise<{ code: string; expiresAt: number }> {
  const rec: ResetCodeRecord = {
    code: generate(),
    expiresAt: Date.now() + TTL_MS,
    attempts: 0,
    createdAt: Date.now(),
  };
  /* 同邮箱 24h 内重复发码会覆盖旧码（KV 通道本来就是覆盖写）。
   * GitHub 通道不带 sha 的 PUT 对已存在文件恒 422（db.ts:668），不声明 overwriteOnConflict
   * 就会在兜底通道上把「管理员重新发码」变成 503——与 KV 通道行为不一致。 */
  await dbPut(path(email), rec, { encrypted: true, overwriteOnConflict: true });
  return { code: rec.code, expiresAt: rec.expiresAt };
}

export type ResetVerify = "ok" | "none" | "expired" | "mismatch" | "error";

/** 用原子占位保证同一个重置码在跨实例并发下最多成功一次。 */
export async function consumeResetCode(email: string, input: string): Promise<ResetVerify> {
  const p = path(email);
  let rec: (ResetCodeRecord & { _sha?: string }) | null = null;
  try {
    rec = await dbGet<ResetCodeRecord>(p, { encrypted: true });
  } catch {
    /* 存储读失败（KV 超时/5xx/网络抖动）**不是**「码不存在」：旧实现折叠成 "none"，
     * 路由据此回 401「重置码不存在或已使用，请联系管理员重新发放」——存储故障期间
     * 持有有效码的用户收到假空态与无效指引（此时 issueResetCode 同样受影响）。
     * 单独返回 "error" 让路由作答 503（与本端点对用户记录读失败的处理纪律一致）。 */
    return "error";
  }
  if (!rec) return "none";
  if (Date.now() > rec.expiresAt) {
    await dbDelete(p, null).catch(() => {});
    return "expired";
  }
  const a = Buffer.from(input.trim().toUpperCase());
  const b = Buffer.from(rec.code);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    /* 失败计数是「8 次即焚」的唯一依据：必须真写进去。
     * 带上 dbGet 返回的 _sha 走乐观并发——GitHub 通道不带 sha 的 PUT 对已存在文件恒 422
     * （db.ts:668 靠 overwriteOnConflict 兜底），漏了就是静默吞错、attempts 永远读回 0。
     * 带 sha 还有一层安全语义：管理员在这期间重新发码会让 sha 失配而写失败，
     * 旧 rec（含旧 code）不会把新码覆盖回来。 */
    const { _sha, ...clean } = rec;
    const next: ResetCodeRecord = { ...clean, attempts: clean.attempts + 1 };
    if (next.attempts >= MAX_ATTEMPTS) await dbDelete(p, null).catch(() => {});
    else await dbPut(p, next, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true }).catch(() => {});
    return "mismatch";
  }
  // 不删除原记录：并发重新发码时，无条件删除可能误删新码。唯一标记同时
  // 包含签发时间，跨进程并发请求只能有一个抢到；存储故障时拒绝重置。
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify([email.toLowerCase(), rec.code, rec.createdAt]))
    .digest("hex");
  try {
    const claimed = await dbPutIfAbsent(`reset-used/${fingerprint}.json`, { expiresAt: rec.expiresAt }, { encrypted: true });
    return claimed ? "ok" : "none";
  } catch {
    return "error";
  }
}
