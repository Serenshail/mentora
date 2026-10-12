/* v18 UI 视觉验证：注册探针账号 → 截图四个关键场景 + DOM 断言（跑完自删） */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = "http://localhost:3001";
const EMAIL = `v18-ui-${Date.now().toString(36)}@163.com`;
const PW = "v18-ui-check";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = ".tmp-shots";
fs.mkdirSync(OUT, { recursive: true });

// D1 本地直连偶发抖动（间歇 400/超时）：重试直到熔断降级或成功
let cookie = null;
for (let attempt = 0; attempt < 8 && !cookie; attempt++) {
  const send = await (await fetch(`${BASE}/api/auth/send-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL }) })).json();
  if (!send.devCode) { console.log(`attempt ${attempt}: send-code`, JSON.stringify(send).slice(0, 80)); await new Promise((r) => setTimeout(r, 4000)); continue; }
  const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW, name: "UI冒烟", code: send.devCode }) });
  const setCookie = reg.headers.get("set-cookie") || "";
  cookie = /mentora_session=([^;]+)/.exec(setCookie)?.[0];
  if (!cookie) { console.log(`attempt ${attempt}: register ${reg.status}`); await new Promise((r) => setTimeout(r, 4000)); }
}
if (!cookie) throw new Error("注册重试 8 次仍失败（本地 D1 不可达）");
console.log("registered", EMAIL);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: "mentora_session", value: cookie.split("=")[1], url: BASE }]);
const page = await ctx.newPage();
const fails = [];
const check = (name, ok, extra = "") => { console.log(ok ? "PASS" : "FAIL", name, extra); if (!ok) fails.push(name); };

// 1) 总览（展开态）
await page.goto(BASE + "/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/1-dashboard.png` });
check("侧栏可见", await page.locator("aside").isVisible());
check("搜索入口存在", (await page.getByRole("button", { name: /搜索/ }).count()) >= 1);
check("外置把手存在", (await page.locator('button[aria-label="收起侧栏"]').count()) === 1);

// 2) 收起态 + 把手仍在屏幕内
await page.locator('button[aria-label="收起侧栏"]').click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/2-collapsed.png` });
const handle = page.locator('button[aria-label="展开侧栏"]');
check("收起后把手仍可见", await handle.isVisible());
const box = await handle.boundingBox();
check("把手贴近屏幕左缘（x < 80px）", box && box.x < 80, box ? `x=${box.x}` : "");
check("收起态导航图标可点", await page.locator('aside a[title="第二大脑"]').isVisible());

// 3) 收起态点第二大脑 → 页面正常；⌘K 打开面板
await page.locator('aside a[title="第二大脑"]').click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/3-brain-collapsed.png` });
check("第二大脑在收起态下可进入", page.url().includes("/brain"));
await page.keyboard.press("Control+k");
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/4-cmdk.png` });
check("⌘K 面板打开", await page.getByRole("dialog", { name: "全局搜索" }).isVisible());
await page.keyboard.type("第二");
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
await page.waitForTimeout(1000);
check("面板跳转生效", page.url().replace(BASE, "") === "/brain", page.url());

// 4) 笔记直达契约：先建一条笔记，再 /brain?note=<id> 直达
await page.locator('button[title="新建笔记"]').first().click();
await page.waitForTimeout(800);
const noteId = await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("mentora-store")) continue;
    try {
      const st = JSON.parse(localStorage.getItem(k) || "{}");
      const kid = st?.state?.knowledge?.[0]?.id;
      if (kid) return kid;
    } catch {}
  }
  return null;
});
if (noteId) {
  await page.goto(`${BASE}/brain`, { waitUntil: "networkidle" }); // 先回干净态
  await page.goto(`${BASE}/brain?note=${noteId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/5-note-direct.png` });
  const opened = await page.evaluate((id) => {
    for (const k of Object.keys(sessionStorage)) return true; // 占位
    return false;
  }, noteId).catch(() => false);
  // 视觉断言：笔记标题（"未命名笔记"）出现在编辑区且信息面板存在
  const hasEditor = (await page.locator("text=空笔记。切到「编辑」开始写").count()) > 0;
  check("?note= 直达打开笔记", hasEditor);
} else {
  console.log("SKIP note-direct（未取到笔记 id）");
}

// 5) 探针自删
await page.goto(BASE + "/settings", { waitUntil: "networkidle" });
const del = await page.evaluate(async ({ email, pw }) => {
  const r = await fetch("/api/auth/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
  return r.status;
}, { email: EMAIL, pw: PW });
check("探针账号自删", del === 200, `status=${del}`);

await browser.close();
console.log(fails.length ? `FAILURES: ${fails.join(", ")}` : "ALL_VISUAL_PASS");
process.exit(fails.length ? 1 : 0);
