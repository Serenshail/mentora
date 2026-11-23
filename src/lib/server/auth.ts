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

/** 异步版哈希：参数与输出格式和 hashPassword 完全一致（hex 盐 + 64 字节 hex hash），
 *  仅把 scryptSync 换成线程池上的 crypto.scrypt。请求热路径（注册/改密/重置）用同步版
 *  会独占事件循环，理由同 verifyPasswordAsync——公开端点统一走异步版。 */
export function hashPasswordAsync(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err || !key) return reject(err ?? new Error("scrypt failed"));
      resolve({ salt, hash: key.toString("hex") });
    });
  });
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const test = crypto.scryptSync(password, salt, 64);
  const saved = Buffer.from(hash, "hex");
  return test.length === saved.length && crypto.timingSafeEqual(test, saved);
}

/** 异步版密码校验：scrypt 默认 N=16384，单次几十毫秒。放在请求热路径上用同步版会
 *  独占事件循环——分布式撞库（数百 IP 并发打 /api/auth/login）时 scrypt 串行排队，
 *  自托管单进程上全站请求一起卡顿。Node 官方明确建议请求路径用 crypto.scrypt。
 *  参数与 verifyPassword 完全一致，校验逻辑也逐字对齐，两条路径可互换。 */
export function verifyPasswordAsync(password: string, salt: string, hash: string): Promise<boolean> {
  return new Promise((resolve) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err || !key) return resolve(false);
      const saved = Buffer.from(hash, "hex");
      if (key.length !== saved.length) return resolve(false);
      resolve(crypto.timingSafeEqual(key, saved));
    });
  });
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
  /* 长度守卫必须按**字节**比，不能按字符串长度（UTF-16 码元）：sig 来自 cookie，
   * 攻击者可发 43 个多字节字符（str.length 相等、UTF-8 129 字节），
   * timingSafeEqual 遇字节长不等直接抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH，
   * 会穿过 getSessionUser/verifySession 变成 500。伪造 cookie 应判"未登录"。 */
  const got = Buffer.from(sig);
  const want = Buffer.from(expect);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
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
  /* secure 判定与 setSessionCookie 同源（isProdDeploy）：分叉会让本地 http 部署的
   * 登出 Set-Cookie 带 Secure 被拒收，会话静默残留 */
  jar.set(COOKIE, "", { httpOnly: true, sameSite: "lax", secure: isProdDeploy(), path: "/", maxAge: 0 });
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
    // 吊销校验是 best-effort：远端 KV 慢/不可用时放行（与 catch 分支同一哲学）。
    // 关键：超时必须和"账号确实不存在"区分开——超时判成未登录会把已登录用户误弹 401。
    const rec = await Promise.race([
      dbGet<{ sv?: number }>(`users/${emailHash(u.email)}.json`, { encrypted: true })
        .then((r) => r ?? null)
        .catch(() => "timeout" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1200)),
    ]);
    if (rec === "timeout") return u;
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
