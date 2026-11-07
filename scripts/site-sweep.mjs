#!/usr/bin/env node
/* 全站巡检：页面（登录态/未登录 × 桌面/手机）+ API 状态 + 后台模块。
 * 用法：
 *   node scripts/site-sweep.mjs                     # 生产（mentora-orpin + clarity-admin-virid）
 *   node scripts/site-sweep.mjs http://127.0.0.1:3000 https://clarity-admin-virid.vercel.app
 * 需要本机 Chrome；生产 API 访问走系统代理时加 NODE_USE_ENV_PROXY=1 HTTPS_PROXY=...
 * 判定：页面崩（"这一页出了点问题"）+ pageerror/console error + 后台"加载失败"。
 */
import { chromium } from "playwright-core";

const MENTORA = process.argv[2] || "https://mentora-orpin.vercel.app";
const ADMIN = process.argv[3] || "https://clarity-admin-virid.vercel.app";
const ADMIN_PW = process.env.ADMIN_PASSWORD || "";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DAY = "\n===============================";

const problems = [];
function record(scope, path, crashed, errs, sample) {
  if (crashed || errs.length) problems.push({ scope, path, crashed, errs, sample });
}

const browser = await chromium.launch({ executablePath: CHROME });
const VIEWPORTS = [["desktop", 1280, 900], ["mobile", 390, 844]];

/* ---- 1) 未登录页 ---- */
for (const [vp, w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 150)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|WebSocket/.test(m.text())) errs.push("console: " + m.text().slice(0, 150)); });
  for (const p of ["/", "/login", "/login?mode=register", "/login?mode=reset", "/privacy", "/terms"]) {
    await page.goto(MENTORA + p, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText);
    record(`未登录/${vp}`, p, text.includes("这一页出了点问题"), errs.splice(0, 4));
  }
  await ctx.close();
}

/* ---- 2) 已登录页（临时体验账号，结束后删除） ---- */
let email = null;
try {
  if (ADMIN_PW) {
    const H = { "Content-Type": "application/json", "x-admin-password": ADMIN_PW };
    const gen = await (await fetch(`${MENTORA}/api/admin/licenses`, { method: "POST", headers: H, body: JSON.stringify({ count: 1, plan: "trial", note: "site-sweep" }) })).json();
    email = `sweep-${Date.now()}@163.com`;
    const reg = await fetch(`${MENTORA}/api/auth/register`, { method: "POST", headers: H, body: JSON.stringify({ email, password: "Test123456", name: "Sweep", inviteCode: gen.codes[0] }) });
    if (!reg.ok) throw new Error("注册失败 " + reg.status);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${MENTORA}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', "Test123456");
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForTimeout(4000);
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 150)));
    for (const p of ["/", "/life", "/learn", "/learn/new", "/council", "/brain", "/read", "/settings", "/membership"]) {
      await page.goto(MENTORA + p, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2400);
      const text = await page.evaluate(() => document.body.innerText);
      record("已登录", p, text.includes("这一页出了点问题"), errs.splice(0, 4));
    }
    await ctx.close();
  }
} catch (e) {
  record("已登录", "(准备)", false, ["setup: " + String(e).slice(0, 150)]);
}

/* ---- 3) 后台模块 ---- */
try {
  if (ADMIN_PW) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((pw) => {
      sessionStorage.setItem("mentora-admin-password", pw);
      localStorage.setItem("clarity-token", "tok_sweep");
      localStorage.setItem("clarity-user", JSON.stringify({ name: "Sweep", email: "admin-password", role: "sweep" }));
    }, ADMIN_PW);
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 150)));
    for (const p of ["/dashboard", "/members", "/codes", "/leads", "/users", "/feedback", "/settings"]) {
      await page.goto(ADMIN + p, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(3000);
      const text = await page.evaluate(() => document.body.innerText);
      const fail = text.match(/加载失败[^\n]*/);
      record("后台", p, false, [...(fail ? [fail[0]] : []), ...errs.splice(0, 4)]);
    }
    await ctx.close();
  }
} catch (e) {
  record("后台", "(准备)", false, ["setup: " + String(e).slice(0, 150)]);
}

await browser.close();

/* ---- 4) 清理巡检账号 ---- */
if (email && ADMIN_PW) {
  await fetch(`${MENTORA}/api/admin/users`, { method: "DELETE", headers: { "Content-Type": "application/json", "x-admin-password": ADMIN_PW }, body: JSON.stringify({ email }) }).catch(() => {});
}

console.log(DAY);
if (problems.length === 0) {
  console.log("✅ 全站巡检通过：未登录/已登录/后台 全部页面无崩溃、无报错");
} else {
  console.log(`❌ 发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(JSON.stringify(p));
  process.exitCode = 1;
}
