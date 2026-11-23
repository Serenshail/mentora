import { NextRequest } from "next/server";
import { dbGet, dbPut, dbList } from "@/lib/server/db";
import { authorizeAdminDetailed } from "@/lib/server/admin-auth";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { createBatch, revokeLicense } from "@/lib/server/license";
import { isValidItemId } from "@/lib/server/personal";

export const runtime = "nodejs";
export const maxDuration = 60;

interface LeadRecord {
  id: string;
  email: string;
  contact: string;
  note: string;
  createdAt: string;
  status: "new" | "invited" | "ignored";
  licenseCode?: string;
}

async function guard(req: NextRequest): Promise<{ error: string; status: number } | null> {
  if (!(await rateLimitPersistent(`admin:leads:${clientIp(req)}`, { capacity: 20, refillPerSec: 20 / 60 }))) {
    return { error: "请求过于频繁", status: 429 };
  }
  /* 用 detailed 版区分四类失败（与 reading-metrics、members/users 同口径）：
   * 压成单一「未授权」会让操作员在后台无法自助定位。 */
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

const leadPath = (id: string) => `leads/${id}.json`;
/* id 白名单：真实 id 只出自 trial-request 的 `YYYYMMDD-8hex`。id 直接拼进存储路径，
 * GitHub Contents 通道把整条 path 拼进 api.github.com URL，`../` 会被 URL 规范化
 * 消解而越出 leads/（id=../users/<hash> 即落到任意用户档案）——与 personal.ts
 * isValidItemId 同一威胁模型，memory/reminders 已接入，leads 同口径兜住。 */

/* 单次 GET 最多读取的条数：trial-request 是公开入口（每 IP 限流，换 IP 即无界），
 * 长期营销期或刷量下 leads 可垒到数千上万条——不封顶的话一次 GET 就是上万次加密读，
 * 接口实质不可用。只读最新的 MAX_LEADS 条（文件名前缀是写入侧的日期，字典序=时间序），
 * total 回传全量条数，后台看得到有没有被截断。 */
const MAX_LEADS = 1000;

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  /* dbList 在通道故障时 throw（db.ts 列目录各分支），不包就是 Next 兜底的非 JSON 500，
   * 走 x-admin-password 的外部后台拿不到结构化失败信息。与 admin/users、members 同口径落 503。 */
  let files: { name: string; sha: string }[];
  try {
    files = await dbList("leads");
  } catch {
    return Response.json({ error: "线索库暂时不可用，稍后再试" }, { status: 503 });
  }
  const names = files.map((f) => f.name).sort((a, b) => (a < b ? 1 : -1)).slice(0, MAX_LEADS);
  /* 分块并发读（块内并行、块间串行）：与 admin/users 同款修法——串行 N+1
   * 每条都是一次远端加密读，数百条就顶满 maxDuration，后台列表打不开。 */
  const CHUNK = 8;
  const leads: LeadRecord[] = [];
  /* 单条读取/解密失败此前静默跳过且不回计数：损坏的体验申请从列表整体消失，
   * 管理员会把「读不出来」误判成「已删/从未提交」，漏掉线索即漏发体验码。
   * 与 admin/members、admin/users 的 skipped 同口径，计数必须回给 UI。 */
  let skipped = 0;
  for (let i = 0; i < names.length; i += CHUNK) {
    const part = await Promise.all(
      names.slice(i, i + CHUNK).map(async (name) => {
        try {
          return await dbGet<LeadRecord>(`leads/${name}`, { encrypted: true });
        } catch {
          return null; /* 单条跳过（计进下方 skipped） */
        }
      })
    );
    for (const rec of part) {
      if (!rec) skipped++;
      else leads.push(rec);
    }
  }
  leads.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return Response.json({ leads, total: files.length, skipped });
}

/** 一键发体验码：生成 1 张 trial 码并把这一条申请标成已邀请 */
export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) return Response.json({ error: "缺少申请 id" }, { status: 400 });
  if (!isValidItemId(id)) return Response.json({ error: "参数不对" }, { status: 400 });

  let lead: LeadRecord | null = null;
  try {
    lead = await dbGet<LeadRecord>(leadPath(id), { encrypted: true });
  } catch {
    return Response.json({ error: "线索库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!lead) return Response.json({ error: "申请不存在" }, { status: 404 });

  const days = Number(body.days ?? 7);
  let codes: string[];
  let batch: { id: string };
  try {
    ({ codes, batch } = await createBatch({
      count: 1,
      plan: "trial",
      days: Number.isFinite(days) && days >= 1 && days <= 365 ? Math.floor(days) : 7,
      note: `体验申请 ${lead.email}`.slice(0, 80),
      createdBy: "admin",
    }));
  } catch {
    return Response.json({ error: "卡密服务暂时不可用，稍后再试" }, { status: 503 });
  }
  const next: LeadRecord = { ...lead, status: "invited", licenseCode: codes[0] };
  try {
    await dbPut(leadPath(id), next, { encrypted: true });
  } catch {
    /* 码已生成但线索没标上：不补偿的话管理员重试会再发一张，留下孤儿码。
     * 尽力作废这张尚未交付的码；作废也失败就把码回传，让后台人工核销。 */
    let rolledBack = false;
    try {
      await revokeLicense(codes[0]);
      rolledBack = true;
    } catch { /* 作废失败，走下方人工核销分支 */ }
    return Response.json(
      rolledBack
        ? { error: "申请状态写入失败，本次体验码已作废，请重试" }
        : { error: "申请状态写入失败，体验码已生成但未标记，请人工核销", code: codes[0] },
      { status: 503 }
    );
  }
  return Response.json({ ok: true, lead: next, code: codes[0], batchId: batch.id });
}

export async function PATCH(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  const status = String(body.status ?? "");
  if (!isValidItemId(id) || !["new", "invited", "ignored"].includes(status)) {
    return Response.json({ error: "参数不对" }, { status: 400 });
  }
  let lead: LeadRecord | null = null;
  try {
    lead = await dbGet<LeadRecord>(leadPath(id), { encrypted: true });
  } catch {
    return Response.json({ error: "线索库暂时不可用，稍后再试" }, { status: 503 });
  }
  if (!lead) return Response.json({ error: "申请不存在" }, { status: 404 });
  const next = { ...lead, status: status as LeadRecord["status"] };
  try {
    await dbPut(leadPath(id), next, { encrypted: true });
  } catch {
    return Response.json({ error: "写入失败，稍后再试" }, { status: 503 });
  }
  return Response.json({ ok: true, lead: next });
}
