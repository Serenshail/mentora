import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { dbGet, emailHash } from "./db";
import { isProdDeploy } from "./deploy-env";

const COOKIE = "mentora_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 天

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
  /** 会话版本号：改密/重置密码时档案里的 sv+1，旧 cookie（携带旧 sv）全部作废。
   *  无状态 HMAC 会话自此可吊销（v17 前只有"30 天到期"这一种失效方式）。 */
  sv?: number;
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET 未配置");
  return s;
}

/* ---- 密码：scrypt（Node 内置，随机盐） ---- */
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const test = crypto.scryptSync(password, salt, 64);
  const saved = Buffer.from(hash, "hex");
  return test.length === saved.length && crypto.timingSafeEqual(test, saved);
}

/* ---- 会话：HMAC 签名 cookie（无状态） ---- */
function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Date.now() + MAX_AGE * 1000 })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return {
      userId: data.userId,
      email: data.email,
      name: data.name,
      sv: typeof data.sv === "number" ? data.sv : 0,
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(user: SessionUser) {
  const jar = await cookies();
  jar.set(COOKIE, createSessionToken(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProdDeploy(), // 本地 next start 走 http，避免 cookie 无法回传
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return readSessionToken(jar.get(COOKIE)?.value);
}

/** 校验会话是否仍然有效：签名 + 过期 + 账号存在 + sv 版本号比对。
 *  改密/重置密码后档案 sv 递增，旧设备 cookie 至此全部吊销（此前 30 天内照用）。
 *  数据库故障时降级放行（v11 事故纪律：绝不因临时故障把在线用户判成未登录）。 */
export async function verifySession(): Promise<SessionUser | null> {
  const u = await getSessionUser();
  if (!u) return null;
  try {
    const rec = await dbGet<{ sv?: number }>(`users/${emailHash(u.email)}.json`, {
      encrypted: true,
    });
    if (!rec) return null; // 账号已注销
    if ((rec.sv ?? 0) !== (u.sv ?? 0)) return null; // 密码已改/已重置：旧会话作废
    return u;
  } catch {
    return u;
  }
}

/** 签发带版本号的会话 */
export async function mintSession(user: { userId: string; email: string; name: string; sv?: number }) {
  await setSessionCookie({ userId: user.userId, email: user.email, name: user.name, sv: user.sv ?? 0 });
}
