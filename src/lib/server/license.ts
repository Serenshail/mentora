import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbDelete, dbList, dbPutIfAbsent, emailHash } from "./db";
import { planOf, type PlanId } from "../pricing";

/* ============================================================
 * 激活码（卡密）
 *
 * 一张码 = 一次兑换 = 给账号充值 N 天。码本身不绑定买家，
 * 谁先兑换归谁；兑换后绑定邮箱，不可转移。
 *
 * 存储：
 *   licenses/<sha256(码)>.json        单码记录（注册/续费 O(1) 查询）
 *   licenses/index/<batchId>.json     批次索引（后台列表一次读几条）
 *   licenses/revoked/<sha256(码)>.json 作废墓碑（只增不改，作废/兑换竞态的裁决凭据）
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

/** 作废墓碑路径：只增不改，永不清除（后台没有"恢复 unused"的入口）。 */
const revokePath = (code: string) => `licenses/revoked/${codeHash(code)}.json`;

/** 读作废墓碑。失败向上抛：兑换主路径据此判 DB 故障（此刻尚未落任何写，重试干净）；
 *  回滚路径自行 catch 成 false——墓碑存在与否都不影响后续 claim 的前置拦截。 */
async function hasRevokeTombstone(code: string): Promise<boolean> {
  return (await dbGet<{ at?: string }>(revokePath(code), { encrypted: true })) != null;
}

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
  /* 用 planOf 而非 PLANS[input.plan]：后者对 "constructor" 等原型链键会返回
   * 一个真值（函数），`if (!plan)` 拦不住，随后 plan.days 为 undefined → NaN 天。
   * 路由层已用 planOf 校验，这里是纵深防御（函数也可能被其他内部调用方复用）。 */
  const plan = planOf(input.plan);
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
  /* 墓碑优先于记录状态：记录可能被并发还原成 unused（releaseClaim / 写后补偿），
   * 而墓碑只增不改，是唯一不会被覆盖的作废凭据。读失败按 DB 故障处理——
   * 此刻尚未落任何写，让用户重试是干净的。 */
  try {
    if (await hasRevokeTombstone(code)) return { ok: false, reason: "REVOKED" };
  } catch {
    return { ok: false, reason: "DB" };
  }
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
  /* 写后复核墓碑：作废与兑换的窗口只有"读到写"这百毫秒，但 KV 通道 last-write-wins，
   * 本函数的写可能后到、把 revoked 覆盖成 used——作废卡密的应急操作被恰好并发的
   * 一次兑换静默抵消，该码此后永久有效。墓碑只增不改，一旦落库必被读到：
   * 读到即说明本码已作废，绝不能入账。 */
  let revokedAfter: boolean;
  try {
    revokedAfter = await hasRevokeTombstone(code);
  } catch {
    /* 复核读失败：无法证明没作废，也绝不把码烧成 revoked（后台没有恢复入口）。
     * 回滚成 unused 让用户重试——若码真被作废，重试的前置墓碑检查会拒绝。 */
    await dbDelete(claimPath(code), null).catch(() => {});
    await dbPut(licensePath(code), { ...rec, status: "unused", usedBy: null }, { encrypted: true }).catch(() => {});
    return { ok: false, reason: "DB" };
  }
  if (revokedAfter) {
    await dbDelete(claimPath(code), null).catch(() => {});
    // 恢复成 revoked（两种落库顺序都收敛到 revoked），不留"已 used 但没入账"的假象
    await dbPut(licensePath(code), { ...used, status: "revoked", usedBy: null }, { encrypted: true }).catch(() => {});
    void touchBatchIndex(rec.batchId, code, { status: "revoked", usedByEmail: undefined, usedAt: undefined });
    return { ok: false, reason: "REVOKED" };
  }
  void touchBatchIndex(rec.batchId, code, {
    status: "used",
    usedByEmail: user.email,
    usedAt: used.usedBy?.at,
  });
  return { ok: true, license: used };
}

/** 注册/续费写库失败时回滚：把本次请求刚占用、尚未入账的码还原成可重兑。
 *  claimLicense 成功返回前就已把码标成 used（并保留占用标记），所以旧版
 *  「只在 status==="unused" 时删标记」对成功占用后的回滚是 no-op——失败重试必撞
 *  USED，付费码等效烧掉。现在分状态处理，钱上有两条安全线（宁可退不成，不能退错）：
 *  1) 码已被标 used 时，占用标记里的用户必须与 usedBy 一致——只退当前占用人自己的绑定；
 *  2) 占用人档案 planHistory 已含这张码（注册建号/续费累加已落库）说明时长已入账，
 *     绝不退，否则「写入已落库但响应丢失」会被误判成失败 → 同一张码兑两次。
 *  残余窗口：入账写在回滚的档案读取之后才落库（亚秒级）时仍会退——KV 层无 CAS 关不掉，
 *  但比旧版「一律不退、码必烧」好一个量级。 */
