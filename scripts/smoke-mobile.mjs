/* 移动端冒烟（docs/PRD-2026-10-26-MOBILE-UI §10.1）：
 * 注册探针账号 → 320/375/390/412 多 viewport → 几何/导航/命中盒/sheet 断言 + 截图 → 自删。
 * 覆盖 M1（5+更多导航）、M2（横向溢出/固定层）、M3（44px 命中盒）的可自动化子集。
 * 用法：node scripts/smoke-mobile.mjs（需本地 dev/build server 跑在 3001；D1 抖动有注册重试） */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3001";
const EMAIL = `mob-smoke-${Date.now().toString(36)}@163.com`;
const PW = "Mob#smoke221";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = ".tmp-shots-mobile";
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "xs-320x667", width: 320, height: 667 },
  { name: "sm-375x812", width: 375, height: 812 },
  { name: "md-390x844", width: 390, height: 844 },
  { name: "lg-412x915", width: 412, height: 915 },
];

const fails = [];
const check = (name, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) fails.push(name);
};

/* ---- 探针注册（邀请码通道；D1 抖动重试兜底，同 ui-visual-check 先例） ---- */
let cookie = null;
for (let attempt = 0; attempt < 8 && !cookie; attempt++) {
  try {
    const send = await (await fetch(`${BASE}/api/auth/send-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL }) })).json();
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PW, name: "移动冒烟", ...(send.inviteRequired ? {} : {}), ...(send.devCode ? { code: send.devCode } : {}) }),
    });
    const setCookie = reg.headers.get("set-cookie") || "";
    cookie = /mentora_session=([^;]+)/.exec(setCookie)?.[0];
    if (cookie) break;
    // dev 通道关了验证码：尝试邀请码
    let inviteCode = "";
    try {
      inviteCode = fs.readFileSync(".env.local", "utf8").split(/\r?\n/).find((l) => l.startsWith("INVITE_CODE="))?.slice(12).trim() || "";
    } catch {}
    if (inviteCode) {
      const reg2 = await fetch(`${BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PW, name: "移动冒烟", inviteCode }),
      });
      cookie = /mentora_session=([^;]+)/.exec(reg2.headers.get("set-cookie") || "")?.[0];
    }
  } catch {}
  if (!cookie) { console.log(`register attempt ${attempt} failed`); await new Promise((r) => setTimeout(r, 4000)); }
}
if (!cookie) throw new Error("注册重试 8 次仍失败");
console.log("registered", EMAIL);

const browser = await chromium.launch({ executablePath: EXE, headless: true });

