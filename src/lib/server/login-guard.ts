import "server-only";
import { dbGet, dbPut, dbPutIfAbsent, dbDelete, emailHash } from "./db";
import { deployEnv } from "./deploy-env";
import { verifyPasswordAsync } from "./auth";

/* 登录类凭据尝试的公共闸（v27 从 login 路由抽出，设备令牌登录共用同一套，单一真源）：
 * 账号维度防爆破（v17）：同一邮箱 10 分钟内累计失败 8 次 → 锁 15 分钟。
 * 计数走跨进程 KV，dev 无 KV 时跳过（计数失败不阻断安全主流程）。 */
export const FAIL_WINDOW_MS = 10 * 60_000;
export const FAIL_MAX = 8;
export const LOCK_MS = 15 * 60_000;

/* 时序对齐用的假档案：与真档案同参数 scrypt，成本一致、恒返回 false。
 * 不存在邮箱也跑一遍，抹平「邮箱不存在」与「密码错误」的响应时序差（邮箱可枚举）。
 * 走异步版：登录热路径不能同步占住事件循环（见 auth.ts verifyPasswordAsync）。 */
const DUMMY_SALT = "mentora-login-dummy-salt";
const DUMMY_HASH = "0".repeat(128);

export function dummyScryptVerify(password: string): Promise<boolean> {
  return verifyPasswordAsync(password, DUMMY_SALT, DUMMY_HASH);
}

const failPath = (email: string) =>
  `loginfail/${deployEnv()}/${emailHash(email)}.json`;

/* 失败计数互斥位：bumpFail 的读-改-写必须串行化。并发失败请求若都读到 n=k、
 * 再各自写回 k+1，实际 C 次尝试只记 1 次——每 IP 桶 burst 10 足以把 10 次猜测
 * 并发打出，8 次即锁的语义被稀释成数十次（v17 注释要防的正是这个威胁）。
 * dbPutIfAbsent 在各通道都是原子占位（Upstash/DCS 的 SET NX、D1/RDS 的
 * INSERT ... ON CONFLICT DO NOTHING、GitHub 的 PUT-create 422），用它做短互斥，
 * 纪律同 entitlement.withUserLock。键挂在 loginfail/ 前缀下，复用 DCS 的 30min TTL。 */
const failLockPath = (email: string) =>
  `loginfail/${deployEnv()}/lock/${emailHash(email)}.json`;
const FAIL_LOCK_WAIT_MS = 10; // 第 i 轮退避 i×10ms；总时长由 FAIL_LOCK_BUDGET_MS 封顶
const FAIL_LOCK_STALE_MS = 10_000; // 持锁方崩溃遗留的接管阈值（取宽：误抢会丢原子性，宁肯降级为旧行为）

export interface FailState {
  n: number;
  /** 本轮失败窗口起点（首错时间）。窗口复位必须看它，不能看 until——until 平时是 0，
   *  旧实现用 until 判窗口导致每次都重置回 n=1，锁定永远不触发（冒烟实测抓到）。 */
  first: number;
  until: number;
}

export async function getFailState(email: string): Promise<FailState | null> {
  try {
    return await dbGet<FailState>(failPath(email), { encrypted: true });
  } catch {
    return null; // KV 故障不挡登录
  }
}

/** 抢失败计数互斥位：抢到 true。抢不到时只有「读到锁、且时间戳证明持锁方已超时」
 *  才删锁接管（崩溃遗留）；读不到锁时绝不删——可能正是别人的活锁。
 *  退避有总预算（1200ms，与 db.ts withBudget 同口径）：KV 故障或极端争用时
 *  不为一个 401 陪跑十几秒；读锁就失败则立刻放弃，交给调用方降级。 */
const FAIL_LOCK_BUDGET_MS = 1200;
async function acquireFailLock(email: string): Promise<boolean> {
  const key = failLockPath(email);
  const deadline = Date.now() + FAIL_LOCK_BUDGET_MS;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    const held = await dbPutIfAbsent(key, { at: Date.now() }, { encrypted: true }).catch(() => false);
    if (held) return true;
    let prev: { at?: number } | null = null;
    try {
      prev = await dbGet<{ at?: number }>(key, { encrypted: true });
    } catch {
      return false; // 读不到锁：无法判定持锁方是否超时，不接管、不陪跑
    }
    if (prev == null) {
      // 对方刚释放（或键在这两步之间消失）：立刻重抢，但留一档退避防通道抖动时空转
      await new Promise((r) => setTimeout(r, FAIL_LOCK_WAIT_MS));
      continue;
    }
    if (!prev.at || Date.now() - prev.at > FAIL_LOCK_STALE_MS) {
      await dbDelete(key, null).catch(() => {});
      continue; // 接管崩溃遗留锁后重抢
    }
    await new Promise((r) => setTimeout(r, FAIL_LOCK_WAIT_MS * (attempt + 1)));
  }
  return false;
}

export async function bumpFail(email: string): Promise<void> {
  const key = failLockPath(email);
  /* 抢不到互斥位（KV 故障 / 极端争用超预算）时仍照旧读-改-写：宁可退回旧的
   * 非原子计数，也不能把一次失败丢掉——安全语义上"少记"比"重复记"更糟。 */
  const counted = await acquireFailLock(email).catch(() => false);
  try {
    const now = Date.now();
    const cur = (await getFailState(email)) ?? { n: 0, first: now, until: 0 };
    if (now > cur.until && now - cur.first > FAIL_WINDOW_MS) {
      cur.n = 0;
      cur.first = now; // 过期窗口：重新起算
    }
    cur.n += 1;
    if (cur.n >= FAIL_MAX) cur.until = now + LOCK_MS;
    await dbPut(failPath(email), cur, { encrypted: true });
  } catch { /* 计数失败不阻断安全主流程 */ } finally {
    if (counted) await dbDelete(key, null).catch(() => {});
  }
}

export async function clearFail(email: string): Promise<void> {
  await dbDelete(failPath(email), null).catch(() => {});
}
