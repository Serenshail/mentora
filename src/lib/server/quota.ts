import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbList, dbDelete, hasHealthyRemoteDb } from "./db";

/* 服务端 Key 每日人均配额（商业化前置）：
 * 只在"用户没带自己的 BYOK Key、走部署者 Key"时计量;BYOK 用户不受限。
 * 计数存加密 KV(`quota/<idHash>/<日期>.json`),读-改-写非原子,
 * 对"防烧钱"这个目的足够(超用一两次的误差不致命),换来零新依赖。
 * 限额 env：AI_DAILY_CALL_LIMIT,默认 60 次/人/天；畸形值(带单位/字母)回落默认。
 * v17：键从平铺 `quota/<id>__<日期>.json` 改为按 id 分目录，并在每天首次
 * 计量时清掉该 id 的历史日键（旧实现日键永不清理、无界增长）。 */

/* 键用 idHash：id 通常是登录邮箱（PII），不该明文躺在 KV 键名里——与 usage.ts:path
 * （emailHash）、reset-code、loginfail 同一约定，此前 quota 是唯一破例点。
 * 传入 IP（未登录走部署者 Key）时同一哈希同样确定、可分区。
 * 算法与 db.ts 的 emailHash 逐字一致（trim+toLowerCase → sha256 hex 前 24 位）；
 * 这里各算一份而不是 import，是为了不让 quota 依赖 db 的导出面（已有单测对 db 做局部 mock）。 */
const idHash = (id: string) =>
  crypto.createHash("sha256").update(id.trim().toLowerCase()).digest("hex").slice(0, 24);

const today = () => new Date().toISOString().slice(0, 10);
const dayKey = (id: string) => `quota/${idHash(id)}/${today()}.json`;
const quotaDir = (id: string) => `quota/${idHash(id)}`;

const DAILY_CALL_LIMIT_DEFAULT = 60;

/* env 解析纪律（与 usage.ts 的 parseTokenBudget、rate-limit.ts 的 trustedProxyHops 同源）：
 * 畸形值绝不透传。旧实现 Math.max(1, Number("60/day")) 得 NaN，而
 * `n >= NaN` 恒为 false —— 部署者把限额写成带单位/带逗号的值，每日配额护栏
 * 会静默整体失效（fail-open），烧的是部署者的钱且零告警。
 * 只把合法的千分位分组（"1,000" / "1_000" / "1 000"）还原成纯数字；
 * 其余任何形态（"60/day"/"abc"/"1,5"/"0x10"/"-5"/"Infinity"）视为配置错误
 * 回落默认值——尤其不能把 "0x10" 解析成 16、"-5" 夹成 1，那会把人锁死在
 * 每天一两次调用上（另一种误伤）。 */
export function dailyCallLimit(): number {
  const s = (process.env.AI_DAILY_CALL_LIMIT ?? "").trim();
  if (!s) return DAILY_CALL_LIMIT_DEFAULT;
  const grouped = /^\d{1,3}(?:[,_\s]\d{3})+$/.test(s) ? s.replace(/[,_\s]/g, "") : s;
  if (!/^\d+$/.test(grouped)) return DAILY_CALL_LIMIT_DEFAULT;
  return Math.max(1, Number(grouped));
}

export async function checkAndCountServerKey(id: string): Promise<{
  ok: boolean;
  used: number;
  limit: number;
}> {
  const limit = dailyCallLimit();
  // 熔断期内不计量（放行）：限流失效好过功能不可用；BYOK/演示不经此处
  if (!hasHealthyRemoteDb()) return { ok: true, used: 0, limit };
  const key = dayKey(id);
  let n = 0;
  let firstToday = false;
  let sha: string | null = null;
  try {
    const rec = await dbGet<{ n: number }>(key, { encrypted: true });
    n = rec?.n ?? 0;
    sha = rec?._sha ?? null;
    firstToday = n === 0;
  } catch {
    /* 存储故障时放行(不阻断学习),但不写入 */
    return { ok: true, used: 0, limit };
  }
  if (n >= limit) return { ok: false, used: n, limit };
  try {
    // 复用上面读到的 sha（旧实现又 dbGet 一次同一键：多一次跨洋往返，白白拖慢首字节）
    await dbPut(key, { n: n + 1 }, { encrypted: true, sha, overwriteOnConflict: true });
  } catch {
    /* 写入失败不阻断 */
  }
  if (firstToday) {
    // 顺手清理该 id 的历史日键（保留今天）——**不 await**：清理是一次额外往返，
    // 绝不能让它挡在用户首字节前面；失败也无所谓。
    void (async () => {
      try {
        const files = await dbList(quotaDir(id));
        for (const f of files) {
          if (f.name === `${today()}.json`) continue;
          await dbDelete(`${quotaDir(id)}/${f.name}`, null).catch(() => {});
        }
      } catch { /* 忽略 */ }
    })();
  }
  return { ok: true, used: n + 1, limit };
}
