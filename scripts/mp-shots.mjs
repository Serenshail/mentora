/* 用 Chromium 给 preview/*.html 截图（目检 UI 用）
 * 用法：node scripts/mp-shots.mjs [page...]  → shots/<page>.png */
import { chromium } from "playwright-core";
import { mkdirSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PREVIEW = join(HERE, "..", "preview");
const SHOTS = join(HERE, "..", "shots");
const CHROME = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const W = 390;
const H = 844;

mkdirSync(SHOTS, { recursive: true });

const want = process.argv.slice(2);
const files = readdirSync(PREVIEW)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => !want.length || want.some((w) => f.includes(w)));

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2,
});
for (const f of files) {
  const name = basename(f, ".html");
  await page.goto("file:///" + join(PREVIEW, f).replace(/\\/g, "/"));
  await page.waitForTimeout(180);
  const full = await page.evaluate(() => document.body.scrollHeight);
  await page.screenshot({
    path: join(SHOTS, name + ".png"),
    fullPage: full > H + 40,
  });
  console.log("shot", name, `${W}x${full > H + 40 ? "full" : H}`);
}
await browser.close();
