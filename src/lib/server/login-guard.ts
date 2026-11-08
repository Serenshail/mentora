import "server-only";
import { dbGet, dbPut, dbDelete, emailHash } from "./db";
import { deployEnv } from "./deploy-env";
import { verifyPassword } from "./auth";

/* 登录类凭据尝试的公共闸（v27 从 login 路由抽出，设备令牌登录共用同一套，单一真源）：
 * 账号维度防爆破（v17）：同一邮箱 10 分钟内累计失败 8 次 → 锁 15 分钟。
 * 计数走跨进程 KV，dev 无 KV 时跳过（计数失败不阻断安全主流程）。 */
export const FAIL_WINDOW_MS = 10 * 60_000;
export const FAIL_MAX = 8;
export const LOCK_MS = 15 * 60_000;

/* 时序对齐用的假档案：verifyPassword 内部是同参数 scrypt，成本与真档案一致、恒返回 false。
 * 不存在邮箱也跑一遍，抹平「邮箱不存在」与「密码错误」的响应时序差（邮箱可枚举）。 */
const DUMMY_SALT = "mentora-login-dummy-salt";
const DUMMY_HASH = "0".repeat(128);

export function dummyScryptVerify(password: string): void {
  verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
}

const failPath = (email: string) =>
  `loginfail/${deployEnv()}/${emailHash(email)}.json`;

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

export async function bumpFail(email: string): Promise<void> {
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
  } catch { /* 计数失败不阻断安全主流程 */ }
}

export async function clearFail(email: string): Promise<void> {
  await dbDelete(failPath(email), null).catch(() => {});
}
