#!/usr/bin/env node
/* ============================================================
 * T-ICT-041 本地验收截图：隔离测试账号登录 → 页脚运行标识 vs /api/health
 *
 * - 账号：一次性（带时间戳），注册后会通过 /api/auth/account 注销并清理云端数据
 * - 注意：注册会消耗 1 个 INVITE_CODE（license 记录标记 used，不可回滚）
 * - 依赖：playwright-core + 本机 Chrome
 *
 * 用法：node scripts/ict-acceptance-shot.mjs [--base http://localhost:3100]
 * 输出：docs/evidence/ict-track1-2026-11-20/gate/T-ICT-041-{footer,health}.png
 *       docs/evidence/ict-track1-2026-11-20/gate/T-ICT-041-acceptance.json
 * ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const baseIdx = process.argv.indexOf("--base");
const BASE = baseIdx > -1 ? process.argv[baseIdx + 1] : "http://localhost:3100";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EVID = path.join("docs", "evidence", "ict-track1-2026-11-20", "gate");
const INVITE =
  process.env.INVITE_CODE ||
  (/^INVITE_CODE=(.*)$/m.exec(fs.readFileSync(".env.local", "utf8"))?.[1] ?? "").trim();

const stamp = Date.now().toString(36);
const EMAIL = `ict-demo-${stamp}@163.com`;
const PASSWORD = `ict-demo-pw-${stamp}`;
const NAME = "ICT验收";

function out(m) {
  process.stdout.write(`${m}\n`);
}

async function main() {
  if (!INVITE) throw new Error("缺少 INVITE_CODE（.env.local）");
  fs.mkdirSync(EVID, { recursive: true });

  // 1) 注册一次性账号
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME, inviteCode: INVITE }),
  });
  const regBody = await reg.json().catch(() => null);
  out(`register: ${reg.status} ${regBody?.ok ? "ok" : JSON.stringify(regBody)}`);
  if (reg.status !== 200) {
    throw new Error(`注册失败（status=${reg.status}），未消耗登录流程`);
  }

  // 2) 浏览器登录 + 截图
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "zh-CN" });
  const page = await context.newPage();
  const result = { task: "T-ICT-041", base: BASE, at: new Date().toISOString(), email: EMAIL, steps: {} };

  try {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.getByRole("button", { name: /^登录$/ }).click();
    await page.waitForURL((u) => !String(u).includes("/login"), { timeout: 20000 });
    result.steps.login = { status: "PASS", url: page.url() };

    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    const badge = page.getByText(/运行标识/);
    await badge.waitFor({ state: "visible", timeout: 20000 });
    const footerText = (await badge.first().innerText()).trim();
    result.steps.footer = { status: "PASS", text: footerText };

    const footerPath = path.join(EVID, "T-ICT-041-footer.png");
    await page.screenshot({ path: footerPath, fullPage: true });

    // 3) /api/health
    await page.goto(`${BASE}/api/health`, { waitUntil: "networkidle" });
    const healthText = (await page.locator("body").innerText()).trim();
    const health = JSON.parse(healthText);
    const healthPath = path.join(EVID, "T-ICT-041-health.png");
    await page.screenshot({ path: healthPath, fullPage: true });
    result.steps.health = { status: "PASS", build: health.build };

    const shown = footerText.replace(/^运行标识\s*/, "");
    result.compare = {
      footerShown: shown,
      healthBuild: health.build,
      match: typeof health.build === "string" && shown === health.build.slice(0, 12),
    };
    if (!result.compare.match) throw new Error(`页脚与 health 不一致：footer=${shown} health=${health.build}`);

    // 4) 注销并清理云端数据（消耗的邀请码不可回滚）
    const del = await context.request.delete(`${BASE}/api/auth/account`, { data: { password: PASSWORD } });
    const delBody = await del.json().catch(() => null);
    result.steps.cleanup = { status: del.ok() ? "PASS" : "FAIL", httpStatus: del.status(), partial: delBody?.partial ?? [] };

    result.status = "PASS";
    out(`footer: ${footerText}`);
    out(`health.build: ${health.build}`);
    out(`match: ${result.compare.match}`);
    out(`cleanup: ${result.steps.cleanup.status} (${result.steps.cleanup.httpStatus})`);
  } catch (e) {
    result.status = "FAIL";
    result.error = e instanceof Error ? e.message : String(e);
    out(`FAIL: ${result.error}`);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(EVID, "T-ICT-041-acceptance.json"), JSON.stringify(result, null, 2));
  }

  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  out(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});