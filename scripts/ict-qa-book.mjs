import fs from "node:fs";
import { chromium } from "playwright-core";
const BASE = "http://localhost:3101";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EVID = "docs/evidence/ict-track1-2026-11-20/gate";
const acct = JSON.parse(fs.readFileSync(".qa-account.json", "utf8"));
const out = (m) => process.stdout.write(`${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
await ctx.addInitScript((uid) => { try { localStorage.setItem(`mentora-guide-v2:${uid}`, "skipped"); } catch {} }, acct.userId || "");
const page = await ctx.newPage();
const result = { task: "T-ICT-054-book", at: new Date().toISOString(), steps: {} };
try {
  const login = await ctx.request.post(`${BASE}/api/auth/login`, { data: acct });
  if (!login.ok()) throw new Error(`login ${login.status()}`);
  await page.goto(`${BASE}/learn`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await page.getByRole("button", { name: /添加第一本书|添加书籍|添加/ }).first().click();
  await page.locator('input[placeholder="书名（必填）"]').fill("The Pragmatic Programmer");
  await page.locator('input[placeholder="作者（可选）"]').fill("David Thomas and Andrew Hunt");
  await page.getByRole("button", { name: /^生成阅读计划$/ }).click();
  await sleep(45000);
  const text = await page.locator("body").innerText();
  const rejected = text.includes("暂时无法核实这本书");
  const created = /第\s*1\s*阶段|阅读计划|章节|开始阅读/.test(text) && !rejected;
  result.steps = { login: "PASS", rejected, created, sample: text.replace(/\s+/g, " ").slice(0, 260) };
  result.status = rejected ? "FAIL" : created ? "PASS" : "OBSERVED";
  await page.screenshot({ path: `${EVID}/T-ICT-054-book.png`, fullPage: true });
  out(`book: rejected=${rejected} created=${created}`);
} catch (e) {
  result.status = "FAIL";
  result.error = e instanceof Error ? e.message : String(e);
  out(`FAIL: ${result.error}`);
} finally {
  await browser.close();
  fs.writeFileSync(`${EVID}/T-ICT-054-book.json`, JSON.stringify(result, null, 2));
}
process.exit(result.status === "PASS" ? 0 : 1);