/* 逐 viewport 跑同一组断言 */
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true });
  await ctx.addCookies([{ name: "mentora_session", value: cookie.split("=")[1], url: BASE }]);
  const page = await ctx.newPage();
  const tag = vp.name;

  try {
    /* ---- M2-1：总览无横向溢出 ----
     * dev 首编译 + 客户端水合竞态：固定 sleep 会间歇性在骨架屏期断言（假 FAIL）。
     * 一律 waitForSelector 等关键 UI 出现（终态轮询，同圆桌冒烟纪律）。 */
    const gotoApp = async (path, waitSel, ms = 20000) => {
      await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(waitSel, { timeout: ms }).catch(() => {});
      await page.waitForTimeout(400); // 水合余量
    };
    await gotoApp("/", "nav.sticky.bottom-0");
    await page.screenshot({ path: `${OUT}/${tag}-dashboard.png` });
    const geom = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    check(`${tag} M2-1 无横向溢出`, geom.scrollW <= geom.innerW, `scrollW=${geom.scrollW} innerW=${geom.innerW}`);

    /* ---- M1-1：5 主入口一击可达 ---- */
    const nav = page.locator("nav.sticky.bottom-0");
    const navVisible = await nav.isVisible().catch(() => false);
    check(`${tag} M1-1 底栏渲染`, navVisible);
    const navLinks = ["总览", "学习教练", "第二大脑", "读书伙伴", "人生伙伴"];
    for (const label of navLinks) {
      const cnt = navVisible ? await nav.getByText(label, { exact: true }).count() : 0;
      check(`${tag} M1-1 底栏入口「${label}」`, cnt >= 1, `count=${cnt}`);
    }
    check(`${tag} M1-1 底栏有「更多」`, navVisible ? (await nav.getByText("更多", { exact: true }).count()) >= 1 : false);

    /* ---- M1-2：更多抽屉可达学习人生/设置；抽屉内入口一击跳转 ---- */
    if (navVisible) {
      await nav.getByText("更多", { exact: true }).click();
      await page.waitForSelector("[role=dialog][aria-label='更多']", { timeout: 8000 }).catch(() => {});
      await page.screenshot({ path: `${OUT}/${tag}-more-drawer.png` });
      const drawer = page.locator("[role=dialog][aria-label='更多']");
      check(`${tag} M1-2 抽屉打开`, await drawer.isVisible());
      check(`${tag} M1-2 抽屉含「学习人生」`, (await drawer.getByText("学习人生").count()) >= 1);
      check(`${tag} M1-2 抽屉含「设置」`, (await drawer.getByText("设置", { exact: true }).count()) >= 1);
      await drawer.getByText("设置", { exact: true }).click();
      await page.waitForURL("**/settings", { timeout: 15000 });
      await page.waitForTimeout(600);
      check(`${tag} M1-2 抽屉跳转设置`, page.url().includes("/settings"));
      check(`${tag} M1-2 跳转后抽屉收起`, (await page.locator("[role=dialog][aria-label='更多']").count()) === 0);
    } else {
      check(`${tag} M1-2 抽屉打开`, false, "底栏未渲染");
    }

    /* ---- M2-1：设置页无横向溢出 + 逐页扫 ---- */
    const settingsGeom = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
    check(`${tag} M2-1 设置页无横向溢出`, settingsGeom.s <= settingsGeom.i, `${settingsGeom.s}/${settingsGeom.i}`);

    for (const path of ["/learn", "/brain", "/read", "/council", "/life"]) {
      await gotoApp(path, "nav.sticky.bottom-0");
      const g = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, i: window.innerWidth }));
      check(`${tag} M2-1 ${path} 无横向溢出`, g.s <= g.i, `${g.s}/${g.i}`);
      if (path === "/brain") await page.screenshot({ path: `${OUT}/${tag}-brain.png` });
      if (path === "/council") await page.screenshot({ path: `${OUT}/${tag}-council.png` });
    }

    /* ---- M1-4：学习详情任务导航折叠（先借总览「示例目标」seed 一条） ---- */
    await gotoApp("/", "nav.sticky.bottom-0");
    const seedBtn = page.getByRole("button", { name: /用示例目标试一试/ });
    if ((await seedBtn.count()) >= 1) {
      await seedBtn.click(); // 点击后跳到 /learn/<id>
      await page.waitForTimeout(1500);
    }
    await gotoApp("/learn", ".card-lift", 15000);
    const hasGoal = (await page.getByText("天完成").count()) > 0;
    if (hasGoal) {
      /* 点目标卡本身（Card 的 onClick 路由）；card-lift 是目标的 hover 类，加文本限定避免误点其它元素 */
      await page.locator(".card-lift").filter({ hasText: "天完成" }).first().click();
      await page.waitForTimeout(1200);
      const navBtn = page.getByText("任务导航");
      check(`${tag} M1-4 任务导航条可见`, (await navBtn.count()) >= 1, `url=${page.url().replace(BASE, "")}`);
      if ((await navBtn.count()) >= 1) {
        await navBtn.first().click();
        await page.waitForTimeout(400);
        check(`${tag} M1-4 展开后时间线可见`, (await page.getByText("路径设计").count()) >= 1);
        await page.screenshot({ path: `${OUT}/${tag}-learn-nav-open.png` });
      }
      await page.goto(BASE + "/learn", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
    } else {
      console.log(`SKIP ${tag} M1-4（无学习目标）`);
    }

    /* ---- M3-1：底栏入口命中盒 ≥44px（回 /learn 干净页后再量） ---- */
    await gotoApp("/learn", "nav.sticky.bottom-0");
    const tapBoxes = await page.evaluate(() => {
      const nav = [...document.querySelectorAll("nav")].find((n) => typeof n.className === "string" && n.className.includes("bottom-0"));
      if (!nav) return null;
      return [...nav.querySelectorAll("a, button")].map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.textContent?.trim().slice(0, 6), h: Math.round(r.height), w: Math.round(r.width) };
      });
    });
    if (tapBoxes && tapBoxes.length > 0) {
      const tooShort = tapBoxes.filter((b) => b.h < 44);
      check(`${tag} M3-1 底栏命中盒 ≥44px`, tooShort.length === 0, JSON.stringify(tooShort));
    } else {
      check(`${tag} M3-1 底栏存在`, false);
    }

    /* ---- M2-2：移动顶栏存在且在视口内 ---- */
    const headerBox = await page.evaluate(() => {
      const h = document.querySelector("header");
      if (!h) return null;
      const r = h.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });
    check(`${tag} M2-2 顶栏在视口内`, !!headerBox && headerBox.top >= -1 && headerBox.bottom <= headerBox.vh + 1, JSON.stringify(headerBox));
  } catch (e) {
    fails.push(`${tag} EXCEPTION: ${e.message}`);
    console.log(`${tag} EXCEPTION`, e.message);
    await page.screenshot({ path: `${OUT}/${tag}-error.png`, fullPage: true }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

/* ---- 桌面回归：1440×900 侧栏仍在（M0-2） ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "mentora_session", value: cookie.split("=")[1], url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("aside", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  check("desktop 侧栏可见", await page.locator("aside").isVisible());
  check("desktop 无移动底栏", (await page.locator("nav.sticky.bottom-0").count()) === 0 || !(await page.locator("nav.sticky.bottom-0").first().isVisible().catch(() => false)));
  await ctx.close();
}

/* ---- 探针自删（finally 纪律） ---- */
try {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "mentora_session", value: cookie.split("=")[1], url: BASE }]);
  const res = await ctx.request.delete(`${BASE}/api/auth/account`, { data: { password: PW } });
  console.log("probe deleted:", res.status());
  await ctx.close();
} catch (e) {
  console.log("probe delete failed:", e.message);
}
await browser.close();

console.log(fails.length === 0 ? "\nALL MOBILE PASS ✅" : `\nFAILED (${fails.length}):\n- ${fails.join("\n- ")}`);
process.exit(fails.length === 0 ? 0 : 1);
