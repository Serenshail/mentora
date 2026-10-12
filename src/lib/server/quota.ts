import "server-only";
import { dbGet, dbPut, dbList, dbDelete, hasHealthyRemoteDb } from "./db";

/* 服务端 Key 每日人均配额（商业化前置）：
 * 只在"用户没带自己的 BYOK Key、走部署者 Key"时计量;BYOK 用户不受限。
 * 计数存加密 KV(`quota/<id>/<日期>.json`),读-改-写非原子,
 * 对"防烧钱"这个目的足够(超用一两次的误差不致命),换来零新依赖。
 * 限额 env：AI_DAILY_CALL_LIMIT,默认 60 次/人/天。
 * v17：键从平铺 `quota/<id>__<日期>.json` 改为按 id 分目录，并在每天首次
 * 计量时清掉该 id 的历史日键（旧实现日键永不清理、无界增长）。 */

const today = () => new Date().toISOString().slice(0, 10);
const dayKey = (id: string) => `quota/${id.toLowerCase()}/${today()}.json`;
const quotaDir = (id: string) => `quota/${id.toLowerCase()}`;

export async function checkAndCountServerKey(id: string): Promise<{
  ok: boolean;
  used: number;
  limit: number;
}> {
  const limit = Math.max(1, Number(process.env.AI_DAILY_CALL_LIMIT || 60));
  // 熔断期内不计量（放行）：限流失效好过功能不可用；BYOK/演示不经此处
  if (!hasHealthyRemoteDb()) return { ok: true, used: 0, limit };
  const key = dayKey(id);
  let n = 0;
  let firstToday = false;
  try {
    const rec = await dbGet<{ n: number }>(key, { encrypted: true });
    n = rec?.n ?? 0;
    firstToday = n === 0;
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
  if (firstToday) {
    // 顺手清理该 id 的历史日键（保留今天），best-effort 不阻断
    try {
      const files = await dbList(quotaDir(id));
      for (const f of files) {
        if (f.name === `${today()}.json`) continue;
        await dbDelete(`${quotaDir(id)}/${f.name}`, null).catch(() => {});
      }
    } catch { /* 忽略 */ }
  }
  return { ok: true, used: n + 1, limit };
}
