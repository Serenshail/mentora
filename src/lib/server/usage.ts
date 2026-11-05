import "server-only";
import { dbGet, dbPut, hasHealthyRemoteDb, emailHash } from "./db";

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

export function freeMonthlyTokens(): number {
  return Math.max(10_000, Number(process.env.FREE_MONTHLY_TOKENS || FREE_MONTHLY_TOKENS_DEFAULT));
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
    const next: UsageRecord = {
      ti: clean.ti + delta.ti,
      to: clean.to + delta.to,
      n: clean.n + 1,
    };
    await dbPut(path(email), next, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
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
