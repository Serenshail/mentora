import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbDelete, dbList, dbPutIfAbsent, emailHash } from "./db";
import { PLANS, type PlanId } from "../pricing";

/* ============================================================
 * 激活码（卡密）
 *
 * 一张码 = 一次兑换 = 给账号充值 N 天。码本身不绑定买家，
 * 谁先兑换归谁；兑换后绑定邮箱，不可转移。
 *
 * 存储：
 *   licenses/<sha256(码)>.json        单码记录（注册/续费 O(1) 查询）
 *   licenses/index/<batchId>.json     批次索引（后台列表一次读几条）
 *   claim/<sha256(码)>.json           原子占用标记（一码只能有一个赢家）
 *
 * 码用 32 字符表（去掉 0/O/1/I/L 这些易混字符），3 组 4 位，
 * 人读人抄都不容易错。
 * ============================================================ */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 30 个（去掉 0O1IL，避免手抄混）

export type LicenseStatus = "unused" | "used" | "revoked";

export interface LicenseUserBinding {
  email: string;
  emailHash: string;
  userId: string;
  at: string;
}

export interface LicenseRecord {
  id: string;
  code: string;
  plan: PlanId;
  days: number;
  note: string;
  batchId: string;
  createdAt: string;
  createdBy: string;
  /** 卡密自身的有效期；null = 永久可兑 */
  expiresAt: string | null;
  status: LicenseStatus;
  usedBy: LicenseUserBinding | null;
}

export interface LicenseBatch {
  id: string;
  plan: PlanId;
  days: number;
  note: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  codes: {
    code: string;
    status: LicenseStatus;
    usedByEmail?: string;
    usedAt?: string;
  }[];
}

/** 大小写不敏感、忽略空格与连字符：MTR-ABCD-EFGH / mtr abcdefgh 都能对上 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function codeHash(code: string): string {
  return crypto.createHash("sha256").update(normalizeCode(code)).digest("hex");
}

const licensePath = (code: string) => `licenses/${codeHash(code)}.json`;
const claimPath = (code: string) => `claim/${codeHash(code)}.json`;
const batchPath = (batchId: string) => `licenses/index/${batchId}.json`;
export { batchPath };

function randomCode(): string {
  // 逐位 randomInt：字节取模在字符表长度（30）不整除 256 时会有偏置，且
  // Array.from(byte→char) 一旦映射到 undefined 会静默少一位（已由测试锁住）。
  const chars = Array.from({ length: 12 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** 展示用：统一成 XXXX-XXXX-XXXX */
export function displayCode(raw: string): string {
  const n = normalizeCode(raw);
  return n.length === 12 ? `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8, 12)}` : raw.trim().toUpperCase();
}

export async function getLicense(rawCode: string): Promise<LicenseRecord | null> {
  const code = normalizeCode(rawCode);
  if (code.length !== 12) return null;
  return dbGet<LicenseRecord>(licensePath(code), { encrypted: true });
}

export interface CreateBatchInput {
  count: number;
  plan: PlanId;
  /** 覆盖套餐默认天数（后台可自定义） */
  days?: number;
  note?: string;
  createdBy: string;
  /** 卡密自身过期时间，防止旧码泄漏后被无限期使用 */
  expiresAt?: string | null;
}

