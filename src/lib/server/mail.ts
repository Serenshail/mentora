import "server-only";
import crypto from "node:crypto";
import { dbGet, dbPut, dbDelete, emailHash, hasHealthyRemoteDb } from "./db";
import { deployEnv } from "./deploy-env";

/* ============================================================
 * 邮箱验证码：生成/校验。
 * v17 起存远端 KV（D1/Upstash），跨 isolate 一致——
 * 旧实现在进程内存，Vercel 多实例下 send-code 和 register 落在不同
 * isolate 时验证码必然查不到（注册时好时坏的隐性根因）。
 * RESEND_API_KEY 存在 → 真实发信；不存在 → dev 模式：
 *   · 非生产：验证码回给前端自动填入（本地全链路可测）；
 *   · 生产：绝不外发验证码（send-code 路由负责 503 挡住）。
 * 无远端 KV 时（纯本地开发）回退进程内存，行为与旧版一致。
 * ============================================================ */

export type CodePurpose = "register" | "reset";

interface CodeEntry {
  code: string;
  expiresAt: number;
  attempts: number;
}

const TTL_MS = 10 * 60_000; // 10 分钟
const MAX_ATTEMPTS = 5;

const codePath = (purpose: CodePurpose, email: string): string =>
  `code/${deployEnv()}/${purpose}/${emailHash(email.trim().toLowerCase())}.json`;

/* 本地回退（仅无远端 KV 时启用） */
const MEM = new Map<string, CodeEntry>();

export async function issueCode(email: string, purpose: CodePurpose): Promise<string> {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const entry: CodeEntry = { code, expiresAt: Date.now() + TTL_MS, attempts: 0 };
  let remoteOk = false;
  if (hasHealthyRemoteDb()) {
    try {
      await dbPut(codePath(purpose, email), entry, { encrypted: true });
      remoteOk = true;
    } catch { /* 远端不可用 → 内存兜底（单实例内可完成注册/找回；熔断计数已在 db 层完成） */ }
  }
  if (!remoteOk) {
    MEM.set(`${purpose}:${email.toLowerCase()}`, entry);
    if (MEM.size > 5000) {
      for (const [k, v] of MEM) if (v.expiresAt < Date.now()) MEM.delete(k);
    }
  }
  return code;
}

export async function verifyCode(email: string, purpose: CodePurpose, input: string): Promise<boolean> {
  const given = input.trim();
  if (!given) return false;
  if (!hasHealthyRemoteDb()) {
    const key = `${purpose}:${email.toLowerCase()}`;
    const e = MEM.get(key);
    if (!e || e.expiresAt < Date.now()) {
      MEM.delete(key);
      return false;
    }
    e.attempts++;
    if (e.attempts > MAX_ATTEMPTS) {
      MEM.delete(key);
      return false;
    }
    if (e.code !== given) return false;
    MEM.delete(key); // 一次性
    return true;
  }
  const path = codePath(purpose, email);
  let entry: CodeEntry | null = null;
  try {
    entry = await dbGet<CodeEntry>(path, { encrypted: true });
  } catch {
    return false;
  }
  if (!entry || entry.expiresAt < Date.now()) {
    await dbDelete(path, null).catch(() => {});
    return false;
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    await dbDelete(path, null).catch(() => {});
    return false;
  }
  if (entry.code !== given) {
    entry.attempts++;
    await dbPut(path, entry, { encrypted: true }).catch(() => {});
    return false;
  }
  await dbDelete(path, null).catch(() => {}); // 一次性
  return true;
}

export function hasSmtp(): boolean {
  return Boolean(process.env.RESEND_API_KEY) || hasHuaweiMail();
}

/* ---- 发信双轨（T-069，HW-S-07）：EMAIL_CHANNEL 显式切换，缺省 resend 行为与历史逐字节一致 ----
 * resend：Resend HTTP API（既有通道）
 * huawei：华为云侧发信——POST 到 FunctionGraph 发信中继（SMN_ENDPOINT_URL，
 *   中继函数内经 SMTP/邮件推送落地；SMN 订阅制不适合事务验证码，故走函数中继形态）。
 * 纪律不变：严格 opt-in / 无事不打扰 / 失败不中断（异常向上抛，由调用方决定吞否）；
 * 两通道都未配置 → dev 模式打日志不外发（生产由路由 503 挡住）。 */

type MailChannel = "resend" | "huawei";

function hasHuaweiMail(): boolean {
  return Boolean(process.env.SMN_ENDPOINT_URL);
}

export function emailChannel(): MailChannel {
  if ((process.env.EMAIL_CHANNEL || "").trim().toLowerCase() === "huawei") return "huawei";
  return "resend";
}

async function sendViaHuawei(to: string, subject: string, html: string): Promise<{ sent: boolean }> {
  const endpoint = process.env.SMN_ENDPOINT_URL || "";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SMN_TOKEN || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, subject, html }),
  });
  if (!res.ok) {
    console.error("[mail:huawei] send failed", res.status, (await res.text()).slice(0, 200));
    throw new Error("邮件发送失败，请稍后再试");
  }
  return { sent: true };
}

/** 通用发信：EMAIL_CHANNEL=huawei 且配置中继 → 华为云通道；否则 Resend（配 Key）；
 *  都未配 → dev 打日志、返回 sent:false。发送失败抛错（调用方决定是否吞）。 */
export async function sendEmail(to: string, subject: string, html: string): Promise<{ sent: boolean }> {
  if (!hasSmtp()) {
    console.log(`[dev-mail] ${subject} → ${to}`);
    return { sent: false };
  }
  if (emailChannel() === "huawei" && hasHuaweiMail()) {
    return sendViaHuawei(to, subject, html);
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "Mentora <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    console.error("[mail] send failed", res.status, (await res.text()).slice(0, 200));
    throw new Error("邮件发送失败，请稍后再试");
  }
  return { sent: true };
}
/** 验证码发信：无任何可用通道 → dev 模式打日志并回 devCode（由路由决定能否外发） */
export async function sendCodeEmail(
  email: string,
  code: string,
  purpose: CodePurpose
): Promise<{ sent: boolean; devCode?: string }> {
  const subject =
    purpose === "register" ? "Mentora 注册验证码" : "Mentora 重置密码验证码";
  if (!hasSmtp()) {
    console.log(`[dev-mail] ${subject} → ${email}: ${code}`);
    return { sent: false, devCode: code };
  }
  await sendEmail(
    email,
    subject,
    `<p>你的验证码：<b style="font-size:20px;letter-spacing:4px">${code}</b>（10 分钟内有效）</p><p>如果不是你本人操作，请忽略本邮件。</p>`
  );
  return { sent: true };
}
