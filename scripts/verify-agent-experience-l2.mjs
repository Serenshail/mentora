/* ============================================================
 * L2 真实浏览器验收（PRD docs/agent-experience-prd-2026-11-11）
 *
 * 覆盖：U01 / U02 / U03 / U09 / U10 / S01 / S02 / U13（+三宽度截图）
 * 模型通道用**可控 mock 流**（EVIDENCE-CONTRACT §3 允许：模拟 LLM 可验证隔离与错误路径）：
 * 请求被按住不放，直到脚本显式释放——这样才能真正构造「A 在跑、B 也发」的重叠区间。
 * 本脚本不消耗任何真实模型请求（L3 另行登记预算）。
 *
 * 用法：BASE=http://localhost:3011 node scripts/verify-agent-experience-l2.mjs
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3011";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = process.env.OUT || "docs/agent-experience-prd-2026-11-11/evidence/run-2026-11-11-a";
const SHOTS = path.join(OUT, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const rec = (id, name, ok, detail = "") => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? `  :: ${detail}` : ""}`);
};

/* ---------- 可控 mock 流 ---------- */
let chatCalls = 0;
const held = []; // { n, lines, release() , url }
function ndjson(lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const b = await chromium.launch({
  executablePath: EXE,
  headless: true,
  ...(process.env.PW_PROXY ? { proxy: { server: process.env.PW_PROXY } } : {}),
});
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();

const LONG = (n) => [
  { t: "d", v: `回答${n}开始。\n\n` },
  ...Array.from({ length: 30 }, (_, i) => ({ t: "d", v: `第 ${i + 1} 行说明内容，用于撑出可滚动高度。\n\n` })),
  { t: "end" },
];
/* 第 1 个请求自动放行并返回「正文 + 一个只读工具调用」：让本轮继续发第 2 个请求
 * （也就是真实的多轮链路），这样「流式途中上翻、后续 delta 不抢回底」才有可测的时间线。 */
const TOOLROUND = [
  { t: "d", v: "先看看你的笔记。\n\n" },
  ...Array.from({ length: 40 }, (_, i) => ({ t: "d", v: `准备阶段第 ${i + 1} 行，这是一段比较长的过渡正文。\n\n` })),
  { t: "d", v: "```tool\n" + JSON.stringify({ name: "search_brain", args: { query: "L2 冒烟" } }) + "\n```" },
  { t: "end" },
];

await page.route("**/api/chat", async (route) => {
  chatCalls++;
  const n = chatCalls;
  let releaseFn;
  const gate = new Promise((r) => (releaseFn = r));
  const entry = { n, url: route.request().url(), body: route.request().postData() };
  const h = { ...entry, release: releaseFn };
  held.push(h);
  const t0 = Date.now();
  if (n === 1) {
    await new Promise((r) => setTimeout(r, 300)); // 模拟首轮耗时，随后自动放行
    releaseFn();
  }
  await gate;
  h.heldMs = Date.now() - t0;
  h.releasedAt = new Date().toISOString();
  await route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
    body: ndjson(n === 1 ? TOOLROUND : LONG(n)),
  });
});

const releaseAll = () => {
  for (const h of held) h.release();
};

