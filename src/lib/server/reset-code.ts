import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbDelete, emailHash } from "./db";

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
  await dbPut(path(email), rec, { encrypted: true });
  return { code: rec.code, expiresAt: rec.expiresAt };
}

export type ResetVerify = "ok" | "none" | "expired" | "mismatch";

/** 校验并在成功时立即删除（一次性）。失败按次数计，防暴力猜。 */
export async function consumeResetCode(email: string, input: string): Promise<ResetVerify> {
  const p = path(email);
  let rec: ResetCodeRecord | null = null;
  try {
    rec = await dbGet<ResetCodeRecord>(p, { encrypted: true });
  } catch {
    return "none";
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
    rec.attempts += 1;
    if (rec.attempts >= MAX_ATTEMPTS) await dbDelete(p, null).catch(() => {});
    else await dbPut(p, rec, { encrypted: true }).catch(() => {});
    return "mismatch";
  }
  await dbDelete(p, null).catch(() => {});
  return "ok";
}
