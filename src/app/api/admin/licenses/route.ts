import { NextRequest } from "next/server";
import { authorizeAdmin } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { listBatches, createBatch, revokeLicense } from "@/lib/server/license";
import { planOf } from "@/lib/pricing";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 卡密管理（外部后台走 x-admin-password 头，与 overview 同一套鉴权） */

async function guard(req: NextRequest): Promise<{ error: string; status: number } | null> {
  if (!(await rateLimitPersistent(`admin:licenses:${clientIp(req)}`, { capacity: 20, refillPerSec: 20 / 60 }))) {
    return { error: "请求过于频繁", status: 429 };
  }
  if (!(await authorizeAdmin(req))) return { error: "未授权", status: 401 };
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });
  /* listBatches 内部的 dbList 在通道故障时 throw（db.ts 列目录各分支），不包就是
   * Next 兜底的非 JSON 500——走 x-admin-password 的外部后台拿不到结构化失败信息。
   * 与 admin/leads、users、members 同口径落 503。 */
  let batches: Awaited<ReturnType<typeof listBatches>>;
  try {
    batches = await listBatches();
  } catch {
    return Response.json({ error: "卡密服务暂时不可用，稍后再试" }, { status: 503 });
  }
  return Response.json({ batches });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const count = Number(body.count ?? 1);
  /* 用 planOf 而非 `in PLANS`：body.plan 是外部输入，`in` 会走原型链，
   * "constructor"/"toString" 会被放行到 createBatch。 */
  const planInfo = planOf(String(body.plan ?? "month"));
  if (!planInfo) return Response.json({ error: "套餐不存在" }, { status: 400 });
  const plan = planInfo.id;
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    return Response.json({ error: "一次生成 1-500 张" }, { status: 400 });
  }
  // null/undefined/空串都算"用套餐默认"——前端留空时发的是 null，此前只认 undefined
  // 导致后台留空必报"天数需在 1-3650 之间"，只能手动填数（2026-11-06 用户实测抓到）。
  const rawDays = body.days ?? undefined;
  const days = rawDays === undefined || rawDays === "" ? undefined : Number(rawDays);
  if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 3650)) {
    return Response.json({ error: "天数需在 1-3650 之间" }, { status: 400 });
  }
  // 先校验再转换：toISOString() 对 Invalid Date 会抛 RangeError（未捕获会变成 500）
  if (body.expiresAt && Number.isNaN(Date.parse(String(body.expiresAt)))) {
    return Response.json({ error: "卡密有效期格式不对" }, { status: 400 });
  }
  const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)).toISOString() : null;

  /* createBatch 内部多次 dbPut（license.ts:136/151）：任一通道故障都抛错。
   * 中途失败可能已落批次索引/部分单码，但码从未回传给管理员，重试只会生成新批次，
   * 不会造成重复发放；这里只负责把失败如实报成结构化 503。 */
  let created: Awaited<ReturnType<typeof createBatch>>;
  try {
    created = await createBatch({
      count,
      plan,
      days,
      note: String(body.note ?? ""),
      createdBy: "admin",
      expiresAt,
    });
  } catch {
    return Response.json({ error: "卡密服务暂时不可用，稍后再试" }, { status: 503 });
  }
  return Response.json({ ok: true, batch: created.batch, codes: created.codes });
}

export async function PATCH(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });
  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? "").trim();
  if (!code) return Response.json({ error: "缺少激活码" }, { status: 400 });
  /* revokeLicense 内部 getLicense/dbPut 会抛（license.ts:282/285），此前未捕获：
   * 通道故障时外部后台拿到裸 500，无法区分「码不存在(404)」与「服务故障(5xx)」，
   * 可能误判这张码已被处理。失败必须是 503 而不是 404，两者语义不能混。 */
  let rec: Awaited<ReturnType<typeof revokeLicense>>;
  try {
    rec = await revokeLicense(code);
  } catch {
    return Response.json({ error: "卡密服务暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!rec) return Response.json({ error: "找不到这张激活码" }, { status: 404 });
  return Response.json({ ok: true, license: rec });
}
