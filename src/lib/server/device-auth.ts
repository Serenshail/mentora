import "server-only";
import crypto from "node:crypto";
import { dbGet } from "./db";
import { verifySession, type SessionUser } from "./auth";

/* 设备令牌（v27 · 插件重构 M1）：为 Obsidian 插件等无 cookie 宿主提供正式认证通道
 * （D3 决策：登录换长期设备令牌；PRD 7.1「使用 Mentora 正式认证体系」的插件侧落点）。
 *
 * 形态：d1.<emailHash>.<base64url(32B 随机)> —— 自含查找键，服务端只存 sha256(token)，
 * 原文只在签发响应里出现一次。生命周期 90 天；改密/重置（sv+1）时档案 devices 清空，
 * 所有设备令牌即时吊销（与 cookie 会话的 sv 吊销同拍）。
 *
 * 降级哲学与 verifySession 的差异（有意为之）：verifySession 超时放行，因为 cookie 里
 * 自带身份；设备令牌的身份在云端档案里，超时拿不到可信身份——fail-open 只能返回伪
 * 身份，会污染 usage/entitlement 记账。故设备通道超时一律拒绝（401），客户端重试。
 * 插件是次要入口，可用性损失可接受，误记账不可接受。 */

const DEVICE_PREFIX = "d1";
const SECRET_BYTES = 32;
const DEVICE_TTL_MS = 90 * 86_400_000;
const MAX_DEVICES = 10;

/** 最小请求形状：NextRequest 结构性满足（避免把 Next 类型拖进单测） */
export interface AuthRequest {
  headers: { get(name: string): string | null };
}

export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256(完整 token) 的 hex */
  hash: string;
  createdAt: string;
  expiresAt: string;
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** 解析 x-device-token 头。格式不对返回 null（不抛，交给上层统一 401）。 */
export function parseDeviceToken(raw: string | null): { key: string; token: string } | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [prefix, key, secret] = parts;
  if (prefix !== DEVICE_PREFIX) return null;
  if (!/^[a-f0-9]{24}$/.test(key)) return null; // emailHash 的形状
  if (secret.length < 20) return null;
  return { key, token: raw };
}

/** 为档案签发新设备令牌：先清过期，再按 createdAt 挤最旧，容量 MAX_DEVICES。
 *  返回明文 token（只在响应里出现一次）与应写回档案的 devices 数组。 */
export function issueDeviceToken(
  key: string,
  record: { devices?: DeviceRecord[] },
  deviceName: string,
  now = Date.now()
): { token: string; record: DeviceRecord; devices: DeviceRecord[] } {
  const secret = crypto.randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${DEVICE_PREFIX}.${key}.${secret}`;
  const prev = Array.isArray(record.devices) ? record.devices : [];
  const alive = prev
    .filter((d) => Date.parse(d.expiresAt) > now)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  while (alive.length >= MAX_DEVICES) alive.shift(); // 挤最旧
  const rec: DeviceRecord = {
    id: crypto.randomUUID(),
    name: deviceName,
    hash: hashDeviceToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEVICE_TTL_MS).toISOString(),
  };
  return { token, record: rec, devices: [...alive, rec] };
}

/** 校验 x-device-token：档案存在 + hash 定长比对 + 未过期。失败一律 null。 */
export async function verifyDeviceAuth(req: AuthRequest): Promise<SessionUser | null> {
  const parsed = parseDeviceToken(req.headers.get("x-device-token"));
  if (!parsed) return null;
  try {
    const rec = await Promise.race([
      dbGet<{ userId: string; email: string; name: string; devices?: DeviceRecord[] }>(
        `users/${parsed.key}.json`,
        { encrypted: true }
      )
        .then((r) => r ?? null)
        .catch(() => "timeout" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1200)),
    ]);
    if (!rec || rec === "timeout") return null; // 见头部注释：设备通道超时拒绝，不 fail-open
    if (!rec.userId || !rec.email) return null; // 档案不完整不当登录
    const hash = hashDeviceToken(parsed.token);
    const now = Date.now();
    const match = (rec.devices ?? []).find(
      (d) =>
        typeof d?.hash === "string" &&
        d.hash.length === hash.length &&
        crypto.timingSafeEqual(Buffer.from(d.hash), Buffer.from(hash))
    );
    if (!match) return null;
    if (Date.parse(match.expiresAt) <= now) return null;
    return { userId: rec.userId, email: rec.email, name: rec.name };
  } catch {
    return null;
  }
}

/** 统一鉴权入口：会话 cookie 优先（Web/小程序），设备令牌兜底（插件）。
 *  两者都无/无效返回 null，由调用方统一 401。 */
export async function verifyAnyAuth(req: AuthRequest): Promise<SessionUser | null> {
  const session = await verifySession();
  if (session) return session;
  return verifyDeviceAuth(req);
}
