import { NextRequest } from "next/server";
import { dbGet, dbPut, dbDelete, emailHash } from "@/lib/server/db";
import { verifyPassword, mintSession } from "@/lib/server/auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  avatar?: string;
  sv?: number;
}

/* 账号维度防爆破（v17）：此前只有每 IP 进程内桶——换 IP 即可无限试一个账号的密码。
 * 同一邮箱 10 分钟内累计失败 8 次 → 锁 15 分钟（锁的是"密码直登"，不是账号：
 * 验证码找回通道不受影响，文案给出路）。计数走跨进程 KV，dev 无 KV 时跳过。 */
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_MAX = 8;
const LOCK_MS = 15 * 60_000;

const failPath = (email: string) =>
  `loginfail/${process.env.VERCEL_ENV || "dev"}/${emailHash(email)}.json`;

interface FailState {
  n: number;
  /** 本轮失败窗口起点（首错时间）。窗口复位必须看它，不能看 until——until 平时是 0，
   *  旧实现用 until 判窗口导致每次都重置回 n=1，锁定永远不触发（冒烟实测抓到）。 */
  first: number;
  until: number;
}

async function getFailState(email: string): Promise<FailState | null> {
  try {
    return await dbGet<FailState>(failPath(email), { encrypted: true });
  } catch {
    return null; // KV 故障不挡登录
  }
}

async function bumpFail(email: string): Promise<void> {
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

async function clearFail(email: string): Promise<void> {
  await dbDelete(failPath(email), null).catch(() => {});
}

export async function POST(req: NextRequest) {
  // 防暴力破解：每 IP 突发 10 次、每分钟回填 10 次（跨 isolate 持久桶）
  if (!(await rateLimitPersistent(`login:${clientIp(req)}`, { capacity: 10, refillPerSec: 10 / 60 }))) {
    return Response.json({ error: "尝试太频繁，请稍后再试" }, { status: 429 });
  }
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  const fail = await getFailState(email);
  if (fail && fail.until > Date.now()) {
    const mins = Math.ceil((fail.until - Date.now()) / 60_000);
    return Response.json(
      { error: `这个账号失败次数过多，已临时锁定（约 ${mins} 分钟后解锁）。想不起来密码可用「忘记密码」找回` },
      { status: 429 }
    );
  }

  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(`users/${emailHash(email)}.json`, { encrypted: true });
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!record || !verifyPassword(password, record.salt, record.hash)) {
    if (record) await bumpFail(email); // 只给已注册邮箱计数，不给"探测存在性"留差异
    return Response.json({ error: "邮箱或密码不对" }, { status: 401 });
  }

  await clearFail(email);
  const user = {
    userId: record.userId,
    email: record.email,
    name: record.name,
    ...(record.avatar ? { avatar: record.avatar } : {}),
  };
  // 头像（base64 data-URL，可达数百 KB）绝不能进会话 cookie：cookie 的 name+value 超过 4096 字节
  // 会被浏览器直接丢弃，造成"登录成功但浏览器没有会话"——内页全被当未登录弹走、/api/sync 全 401。
  // 头像只通过响应体交给前端展示。sv 让会话可吊销（改密/重置后旧 cookie 作废）。
  await mintSession({ userId: user.userId, email: user.email, name: user.name, sv: record.sv ?? 0 });
  return Response.json({ user });
}
