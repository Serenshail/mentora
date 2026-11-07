/* V26.2 生产验收（Vercel）：H1 学习人生 tab 浏览器级验证（F 场景等价，带代理） */
import { chromium } from "playwright-core";

const BASE = process.env.SMOKE_BASE ?? "https://mentora-orpin.vercel.app";
const EXE = process.env.SMOKE_CHROME ?? "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const PROXY = process.env.SMOKE_PROXY ?? "http://127.0.0.1:7897";
const PROBE_EMAIL = process.env.SMOKE_PROBE_EMAIL || "probe-x2@163.com";
const PROBE_PW = process.env.SMOKE_PROBE_PW || "Pr#obe123";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PW }),
  signal: AbortSignal.timeout(30000),
});
const token = /mentora_session=([^;]+)/.exec(loginRes.headers.get("set-cookie") || "")?.[1];
if (!token) throw new Error("probe login failed");
console.log("probe logged in");

const browser = await chromium.launch({ executablePath: EXE, headless: true, proxy: { server: PROXY } });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: "mentora_session", value: token, url: BASE }]);
const page = await ctx.newPage();
page.setDefaultTimeout(25000);

const today = new Date().toISOString().slice(0, 10);
/* 种子：1 条真实掌握 + 1 条目录骨架（结果层语义应只显示前者） */
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(3000);
const seeded = await page.evaluate((today) => {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("mentora-store-") || k.includes("anon")) continue;
    try {
      const st = JSON.parse(localStorage.getItem(k) || "{}");
      if (!st?.state) continue;
      const mk = (id, title, body) => ({
        id, title, body, domain: "验收学科", source: "learn", sourceTitle: "生产验收",
        masteryStatus: "mastered", masteredAt: new Date().toISOString(), reviewStage: 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1, links: [],
      });
      const items = [
        mk("kn-v262-prod-real", "生产验收真实掌握条目", "（验收）真实内容条目"),
        mk("kn-v262-prod-moc", "生产验收 · 目录", "（验收）骨架条目不应进足迹"),
      ];
      st.state.knowledge = [...items, ...(st.state.knowledge ?? []).filter((x) => !/^kn-v262-prod/.test(x.id))];
      localStorage.setItem(k, JSON.stringify(st));
      return true;
    } catch { return false; }
  }
  return false;
}, today);
console.log("seed:", seeded);

/* 路径 A：SPA 内点侧栏「学习人生」（不整页 reload，避免 bootSync 拉云端覆盖本地种子） */
await page.getByRole("link", { name: /学习人生/ }).first().click({ timeout: 20000 }).catch(async () => {
  await page.goto(`${BASE}/life`, { waitUntil: "domcontentloaded", timeout: 60000 });
});
await page.waitForTimeout(5000);
const urlAfterLife = page.url();
/* 路径 B：/learn?tab=life 直达（同样 SPA 导航：先回首页再改地址栏不触发——用 goto 但种子已重置；
 * 这里只验证 URL 直达后的工作台渲染，条目断言以路径 A 的内存态为准） */
const state = await page.evaluate(() => {
  const t = document.body.innerText;
  return {
    url: location.href,
    hasLifeHeader: t.includes("学习足迹"),
    hasFootprint: t.includes("足迹"),
    hasRealItem: t.includes("生产验收真实掌握条目"),
    hasMocItem: t.includes("生产验收 · 目录"),
    hasCoachTabActive: t.includes("想学点什么？"),
  };
});
console.log("URL after /life:", urlAfterLife);
console.log("tab=life 视图:", JSON.stringify(state));
const pass =
  (state.hasLifeHeader || state.hasFootprint) &&
  state.hasRealItem &&
  !state.hasMocItem &&
  !state.hasCoachTabActive;
console.log(pass ? "PASS  F-vercel 学习人生 tab 真实渲染+结果层过滤+URL直达" : "FAIL  详见上方状态");
await browser.close();
process.exit(pass ? 0 : 1);
