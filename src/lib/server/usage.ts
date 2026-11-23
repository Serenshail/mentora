import "server-only";
import { dbGet, dbPut, dbList, dbDelete, hasHealthyRemoteDb, emailHash } from "./db";

/* ============================================================
 * 免费版 AI 用量（PRD《会员与免费体验系统》§3）
 *
 * 到期会员自动降级为免费版：AI 不全停，而是受月度 token 预算限制。
 * 预算是"部署者的钱"的护栏——只对走服务端 Key 的免费用户计量；
 * BYOK（用户自带 Key）烧的是自己的钱，不计量。
 *
 * 计量与 quota.ts 同一套纪律：
 *   - 读-改-写非原子，对"防超支"够用（误差一两次不致命），换零新依赖；
 *   - 远端 KV 不健康/超时时降级放行——绝不因计量故障把人锁死；
 *   - 月度窗口（YYYY-MM），跨月自然清零，旧月键在首次计量时顺手清理。
 *
 * 预算 env：FREE_MONTHLY_TOKENS（默认 200_000，约等于几块钱的 DeepSeek 账单）。
 * ============================================================ */

const FREE_MONTHLY_TOKENS_DEFAULT = 200_000;

/* env 解析纪律（与 rate-limit.ts 的 trustedProxyHops 同源）：畸形值绝不透传。
 * 旧实现 Number("200,000") === NaN，Math.max(10_000, NaN) 仍是 NaN，而
 * withinFreeBudget 里 usedTokens < NaN 恒为 false —— 一个 env 拼写错误会让全体
 * 免费版用户从第一笔用量起就被 429「额度已用完」锁死整月（fail-closed 误伤）。
 * 只把合法的千分位分组（"200,000" / "150_000" / "150 000"）还原成纯数字；
 * 其余任何形态（"20万"/"abc"/"1,5"/"Infinity"）都视为配置错误回落默认值，
 * 既不把 NaN 带进比较式，也不会把笔误解析成离谱小值把人提前锁死。 */
function parseTokenBudget(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  /* 空值沿用旧语义（`|| DEFAULT`）：未配置即默认额度 */
  if (!s) return FREE_MONTHLY_TOKENS_DEFAULT;
  const grouped = /^\d{1,3}(?:[,_\s]\d{3})+$/.test(s) ? s.replace(/[,_\s]/g, "") : s;
  const n = Number(grouped);
  return Number.isFinite(n) && n >= 0
    ? Math.max(10_000, Math.floor(n))
    : FREE_MONTHLY_TOKENS_DEFAULT;
}

export function freeMonthlyTokens(): number {
  return parseTokenBudget(process.env.FREE_MONTHLY_TOKENS);
}

export interface UsageRecord {
  /** 输入 token 累计 */
  ti: number;
  /** 输出 token 累计 */
  to: number;
  /** 请求次数 */
  n: number;
}

const month = () => new Date().toISOString().slice(0, 7);
/* 键用 emailHash：邮箱是 PII，不该明文躺在 KV 键名里（与 users/ 同一约定） */
const path = (email: string) => `usage/${emailHash(email)}/${month()}.json`;
const monthDir = (email: string) => `usage/${emailHash(email)}`;

/** 中文为主的对话 1 token ≈ 1.6 字符；上游不给 usage 时的估算下限 */
export function estimateTokens(charsIn: number, charsOut: number): { ti: number; to: number } {
  return { ti: Math.ceil(charsIn / 1.6), to: Math.ceil(charsOut / 1.6) };
}

export async function getMonthlyUsage(email: string): Promise<UsageRecord> {
  try {
    const rec = await dbGet<UsageRecord>(path(email), { encrypted: true });
    return { ti: rec?.ti ?? 0, to: rec?.to ?? 0, n: rec?.n ?? 0 };
  } catch {
    return { ti: 0, to: 0, n: 0 };
  }
}

/** 本次请求累计进用量（best-effort：失败不阻断，下次计量自然补上偏差） */
export async function addUsage(
  email: string,
  ti: number,
  to: number,
  opts: { estimateInChars?: number; estimateOutChars?: number } = {}
): Promise<void> {
  if (!hasHealthyRemoteDb()) return;
  const est = opts.estimateInChars !== undefined
    ? estimateTokens(opts.estimateInChars, opts.estimateOutChars ?? 0)
    : { ti: 0, to: 0 };
  const delta = { ti: ti || est.ti, to: to || est.to };
  try {
    const rec = await dbGet<UsageRecord & { _sha?: string }>(path(email), { encrypted: true });
    const { _sha, ...clean } = rec ?? { ti: 0, to: 0, n: 0 };
    /* 本月第一次计量（此前无本月记录）时，顺手清理该用户的历史月键——键头注释
     * 一直声称「旧月键在首次计量时顺手清理」，但实现里从不存在（旧实现只在
     * quota.ts 有，usage/ 每用户每月永久累积一行、无界增长）。与 quota.ts:71-83 同款：
     * 保留本月、删其余；不 await，失败无所谓——绝不挡在用户请求路径上。 */
    const firstThisMonth = !rec;
    const next: UsageRecord = {
      ti: clean.ti + delta.ti,
      to: clean.to + delta.to,
      n: clean.n + 1,
    };
    await dbPut(path(email), next, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
    if (firstThisMonth) {
      void (async () => {
        try {
          const dir = monthDir(email);
          const files = await dbList(dir);
          for (const f of files) {
            if (f.name === `${month()}.json`) continue;
            await dbDelete(`${dir}/${f.name}`, null).catch(() => {});
          }
        } catch { /* 忽略 */ }
      })();
    }
  } catch {
    /* 计量失败不阻断 */
  }
}

/** 发请求前的预算闸：返回 { ok, used, limit }。读失败降级放行。 */
export async function withinFreeBudget(email: string): Promise<{
  ok: boolean;
  usedTokens: number;
  limit: number;
}> {
  const limit = freeMonthlyTokens();
  try {
    const rec = await getMonthlyUsage(email);
    const usedTokens = rec.ti + rec.to;
    return { ok: usedTokens < limit, usedTokens, limit };
  } catch {
    return { ok: true, usedTokens: 0, limit };
  }
}