export async function releaseClaim(rawCode: string): Promise<void> {
  const code = normalizeCode(rawCode);
  if (code.length !== 12) return;
  try {
    const rec = await getLicense(code);
    if (!rec) return;
    if (rec.status === "unused") {
      // 占位标记还在但码未标 used（旧版遗留/claim 写 used 前进程中断）：删标记即释放
      await dbDelete(claimPath(code), null);
      return;
    }
    if (rec.status !== "used" || !rec.usedBy) return; // revoked 等状态交给后台，不动
    const claim = await dbGet<{ emailHash?: string }>(claimPath(code), { encrypted: true });
    // 占用标记缺失或归属对不上：不是这次失败请求占的码，不退（后台可按 usedBy 核对后手工复位）
    if (!claim?.emailHash || rec.usedBy.emailHash !== claim.emailHash) return;
    /* 已作废的码绝不还原成 unused：回滚与后台作废并发时，本次还原会覆盖掉 revoked，
     * 让一张本该死掉的码重新可兑。墓碑读失败按"可能已作废"处理（保守不退），
     * 与 withUserLock 的"抢不到锁绝不裸跑"同一纪律。 */
    if (await hasRevokeTombstone(code)) return;
    const user = await dbGet<{ planHistory?: { licenseId: string }[] }>(`users/${claim.emailHash}.json`, {
      encrypted: true,
    });
    if (user?.planHistory?.some((h) => normalizeCode(h.licenseId) === normalizeCode(rec.id))) return;
    // 先还原码、再删标记：中断在中间时留下「码 unused + 本人标记」，同邮箱重试可续做；
    // 反过来删了标记却没还原码，这张码就永久卡在 used（谁也兑不了）
    await dbPut(licensePath(code), { ...rec, status: "unused", usedBy: null }, { encrypted: true });
    await dbDelete(claimPath(code), null);
    /* 写后复核：作废恰好落在上面那次墓碑读之后、还原写之前时，记录会停在 unused。
     * 墓碑是只增凭据，读到就收敛回 revoked（兑换侧也以墓碑为准，双重保险）。
     * 保留 rec.usedBy 与 revokeLicense 一致——作废的码仍要能看出曾被谁占用过。 */
    if (await hasRevokeTombstone(code)) {
      await dbPut(licensePath(code), { ...rec, status: "revoked" }, { encrypted: true });
      void touchBatchIndex(rec.batchId, code, { status: "revoked", usedByEmail: undefined, usedAt: undefined });
      return;
    }
    void touchBatchIndex(rec.batchId, code, { status: "unused", usedByEmail: undefined, usedAt: undefined });
  } catch {
    /* 回滚失败不阻断（码保持占用，后台可手工复位），绝不向调用方抛错 */
  }
}

/** 作废：写「只增不改」的墓碑 + 覆盖记录状态。
 *
 *  旧实现是裸的 getLicense→dbPut 覆盖，而 claimLicense 的时序是
 *  读 rec(unused) → dbPutIfAbsent(claim) → dbPut(used)。作废若落在 claim 的读与写之间，
 *  claim 的写后到即胜（KV 通道 last-write-wins），已 revoked 的码以 used 落库——
 *  作废泄漏卡密的应急操作被恰好并发的一次兑换静默抵消，且该码此后永久有效。
 *
 *  现在先写墓碑（dbPutIfAbsent，各通道均原子；已存在即幂等），再写记录。
 *  墓碑是裁决凭据：claimLicense / releaseClaim 在写完记录后复核墓碑，读到就收敛回
 *  revoked 并拒绝入账。顺序不可颠倒——墓碑必须先落库，晚到的兑换写才会被识别。
 *  任何一步失败都向上抛：后台据此回 503（license.ts 调用方 admin/licenses:92 已捕获），
 *  绝不能把"作废失败"报成成功。 */
export async function revokeLicense(rawCode: string): Promise<LicenseRecord | null> {
  const code = normalizeCode(rawCode);
  if (code.length !== 12) return null;
  const rec = await getLicense(code);
  if (!rec) return null;
  /* 先墓碑：只增不改，重复作废天然幂等（dbPutIfAbsent 返回 false 不影响后续写入） */
  await dbPutIfAbsent(revokePath(code), { code, at: new Date().toISOString(), by: "admin" }, { encrypted: true });
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