/** 批量生成。返回明文码（只在这一次返回，之后后台仍可解密查看）。 */
export async function createBatch(input: CreateBatchInput): Promise<{ batch: LicenseBatch; codes: string[] }> {
  const plan = PLANS[input.plan];
  if (!plan) throw new Error("套餐不存在");
  const count = Math.max(1, Math.min(500, Math.floor(input.count)));
  const days = Math.max(1, Math.floor(input.days ?? plan.days));
  const now = new Date().toISOString();
  const batchId = `B${now.slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;

  const seen = new Set<string>();
  const codes: string[] = [];
  while (codes.length < count) {
    const c = randomCode();
    if (seen.has(c)) continue;
    seen.add(c);
    codes.push(c);
  }

  const batch: LicenseBatch = {
    id: batchId,
    plan: input.plan,
    days,
    note: (input.note || "").trim().slice(0, 80),
    createdAt: now,
    createdBy: input.createdBy,
    expiresAt: input.expiresAt ?? null,
    codes: codes.map((code) => ({ code, status: "unused" as const })),
  };

  await dbPut(batchPath(batchId), batch, { encrypted: true });
  for (const code of codes) {
    const rec: LicenseRecord = {
      id: code,
      code,
      plan: input.plan,
      days,
      note: batch.note,
      batchId,
      createdAt: now,
      createdBy: input.createdBy,
      expiresAt: batch.expiresAt,
      status: "unused",
      usedBy: null,
    };
    await dbPut(licensePath(code), rec, { encrypted: true });
  }
  return { batch, codes };
}

/** 更新批次索引里的某一张码（列表展示用；失败不影响兑换本身） */
async function touchBatchIndex(batchId: string, code: string, patch: Partial<LicenseBatch["codes"][number]>) {
  try {
    const idx = await dbGet<LicenseBatch & { _sha?: string }>(batchPath(batchId), { encrypted: true });
    if (!idx) return;
    const { _sha, ...clean } = idx;
    const row = clean.codes.find((c) => normalizeCode(c.code) === normalizeCode(code));
    if (row) Object.assign(row, patch);
    await dbPut(batchPath(batchId), clean, { encrypted: true, sha: _sha ?? null, overwriteOnConflict: true });
  } catch {
    /* 索引是展示层，写失败不回滚兑换 */
  }
}

export type RedeemFailure =
  | "INVALID"
  | "USED"
  | "REVOKED"
  | "EXPIRED_CODE"
  | "CLAIMED"
  | "DB";

/** 兑换第一步：原子占用。成功返回记录；失败返回原因。
 *  同一邮箱重复调用（上次流程中断）视为续做，不会误判成"被抢"。
 *  调用方在后续写用户档案失败时必须 releaseClaim()，把码还给用户。 */
export async function claimLicense(
  rawCode: string,
  user: { email: string; userId: string }
): Promise<{ ok: true; license: LicenseRecord } | { ok: false; reason: RedeemFailure }> {
  const code = normalizeCode(rawCode);
  if (code.length !== 12) return { ok: false, reason: "INVALID" };

  let rec: LicenseRecord | null;
  try {
    rec = await getLicense(code);
  } catch {
    return { ok: false, reason: "DB" };
  }
  if (!rec) return { ok: false, reason: "INVALID" };
  if (rec.status === "revoked") return { ok: false, reason: "REVOKED" };
  if (rec.status === "used") {
    // 同一个人重试：已经用掉了，不该再发一次时长
    return { ok: false, reason: "USED" };
  }
  if (rec.expiresAt && Date.parse(rec.expiresAt) < Date.now()) return { ok: false, reason: "EXPIRED_CODE" };

  const eh = emailHash(user.email);
  const claim = { emailHash: eh, email: user.email, userId: user.userId, at: new Date().toISOString() };
  let won = false;
  try {
    won = await dbPutIfAbsent(claimPath(code), claim, { encrypted: true });
  } catch {
    return { ok: false, reason: "DB" };
  }
  if (!won) {
    // 已有占用：同一邮箱且码还没被标记 used → 视为上次流程中断，允许续做
    let prev: { emailHash?: string } | null = null;
    try {
      prev = await dbGet<{ emailHash?: string }>(claimPath(code), { encrypted: true });
    } catch {
      return { ok: false, reason: "DB" };
    }
    if (!prev || prev.emailHash !== eh) return { ok: false, reason: "CLAIMED" };
  }

  const used: LicenseRecord = {
    ...rec,
    status: "used",
    usedBy: { email: user.email, emailHash: eh, userId: user.userId, at: new Date().toISOString() },
  };
  try {
    await dbPut(licensePath(code), used, { encrypted: true });
  } catch {
    // 占用标记已写、记录还没落：撤销占用，让别人可以再试
    await dbDelete(claimPath(code), null).catch(() => {});
    return { ok: false, reason: "DB" };
  }
  void touchBatchIndex(rec.batchId, code, {
    status: "used",
    usedByEmail: user.email,
    usedAt: used.usedBy?.at,
  });
  return { ok: true, license: used };
}

/** 注册写库失败时回滚：只释放"尚未被标记 used"的码 */
export async function releaseClaim(rawCode: string): Promise<void> {
  const code = normalizeCode(rawCode);
  if (code.length !== 12) return;
  try {
    const rec = await getLicense(code);
    if (rec && rec.status === "unused") await dbDelete(claimPath(code), null);
  } catch {
    /* 回滚失败不阻断，后台可手工处理 */
  }
}

export async function revokeLicense(rawCode: string): Promise<LicenseRecord | null> {
  const code = normalizeCode(rawCode);
  if (code.length !== 12) return null;
  const rec = await getLicense(code);
  if (!rec) return null;
  const next: LicenseRecord = { ...rec, status: "revoked" };
  await dbPut(licensePath(code), next, { encrypted: true });
  await touchBatchIndex(rec.batchId, code, { status: "revoked" });
  return next;
}

/** 后台列表：按创建时间倒序 */
export async function listBatches(): Promise<LicenseBatch[]> {
  const files = await dbList("licenses/index");
  const out: LicenseBatch[] = [];
  for (const f of files) {
    try {
      const b = await dbGet<LicenseBatch>(`licenses/index/${f.name}`, { encrypted: true });
      if (b) out.push(b);
    } catch {
      /* 单批读失败跳过 */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function failureMessage(reason: RedeemFailure): string {
  switch (reason) {
    case "INVALID":
      return "激活码不存在，检查一下有没有输错";
    case "USED":
      return "这张激活码已经被使用过了";
    case "REVOKED":
      return "这张激活码已被作废";
    case "EXPIRED_CODE":
      return "这张激活码已过期";
    case "CLAIMED":
      return "这张激活码正在被使用，请稍后再试";
    default:
      return "激活码服务暂时不可用，稍后再试";
  }
}