/* ---------- bootstrap：管理员开码 → 注册新鲜账号 ---------- */
console.log("bootstrap: mint + register…");
const env = fs.readFileSync(".env.local", "utf8");
const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
const email = `l2-agent-${Date.now().toString(36)}@163.com`;
const password = "L2#agent" + Math.random().toString(36).slice(2, 8);
const gen = await (
  await fetch(`${BASE}/api/admin/licenses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-password": adminPw },
    body: JSON.stringify({ count: 1, days: 30 }),
    signal: AbortSignal.timeout(30000),
  })
).json();
if (!gen.codes?.[0]) throw new Error(`开码失败: ${JSON.stringify(gen).slice(0, 160)}`);
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "L2 验收", inviteCode: gen.codes[0] }),
  signal: AbortSignal.timeout(30000),
});
const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
if (!tok) throw new Error(`注册失败 status=${reg.status}`);
await ctx.addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
console.log(`bootstrap ok: ${email}`);

/* ---------- 预热：dev server 对 /api/chat 是按需编译的，首条请求可能卡在
 * 路由编译上，把「请求数」断言的时间线全打乱。先打一发让它编译完（不带登录态，
 * 401 即可，浏览器路由 mock 不拦截 node fetch，不计入 chatCalls）。 ---------- */
await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
}).catch(() => {});

/* ---------- 首页 ---------- */
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(5000);

const composer = page.locator('input[aria-label="给智能体发消息"]');
const mainBtn = () => page.locator('button[aria-label="发送消息"], button[aria-label="停止当前回答"]');
const log = page.locator('[role="log"][aria-label="对话消息"]');

/* ===== U01：同位发送/停止按钮 ===== */
const empty = await mainBtn().first().getAttribute("aria-label");
const emptyDisabled = await mainBtn().first().isDisabled();
rec("U01-a", "空闲无内容：主按钮是发送且不可用", empty === "发送消息" && emptyDisabled, `label=${empty} disabled=${emptyDisabled}`);

await composer.fill("给我讲一下 Python 的列表推导式");
const filledLabel = await mainBtn().first().getAttribute("aria-label");
const filledDisabled = await mainBtn().first().isDisabled();
rec("U01-b", "有内容：主按钮可发送", filledLabel === "发送消息" && !filledDisabled, `label=${filledLabel} disabled=${filledDisabled}`);

const boxBefore = await mainBtn().first().boundingBox();

await mainBtn().first().click();
await page.waitForTimeout(600);
const runLabel = await mainBtn().first().getAttribute("aria-label");
const boxAfter = await mainBtn().first().boundingBox();
const sameSpot =
  !!boxBefore && !!boxAfter && Math.abs(boxBefore.x - boxAfter.x) < 1.5 && Math.abs(boxBefore.y - boxAfter.y) < 1.5;
rec("U01-c", "运行中同一按钮变为停止（同位、非下方小字）", runLabel === "停止当前回答" && sameSpot, `label=${runLabel} sameSpot=${sameSpot}`);

const bb = boxAfter ?? { width: 0, height: 0 };
rec("U01-d", "主按钮点击区 ≥44×44", bb.width >= 44 && bb.height >= 44, `${Math.round(bb.width)}×${Math.round(bb.height)}`);

/* ===== U09：发送强制回底 ===== */
const scrollState = await log.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight }));
rec("U09-a", "发送后消息容器回到最新", scrollState.h - scrollState.top - scrollState.c < 90, JSON.stringify(scrollState));

/* ===== U03：运行中草稿保留、Enter 不提交第二个任务 ===== */
await composer.fill("这是运行中打的草稿");
const callsBeforeEnter = chatCalls;
await composer.press("Enter");
await page.waitForTimeout(500);
const draftKept = await composer.inputValue();
rec(
  "U03-a",
  "运行中：草稿保留、Enter 不提交第二个任务",
  draftKept === "这是运行中打的草稿" && chatCalls === callsBeforeEnter,
  `draft="${draftKept}" chatCalls ${callsBeforeEnter}→${chatCalls}`
);
const stillStop = await mainBtn().first().getAttribute("aria-label");
rec("U03-b", "运行中不会被草稿顶回发送态", stillStop === "停止当前回答", `label=${stillStop}`);

/* ===== S01/S02：切到会话 B，A 继续在跑 ===== */
const runTabCount = await page.locator('[aria-label="正在生成"]').count();
rec("S02-a", "A 的会话 tab 上有运行标记", runTabCount >= 1, `count=${runTabCount}`);

await page.locator('button[title="开始一段新对话"]').click();
await page.waitForTimeout(500);
const logCountInB = await log.count();
const bBtnLabel = await mainBtn().first().getAttribute("aria-label");
const bBtnDisabled = await mainBtn().first().isDisabled();
const bInputDisabled = await composer.isDisabled();
rec(
  "S02-b",
  "切到会话 B：不显示 A 的运行态、输入框可用",
  logCountInB === 0 && bBtnLabel === "发送消息" && bBtnDisabled && !bInputDisabled,
  `logBlocks=${logCountInB} label=${bBtnLabel} disabled=${bBtnDisabled} inputDisabled=${bInputDisabled}`
);

await composer.fill("B 会话的第二个问题");
await page.waitForTimeout(100);
await composer.press("Enter");
await page.waitForTimeout(600);
rec("S01-a", "B 可发送（未被 A 的全局 busy 拦住）", chatCalls >= 2, `chatCalls=${chatCalls}`);
const openNow = held.filter((h) => h.releasedAt === undefined).length;
rec("S01-b", "两个会话的请求真实重叠（同时挂在上游）", openNow >= 2, `held=${held.length} 同时在途=${openNow}`);

const runningTabs = await page.locator('[aria-label="正在生成"]').count();
rec("S01-c", "两个会话 tab 同时显示运行标记（真并发）", runningTabs >= 2, `count=${runningTabs}`);

/* ===== U02：停止 B（200ms 内反馈、2s 内解除忙碌；A 不受影响） ===== */
const stopProbe = await page.evaluate(async () => {
  const btn = document.querySelector('button[aria-label="停止当前回答"]');
  if (!btn) return { seen: null, ms: -1, note: "找不到停止按钮" };
  const t0 = performance.now();
  btn.click();
  return await new Promise((resolve) => {
    const tick = () => {
      const stopping = document.body.innerText.includes("正在停止");
      const released = !!document.querySelector('button[aria-label="发送消息"]');
      if (stopping || released) return resolve({ seen: stopping ? "正在停止" : "已解除忙碌", ms: performance.now() - t0 });
      if (performance.now() - t0 > 3000) return resolve({ seen: null, ms: -1, note: "3s 内没有可观测反馈" });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
});
rec(
  "U02-a",
  "点停止 200ms 内有可观测反馈",
  stopProbe.ms >= 0 && stopProbe.ms <= 200,
  `第一次反馈=${stopProbe.seen} @ ${Math.round(stopProbe.ms)}ms${stopProbe.note ? ` (${stopProbe.note})` : ""}`
);
const busyReleased = await page
  .waitForFunction(() => !!document.querySelector('button[aria-label="发送消息"]'), null, { timeout: 3000 })
  .then(() => true)
  .catch(() => false);
rec("U02-b", "停止后 2s 内回到发送态（本地忙碌锁解除）", busyReleased, `waitForFunction<=3000ms`);

const aStillRunning = await page.locator('[aria-label="正在生成"]').count();
rec("U02-c", "停止 B 不影响 A（A 仍在跑）", aStillRunning >= 1, `running tabs=${aStillRunning}`);

/* ===== U10：上翻退出跟随 + 新内容不抢回底 ===== */
await page.setViewportSize({ width: 1280, height: 700 });
/* 切回 A（点 A 的会话 tab；不能用 aria-current 选，那只命中当前会话 B） */
await page.getByRole("button", { name: /列表推导式/ }).first().click();
await page.waitForTimeout(600);
const canScroll = await log.evaluate((el) => el.scrollHeight - el.clientHeight > 40);
if (canScroll) {
  await log.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const backToLatest = await page.locator("text=回到最新").count();
  rec("U10-a", "主动上翻后出现「回到最新」", backToLatest > 0, `count=${backToLatest}`);
  releaseAll();
  await page.waitForTimeout(1500);
  const after = await log.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight }));
  rec(
    "U10-b",
    "上翻状态下新内容到达不强制回底",
    after.h - after.top - after.c > 90 || after.h - after.c <= 40,
    JSON.stringify(after)
  );
  await page.locator("text=回到最新").first().click();
  await page.waitForTimeout(400);
  const back = await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  rec("U10-c", "点「回到最新」恢复跟随", back < 90, `距底=${Math.round(back)}`);
} else {
  const dbg = await log.evaluate((el) => ({ h: el.scrollHeight, c: el.clientHeight, top: el.scrollTop, blocks: el.children.length, txt: (el.innerText || "").slice(0, 80) }));
  rec("U10-a", "主动上翻后出现「回到最新」", false, `场景未构成 ${JSON.stringify(dbg)}`);
  rec("U10-b", "上翻状态下新内容到达不强制回底", false, "场景未构成");
  rec("U10-c", "点「回到最新」恢复跟随", false, "场景未构成");
  releaseAll();
  await page.waitForTimeout(1200);
}

/* ===== U13：设置页与学习详情页的固定返回条 ===== */
for (const w of [390, 1280, 1440]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  const bar = page.locator('[data-testid="page-back"]').first();
  const vis = await bar.isVisible().catch(() => false);
  const inView = await bar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight && r.height >= 20;
  }).catch(() => false);
  await page.screenshot({ path: path.join(SHOTS, `backbar-settings-${w}.png`) });
  rec(`U13-settings-${w}`, `${w}px 设置页滚到底：返回条仍可见可点`, vis && inView, `visible=${vis} inView=${inView}`);
}

/* 学习详情页需要一条计划目标：先注入再进详情页 */
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
const goal = {
  id: "goal-python-l2",
  topic: "Python",
  direction: "文件处理",
  motivation: "想把日常脚本写好",
  status: "active",
  createdAt: new Date().toISOString(),
  quizLog: [],
  successCriteria: ["能独立写文件处理脚本"],
  plan: {
    summary: "从基础语法到文件与数据处理",
    totalDays: 4,
    weeklyHours: 3,
    startDate: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    phases: [
      { id: "phase-basics", title: "第一阶段 语法基础", outcome: "能写简单脚本", dayIds: ["d1"], status: "active", catalog: [{ id: "d1", title: "变量与类型", knowledgePoints: ["int/str"] }], estDays: 2 },
      { id: "phase-files", title: "第二阶段 文件读写", outcome: "能读写文件", dayIds: ["d2", "d3"], status: "locked", catalog: [{ id: "d2", title: "打开与关闭", knowledgePoints: ["open"] }, { id: "d3", title: "异常处理", knowledgePoints: ["try"] }], estDays: 2 },
    ],
    days: {
      d1: { id: "d1", phaseId: "phase-basics", title: "变量与类型", knowledgePoints: [{ id: "kp1", text: "int/str" }], resources: [], method: "讲解+练习", acceptance: [], status: "passed", attempts: 1 },
      d2: { id: "d2", phaseId: "phase-files", title: "打开与关闭", knowledgePoints: [{ id: "kp2", text: "open" }], resources: [], method: "讲解+练习", acceptance: [], status: "locked", attempts: 0 },
      d3: { id: "d3", phaseId: "phase-files", title: "异常处理", knowledgePoints: [{ id: "kp3", text: "try" }], resources: [], method: "讲解+练习", acceptance: [], status: "locked", attempts: 0 },
    },
  },
};
await page.evaluate((g) => {
  const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
  const raw = JSON.parse(localStorage.getItem(key) || "{}");
  raw.state = raw.state || {};
  raw.state.goals = [g];
  localStorage.setItem(key, JSON.stringify(raw));
  window.__mentoraStore?.setState?.({ goals: [g] });
}, goal);
await page.waitForTimeout(1200);

for (const w of [390, 1440]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(`${BASE}/learn/goal-python-l2`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
  const hasTitle = (await page.locator("text=Python").count()) > 0;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  const bar = page.locator('[data-testid="page-back"]').first();
  const vis = await bar.isVisible().catch(() => false);
  const inView = await bar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  }).catch(() => false);
  await page.screenshot({ path: path.join(SHOTS, `backbar-learn-${w}.png`), fullPage: false });
  rec(`U13-learn-${w}`, `${w}px 学习详情滚到底：返回条仍可见可点`, hasTitle && vis && inView, `pageOk=${hasTitle} visible=${vis} inView=${inView}`);
}

releaseAll();
await page.waitForTimeout(800);

/* ---------- 汇总 ---------- */
const pass = results.filter((r) => r.ok).length;
fs.writeFileSync(
  path.join(OUT, "l2-agent-experience.json"),
  JSON.stringify(
    { ranAt: new Date().toISOString(), base: BASE, chatCallsMocked: chatCalls, realModelRequests: 0, pass, total: results.length, results },
    null,
    2
  )
);
console.log(`\n==== L2 汇总：${pass}/${results.length} PASS（mock 请求 ${chatCalls} 次，真实模型请求 0 次）====`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL ${r.id} ${r.name} :: ${r.detail}`);
await b.close();
process.exit(0);
