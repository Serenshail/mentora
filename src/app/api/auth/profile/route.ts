import { NextRequest } from "next/server";
import { dbGet, dbPut, emailHash } from "@/lib/server/db";
import { verifySession, mintSession } from "@/lib/server/auth";
import { withUserLock } from "@/lib/server/entitlement";
import { readJsonBody } from "@/lib/server/body-limit";
import { rateLimit, rateLimitPersistent, type RateLimitOpts } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

interface UserRecord {
  userId: string;
  email: string;
  name: string;
  salt: string;
  hash: string;
  createdAt: string;
  avatar?: string;
  /** 会话版本号（改资料不递增，仅透传） */
  sv?: number;
  _sha?: string;
}

function publicUser(r: UserRecord) {
  return {
    userId: r.userId,
    email: r.email,
    name: r.name,
    ...(r.avatar ? { avatar: r.avatar } : {}),
  };
}

const EMAIL_HASH_PATH = (email: string) => `users/${emailHash(email)}.json`;

/* 读/写各一个按用户（userId，与 memory/reminders 的桶键同源）分桶的持久令牌桶：
 * 本路由是共享 KV 配额上最便宜的打点——PATCH 一次 = verifySession 读 + dbGet +
 * dbPut（gzip+AES）+ 档案锁 2 次写，GET 一次也有 2 次读。不限流时一个登录用户
 * 开并发脚本就能把 D1 免费档日写配额打穿，配额耗尽后全站写入（登录建档/同步/
 * 注册）集体失败到次日重置。容量给足正常操作（改称呼+换头像+几次重试），持续
 * 速率压到脚本化滥用不可能在配额耗尽前跑到有意义的量级。 */
const GET_LIMIT: RateLimitOpts = { capacity: 60, refillPerSec: 60 / 3600 };
const PATCH_LIMIT: RateLimitOpts = { capacity: 20, refillPerSec: 20 / 1800 };

/* rateLimitPersistent 内部在 KV 故障时降级为进程桶，但装配异常（模块缺导出/
 * 测试替身不全）会在进入 try 之前抛错。这里再兜一层进程桶：限流失效好过功能
 * 不可用，与 rate-limit.ts 的降级哲学一致。 */
async function allow(key: string, opts: RateLimitOpts): Promise<boolean> {
  try {
    return await rateLimitPersistent(key, opts);
  } catch {
    return rateLimit(key, opts);
  }
}

export async function GET() {
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  /* 设置页每次挂载拉一次；正常使用远低于 60 次突发 / 1 次每分钟的回填 */
  if (!(await allow(`profile:get:${session.userId}`, GET_LIMIT))) {
    return Response.json({ error: "操作太频繁，稍后再试" }, { status: 429 });
  }

  let record: UserRecord | null = null;
  try {
    record = await dbGet<UserRecord>(EMAIL_HASH_PATH(session.email), { encrypted: true });
  } catch {
    return Response.json({ error: "暂时读不到账户数据，稍后再试" }, { status: 503 });
  }
  if (!record) return Response.json({ error: "账户不存在" }, { status: 404 });
  return Response.json({ user: publicUser(record) });
}

export async function PATCH(req: NextRequest) {
  const session = await verifySession();
  if (!session) return Response.json({ error: "未登录" }, { status: 401 });
  /* 放在体积闸之前：超限请求体也不该拿到一次免费的限流桶写入。
   * 20 次突发足够「改称呼 + 换头像 + 失败重试」；回填 20/半小时，
   * 脚本化刷写最多也只剩每小时 40 次量级，D1 日配额不可能被单账号打穿。 */
  if (!(await allow(`profile:patch:${session.userId}`, PATCH_LIMIT))) {
    return Response.json({ error: "操作太频繁，稍后再试" }, { status: 429 });
  }

  /* 体积闸：合法载荷最大是头像 dataURL（本路由自限 400_000 字符），512KB 收口绰绰有余；
   * 超限必为滥用，直接 413 不缓冲 */
  const body = await readJsonBody(req);
  if (body === null) {
    return Response.json({ error: "请求体过大" }, { status: 413 });
  }

  const path = EMAIL_HASH_PATH(session.email);
  /* 读-改-写与 grantDays/setExpiry/extendMembership、change-password 共用同一把
   * 档案锁（withUserLock）：本路由对 users/<hash>.json 是整档覆盖写
   * （overwriteOnConflict；KV/D1/RDS/DCS 通道 dbPut 不消费 sha、last-write-wins）。
   * 无锁时改称呼/头像与并发兑换、登录补 founder 福利、改密/重置密码赛跑，
   * 后写者会拿旧快照把刚写入的 plan/planExpiresAt/planHistory、甚至新
   * salt/hash/sv 整档覆盖回去（付费时长永久丢失、密码重置被连带回滚）。
   * dbGet 必须在锁内重读：等锁期间锁外读到的快照同样已经过期。 */
  const outcome = await withUserLock(session.email, async (): Promise<
    | { ok: false; status: number; error: string }
    | { ok: true; user: ReturnType<typeof publicUser>; sv: number }
  > => {
    let record: UserRecord | null = null;
    try {
      record = await dbGet<UserRecord>(path, { encrypted: true });
    } catch {
      return { ok: false, status: 503, error: "暂时读不到账户数据，稍后再试" };
    }
    if (!record) return { ok: false, status: 404, error: "账户不存在" };

    const { _sha, ...clean } = record;
    const next: UserRecord = { ...clean };

    // 改名（同步重签会话，立即生效）
    if (body.name !== undefined) {
      // name:null 曾经 String(null) 变成 "null" 通过校验写进会话（avatar 分支对 null 有显式处理，这里对齐）
      if (body.name === null) {
        return { ok: false, status: 400, error: "称呼不能为空" };
      }
      const name = String(body.name).trim();
      if (name.length < 1 || name.length > 24) {
        return { ok: false, status: 400, error: "称呼请控制在 1–24 个字" };
      }
      next.name = name;
    }

    // 换头像 / 移除头像（dataURL，上限约 300KB）
    if (body.avatar === null || body.avatar === "") {
      delete next.avatar;
    } else if (body.avatar !== undefined) {
      const avatar = String(body.avatar);
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(avatar)) {
        return { ok: false, status: 400, error: "头像格式仅支持 PNG / JPG / WebP" };
      }
      if (avatar.length > 400_000) {
        return { ok: false, status: 400, error: "头像图片太大，请换一张小一点的" };
      }
      next.avatar = avatar;
    }

    try {
      await dbPut(path, next, {
        encrypted: true,
        sha: _sha ?? null,
        overwriteOnConflict: true,
      });
    } catch {
      return { ok: false, status: 503, error: "保存失败，稍后再试" };
    }
    return { ok: true, user: publicUser(next), sv: next.sv ?? 0 };
  }).catch(() => ({ ok: false as const, status: 503, error: "保存失败，稍后再试" }));

  if (!outcome.ok) {
    return Response.json({ error: outcome.error }, { status: outcome.status });
  }

  const user = outcome.user;
  // 名字写进了会话 cookie：重签后所有页面立即显示新称呼；sv 保持不变（改资料不踢设备）
  await mintSession({ userId: user.userId, email: user.email, name: user.name, sv: outcome.sv });
  return Response.json({ user });
}
