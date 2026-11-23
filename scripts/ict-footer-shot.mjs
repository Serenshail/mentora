#!/usr/bin/env node
/* T-ICT-041 页脚运行标识截图（未登录基线）
 * 未登录首页同样处于 AppShell 内（RootLayout 全局包裹），可验证「页脚 == /api/health.build」。
 * 用法：node scripts/ict-footer-shot.mjs [--base http://localhost:3100]
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const baseIdx = process.argv.indexOf("--base");
const BASE = baseIdx > -1 ? process.argv[baseIdx + 1] : "http://localhost:3100";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EVID = path.join("docs", "evidence", "ict-track1-2026-11-20", "gate");

const out = (m) => process.stdout.write(`${m}\n`);

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "zh-CN" });
  const page = await context.newPage();
  const result = { task: "T-ICT-041", mode: "anonymous", base: BASE, at: new Date().toISOString() };

  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const badge = page.getByText(/运行标识/);
    await badge.waitFor({ state: "visible", timeout: 20000 });
    const footerText = (await badge.first().innerText()).trim();
    await page.screenshot({ path: path.join(EVID, "T-ICT-041-footer.png"), fullPage: true });

    await page.goto(`${BASE}/api/health`, { waitUntil: "domcontentloaded" });
    const health = JSON.parse((await page.locator("body").innerText()).trim());
    await page.screenshot({ path: path.join(EVID, "T-ICT-041-health.png"), fullPage: true });

    const shown = footerText.replace(/^运行标识\s*/, "");
    result.footer = footerText;
    result.healthBuild = health.build;
    result.match = typeof health.build === "string" && shown === health.build.slice(0, 12);
    result.status = result.match ? "PASS" : "FAIL";
    out(`footer: ${footerText}`);
    out(`health.build: ${health.build}`);
    out(`match: ${result.match}`);
  } catch (e) {
    result.status = "FAIL";
    result.error = e instanceof Error ? e.message : String(e);
    out(`FAIL: ${result.error}`);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(EVID, "T-ICT-041-footer-acceptance.json"), JSON.stringify(result, null, 2));
  }
  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  out(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});