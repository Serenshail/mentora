#!/usr/bin/env node
/* P0 单浏览器同步误报复测（隔离账号 + 真实模型）
 * 流程：登录 → 长问答 → 停止 → 9×7 → 刷新 → 学习/笔记 → 横幅检查
 * 证据：docs/evidence/ict-track1-2026-11-20/gate/T-ICT-051-p0-sync.json + 截图
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.QA_BASE || "http://localhost:3101";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EVID = "docs/evidence/ict-track1-2026-11-20/gate";
const acct = JSON.parse(fs.readFileSync(".qa-account.json", "utf8"));

const out = (m) => process.stdout.write(`${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "zh-CN" });
  await context.addInitScript((uid) => {
    try {
      localStorage.setItem(`mentora-guide-v2:${uid}`, "skipped");
    } catch {}
  }, acct.userId || "");
  const page = await context.newPage();
  const sync = [];
  const result = { task: "T-ICT-051", base: BASE, at: new Date().toISOString(), steps: {}, sync };

  page.on("response", async (r) => {
    const u = r.url();
    if (!u.includes("/api/sync")) return;
    const rec = { at: Date.now(), method: r.request().method(), status: r.status() };
    const ct = r.headers()["content-type"] || "";
    if (ct.includes("json")) {
      const body = await r.json().catch(() => null);
      if (body) {
        rec.version = body.version ?? body.updatedAt;
        rec.uploadId = body.uploadId;
        rec.currentUploadId = body.currentUploadId;
        rec.conflict = body.conflict;
      }
    } else {
      rec.gzip = true;
    }
    sync.push(rec);
  });

  const banner = async () => (await page.locator("body").innerText()).includes("另一台设备已更新");

  const dismissGuide = async () => {
    const close = page.locator('[data-testid="guide-tour"] button[aria-label="关闭引导"]');
    if (await close.count()) await close.first().click().catch(() => {});
    await sleep(400);
  };

  try {
    const login = await context.request.post(`${BASE}/api/auth/login`, { data: acct });
    if (!login.ok()) throw new Error(`登录失败 ${login.status()}`);
    result.steps.login = { status: "PASS" };

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.locator("textarea").first().waitFor({ timeout: 20000 });
    await sleep(2500);
    result.steps.initial = { banner: await banner() };

    const ta = page.locator("textarea").first();
    await ta.fill("请详细讲解 Python 读取 CSV 的每个步骤，再出一道练习。");
    await page.locator('button[aria-label="发送消息"]').click();
    await sleep(8000);
    const stop = page.locator('button[aria-label="停止当前回答"]');
    if (await stop.count()) {
      await stop.first().click();
      await sleep(3000);
    }
    const afterStop = (await page.locator("body").innerText()).includes("已停止");
    result.steps.stop = { status: afterStop ? "PASS" : "OBSERVED", textHasStopped: afterStop };

    await ta.fill("只输出数字：9 乘以 7 等于多少？");
    await page.locator('button[aria-label="发送消息"]').click();
    await page.waitForFunction(() => document.body.innerText.includes("63"), null, { timeout: 150000 });
    result.steps.math = { status: "PASS", has63: true };
    await sleep(1500);
    result.steps.beforeReload = { banner: await banner() };
    await page.screenshot({ path: path.join(EVID, "T-ICT-051-p0-before-reload.png"), fullPage: true });

    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(4000);
    result.steps.afterReload = { banner: await banner() };

    await page.goto(`${BASE}/learn`, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    result.steps.learn = { banner: await banner() };

    await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    result.steps.brain = { banner: await banner() };
    await page.screenshot({ path: path.join(EVID, "T-ICT-051-p0-brain.png"), fullPage: true });

    const banners = [result.steps.beforeReload, result.steps.afterReload, result.steps.learn, result.steps.brain].filter((x) => x.banner);
    result.summary = { bannerCount: banners.length, syncEvents: sync.length };
    result.status = banners.length === 0 ? "PASS" : "FAIL";
    out(`bannerCount=${banners.length} syncEvents=${sync.length}`);
    out(`beforeReload=${result.steps.beforeReload.banner} afterReload=${result.steps.afterReload.banner} learn=${result.steps.learn.banner} brain=${result.steps.brain.banner}`);
  } catch (e) {
    result.status = "FAIL";
    result.error = e instanceof Error ? e.message : String(e);
    out(`FAIL: ${result.error}`);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(EVID, "T-ICT-051-p0-sync.json"), JSON.stringify(result, null, 2));
  }
  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  out(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});