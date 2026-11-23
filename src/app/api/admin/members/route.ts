import { NextRequest } from "next/server";
import { dbGet, dbList, emailHash } from "@/lib/server/db";
import { authorizeAdminDetailed } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { computeEntitlement, extendMembership, setExpiry, type UserPlanRecord } from "@/lib/server/entitlement";
import { issueResetCode } from "@/lib/server/reset-code";
import { planOf } from "@/lib/pricing";

export const runtime = "nodejs";
export const maxDuration = 60;

interface UserRecord extends UserPlanRecord {
  userId: string;
  email: string;
  name: string;
  createdAt: string;
  avatar?: string;
  planHistory?: { licenseId: string; days: number; at: string }[];
  refCode?: string;
  invitedBy?: string;
  referrals?: { email: string; at: string; rewarded: boolean; ip?: string }[];
}

async function guard(req: NextRequest): Promise<{ error: string; status: number } | null> {
  if (!(await rateLimitPersistent(`admin:members:${clientIp(req)}`, { capacity: 20, refillPerSec: 20 / 60 }))) {
    return { error: "请求过于频繁", status: 429 };
  }
  /* 用 detailed 版区分四类失败（与 reading-metrics 同口径）：输错 x-admin-password
   * 要改密码、会话被吊销要重新登录、非管理员账号要换号，压成单一「未授权」
   * 会让操作员在会员管理页无法自助定位（如会话被吊销时误去反复试密码）。 */
  const auth = await authorizeAdminDetailed(req);
  if (!auth.ok) {
    const error =
      auth.reason === "bad-password"
        ? "后台密码错误"
        : auth.reason === "no-session"
          ? "请先登录或提供管理员密码"
          : "当前账号无管理员权限";
    return { error, status: 401 };
  }
  return null;
}

