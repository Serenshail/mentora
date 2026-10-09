import "server-only";
import { dbGet, dbPut } from "./db";

/* 服务端 Key 每日人均配额（商业化前置）：
 * 只在"用户没带自己的 BYOK Key、走部署者 Key"时计量;BYOK 用户不受限。
 * 计数存加密 KV(`quota/<email>__<日期>.json`),读-改-写非原子,
 * 对"防烧钱"这个目的足够(超用一两次的误差不致命),换来零新依赖。
 * 限额 env：AI_DAILY_CALL_LIMIT,默认 60 次/人/天。 */

const dayKey = (email: string) =>
  `quota/${email.toLowerCase()}__${new Date().toISOString().slice(0, 10)}.json`;

export async function checkAndCountServerKey(email: string): Promise<{
  ok: boolean;
  used: number;
  limit: number;
}> {
  const limit = Math.max(1, Number(process.env.AI_DAILY_CALL_LIMIT || 60));
  const key = dayKey(email);
  let n = 0;
  try {
    const rec = await dbGet<{ n: number }>(key, { encrypted: true });
    n = rec?.n ?? 0;
  } catch {
    /* 存储故障时放行(不阻断学习),但不写入 */
    return { ok: true, used: 0, limit };
  }
  if (n >= limit) return { ok: false, used: n, limit };
  try {
    const rec = await dbGet<{ n: number; _sha?: string }>(key, { encrypted: true });
    await dbPut(key, { n: (rec?.n ?? 0) + 1 }, { encrypted: true, sha: rec?._sha ?? null, overwriteOnConflict: true });
  } catch {
    /* 写入失败不阻断 */
  }
  return { ok: true, used: n + 1, limit };
}