export interface MemberRow {
  email: string;
  name: string;
  userId: string;
  createdAt: string;
  plan: string | null;
  planExpiresAt: string | null;
  status: string;
  daysLeft: number | null;
  history: { licenseId: string; days: number; at: string }[];
  /** 拉新：自己的邀请码 / 已结算的邀请人数（人工反查刷单用） */
  refCode: string | null;
  referred: number;
  /** 谁邀请来的：解析成邀请人邮箱；解析不到就给原始码 */
  invitedByEmail: string | null;
  invitedByCode: string | null;
}

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  /* dbList 在通道故障时会 throw（db.ts 列目录各分支），不包就是 Next 兜底的非 JSON
   * 500——外部后台（x-admin-password）拿不到结构化失败信息。与 admin/overview、
   * admin/users、admin/leads 同口径落 503。 */
  let files: { name: string; sha: string }[];
  try {
    files = await dbList("users");
  } catch {
    return Response.json({ error: "会员数据暂时不可用，稍后再试" }, { status: 503 });
  }
  const members: MemberRow[] = [];
  // 邀请码 → 邮箱 的索引：把"这个人是谁邀请的"解析成看得懂的邮箱
  const refOwner = new Map<string, string>();
  /* 读取/解密失败此前静默跳过且不回计数：损坏会员从列表整体消失，管理员会把它
   * 误判成「账号不存在」（续期/改期/吊销都以这份列表为准）。与 overview 的
   * skippedUsers、admin/users POST 的 skipped 同口径，计数必须回给 UI。 */
  let skipped = 0;
  /* 串行 N+1：每用户一次远端加密读（每次 decrypt 还要走一遍解密 + KV 往返），
   * N 增长后本页会先于其他后台页顶满 maxDuration=60 → 会员管理不可用。
   * 与 admin/overview、admin/users、admin/leads 同款修法：分块并发，块内并行、
   * 块间串行，既压满往返又不至于一次打爆远端。 */
  const CHUNK = 8;
  for (let i = 0; i < files.length; i += CHUNK) {
    const part = await Promise.all(
      files.slice(i, i + CHUNK).map(async (f) => {
        try {
          return await dbGet<UserRecord>(`users/${f.name}`, { encrypted: true });
        } catch {
          return null; /* 单个解密失败跳过（下面计进 skipped） */
        }
      })
    );
    for (const rec of part) {
      if (!rec) {
        skipped++;
        continue;
      }
      if (rec.refCode) refOwner.set(rec.refCode.toUpperCase(), rec.email);
      const ent = computeEntitlement(rec);
      members.push({
        email: rec.email,
        name: rec.name,
        userId: rec.userId,
        createdAt: rec.createdAt,
        plan: ent.plan,
        planExpiresAt: ent.expiresAt,
        status: ent.status,
        daysLeft: ent.daysLeft,
        history: rec.planHistory ?? [],
        refCode: rec.refCode ?? null,
        referred: (rec.referrals ?? []).filter((r) => r.rewarded).length,
        invitedByEmail: null,
        invitedByCode: rec.invitedBy ?? null,
      });
    }
  }
  for (const m of members) {
    if (m.invitedByCode) m.invitedByEmail = refOwner.get(m.invitedByCode.toUpperCase()) ?? null;
  }
  members.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const summary = {
    total: members.length,
    active: members.filter((m) => m.status === "active" || m.status === "legacy").length,
    expiring: members.filter((m) => m.status === "expiring").length,
    expired: members.filter((m) => m.status === "expired").length,
    legacy: members.filter((m) => m.status === "legacy").length,
  };
  return Response.json({ members, summary, skipped });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return Response.json({ error: "缺少 email" }, { status: 400 });

  /* body.plan 是外部输入，用 planOf 而非 `in PLANS`：`in` 会走原型链，
   * "constructor"/"toString" 会被当成合法套餐写进用户档案。 */
  const plan = body.plan ? (planOf(String(body.plan))?.id ?? undefined) : undefined;

  /* extend/setExpiry/revoke 对档案不存在的邮箱会 throw「账号不存在」（entitlement.ts），
   * 不在这里先判存在性就会变成裸 500。先做参数校验（400），再 dbGet 判空 → 404，
   * 让管理员能区分「邮箱写错」和「系统故障」；404 之后紧跟着 withUserLock
   * 里的再读一次——中间账号被删的竞态窗口由 catch 落成 503，绝不裸 500。 */
  if (action !== "extend" && action !== "setExpiry" && action !== "revoke" && action !== "issueResetCode") {
    return Response.json({ error: "未知操作" }, { status: 400 });
  }
  if (action === "extend") {
    const days = Number(body.days ?? 30);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return Response.json({ error: "天数需在 1-3650 之间" }, { status: 400 });
    }
  }
  if (action === "setExpiry" && body.expiresAt) {
    if (Number.isNaN(new Date(String(body.expiresAt)).getTime())) {
      return Response.json({ error: "日期格式不对" }, { status: 400 });
    }
  }

  let exists: { email: string } | null = null;
  try {
    // 存在性检查也在通道故障面内：dbGet 于 GitHub 通道非 200 / 解密损坏时 throw，
    // 不包就是 Next 兜底的非 JSON 500，违背上方「绝不裸 500」的承诺——同 GET 落 503
    exists = await dbGet<{ email: string }>(`users/${emailHash(email)}.json`, { encrypted: true });
  } catch {
    return Response.json({ error: "用户数据库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!exists) return Response.json({ error: "账号不存在" }, { status: 404 });

  try {
    if (action === "extend") {
      const days = Number(body.days ?? 30);
      const entitlement = await extendMembership(email, Math.floor(days), plan);
      return Response.json({ ok: true, entitlement });
    }

    if (action === "setExpiry") {
      const raw = body.expiresAt;
      let expiresAt: string | null = null;
      if (raw) {
        const t = new Date(String(raw));
        expiresAt = t.toISOString();
      }
      const entitlement = await setExpiry(email, expiresAt, plan);
      return Response.json({ ok: true, entitlement });
    }

    if (action === "revoke") {
      const entitlement = await setExpiry(email, new Date(Date.now() - 60_000).toISOString(), plan);
      return Response.json({ ok: true, entitlement });
    }

    // issueResetCode：存在性已由上方统一判空覆盖（口径同为 404）
    const { code, expiresAt } = await issueResetCode(email);
    return Response.json({ ok: true, code, expiresAt });
  } catch {
    return Response.json({ error: "写入失败，请稍后再试" }, { status: 503 });
  }
}
