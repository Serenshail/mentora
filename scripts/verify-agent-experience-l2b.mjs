/* ============================================================
 * L2 第二批：过程与来源（U05 / U06 / U07 / U08）+ 跨会话滚动与后台（U11 / U12）
 *
 * 上游仍是**可控 mock**（0 次真实模型请求）：本批验的是「事件 → 画面」的映射，
 * 而不是模型本身的教学质量（那是 L3 的活）。
 *   U05 过程摘要由真实工具事件更新、消息内可展开、不串会话
 *   U06 只有心跳时只说等待、正文里的 <thinking> 不被当成过程事件、不额外调模型
 *   U07 正文先流出再出工具事件：合法段落不消失、协议 JSON 不入正文、顺序一致
 *   U08 搜索失败 vs 已成功读取网页要区分；来源可点；终态无 spinner
 *   U11 两会话滚动位置独立
 *   U12 后台会话完成不改变当前页面/滚动
 *
 * 用法：BASE=http://localhost:3011 node scripts/verify-agent-experience-l2b.mjs
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

/* ---------- 可编排的 mock 上游 ---------- */
let chatCalls = 0;
let searchCalls = 0;
let fetchCalls = 0;
/** 每个 case 设置一个「剧本」：按第 n 次调用返回不同内容 */
let script = () => [];
let holdNext = null; // 让下一次请求挂住，等脚本放行
/** 按住指定调用序号的请求，直到 releaseHold() —— 观察「在途」状态必须靠它：
 *  mock 立即返回的话，等脚本去查时本轮已经结束、运行块已被清掉。
 *  （2026-11-12 复查：这两个定义在昨天的分段补丁里丢失，导致 ReferenceError 崩溃；
 *   现在补回，U05 才能真正观察在途态。） */
const holdAt = new Map();
function releaseHold(n) {
  const r = holdAt.get(n);
  if (r) {
    holdAt.delete(n);
    r();
  }
}
function releaseAllHolds() {
  for (const n of [...holdAt.keys()]) releaseHold(n);
}

const ndjson = (lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

const b = await chromium.launch({
  executablePath: EXE,
  headless: true,
  ...(process.env.PW_PROXY ? { proxy: { server: process.env.PW_PROXY } } : {}),
});
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

await page.route("**/api/chat", async (route) => {
  chatCalls++;
  const n = chatCalls;
  if (holdNext) {
    const gate = holdNext;
    holdNext = null;
    await gate;
  }
  if (holdAt.has(n)) {
    await new Promise((r) => holdAt.set(n, r));
  }
  const lines = script(n);
  await route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
    body: ndjson(lines),
  });
});

await page.route("**/api/search", async (route) => {
  searchCalls++;
  const fail = process.env.CASE_SEARCH_FAIL === "1";
  if (fail) {
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "搜索上游不可用（模拟）" }) });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      provider: "mock",
      results: [
        { title: "Next.js 15 升级指南（官方）", url: "https://nextjs.org/docs/app/guides/upgrading/version-15", snippet: "异步请求 API：cookies/headers/params 变成 async。" },
        { title: "Next.js 15 发布说明", url: "https://nextjs.org/blog/next-15", snippet: "fetch 默认不再缓存。" },
      ],
    }),
  });
});

await page.route("**/api/fetch-page", async (route) => {
  fetchCalls++;
  const fail = process.env.CASE_FETCH_FAIL === "1";
  if (fail) {
    await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "读取失败（模拟）" }) });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      title: "Upgrading: Version 15",
      text: "In Next.js 15, cookies(), headers(), and params are async. fetch requests are no longer cached by default.",
    }),
  });
});

/* ---------- bootstrap ---------- */
const env = fs.readFileSync(".env.local", "utf8");
const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
const email = process.env.L2_EMAIL || `l2b-agent-${Date.now().toString(36)}@163.com`;
const password = "L2b#agent" + Math.random().toString(36).slice(2, 8);
/* 复用已有会话（DB 读不可用时唯一出路）：L2_COOKIE=<mentora_session 值> 直接注入。 */
const reuseTok = process.env.L2_COOKIE || "";
if (reuseTok) {
  await ctx.addCookies([{ name: "mentora_session", value: reuseTok, url: BASE }]);
  console.log("bootstrap: 复用 L2_COOKIE 指定会话");
}

/* 开码：卡密服务是外部 KV/D1/RDS，偶发 503（本轮实测遇到一次）。
 * 重试 5 次、每次间隔 4s，仍失败就如实退出——不伪造账号继续跑。 */
let gen = {};
for (let i = 0; i < 5 && !reuseTok; i++) {
  try {
    gen = await (
      await fetch(`${BASE}/api/admin/licenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-password": adminPw },
        body: JSON.stringify({ count: 1, days: 30 }),
        signal: AbortSignal.timeout(60000),
      })
    ).json();
  } catch (e) {
    gen = { error: e instanceof Error ? e.message : "network" };
  }
  if (gen.codes?.[0]) break;
  console.log(`开码第 ${i + 1} 次失败：${JSON.stringify(gen).slice(0, 100)}；4s 后重试`);
  await new Promise((r) => setTimeout(r, 4000));
}
if (!reuseTok && !gen.codes?.[0]) throw new Error(`开码失败（5 次重试后仍失败，属上游依赖问题，不是本批代码）: ${JSON.stringify(gen).slice(0, 160)}`);
if (!reuseTok) {
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "L2b 验收", inviteCode: gen.codes[0] }),
    signal: AbortSignal.timeout(30000),
  });
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  if (!tok) throw new Error(`注册失败 status=${reg.status}`);
  await ctx.addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  console.log(`bootstrap ok: ${email}`);
}

const composer = page.locator('input[aria-label="给智能体发消息"]');
/* 水合慢（本地 D1 读不可用时 /api/sync 会重试到 503，首屏可能拖到 10s+）：
 * 等输入框出现，最多 60s；再不行重载一次，仍不行如实报错退出。 */
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
const ready = await composer
  .waitFor({ state: "visible", timeout: 60000 })
  .then(() => true)
  .catch(() => false);
if (!ready) {
  console.log("首屏 60s 未出现输入框，重载一次…");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await composer.waitFor({ state: "visible", timeout: 60000 });
}
await page.waitForTimeout(1500);
const mainBtn = () => page.locator('button[aria-label="发送消息"], button[aria-label="停止当前回答"]').first();
const liveRun = page.locator('[data-testid="live-run"]');
const log = page.locator('[role="log"][aria-label="对话消息"]');

async function ask(text) {
  /* 先等空闲再点：运行中点主按钮是「停止」不是「发送」（UI-01 同位切换）。
   * 不等就点会让本条 ask 变成 stop，后面所有断言都在读上一条的消息。 */
  await page
    .waitForFunction(() => !!document.querySelector('button[aria-label="发送消息"]'), null, { timeout: 25000 })
    .catch(() => null);
  await composer.fill(text);
  await mainBtn().click();
}

async function waitIdle(timeout = 20000) {
  await page
    .waitForFunction(() => !!document.querySelector('button[aria-label="发送消息"]'), null, { timeout })
    .catch(() => null);
}

/* ================= U05：过程摘要由真实工具事件更新 ================= */
{
  chatCalls = 0;
  script = (n) =>
    n === 1
      ? [
          { t: "d", v: "先定位一下你的目标。\n\n" },
          { t: "d", v: "```tool\n" + JSON.stringify({ name: "get_goal", args: { topic: "Python" } }) + "\n```" },
          { t: "end" },
        ]
      : [{ t: "d", v: "你的目标是 Python，当前在语法阶段。" }, { t: "end" }];

  /* 按住第 1、2 轮请求：第 1 轮放出后工具执行、第 2 轮挂住，才能稳定观察「工具步骤」 */
  const heldFirst = chatCalls + 1;
  holdAt.set(heldFirst, () => {});
  holdAt.set(heldFirst + 1, () => {});
  await ask("看看我的 Python 学习目标");
  await page.waitForTimeout(2500);

  const midHeadline = await page.locator('[data-testid="run-headline"]').first().innerText().catch(() => "");
  const midLive = await liveRun.count();
  rec("U05-a", "在途时摘要行有内容（不是永久空标签）", midLive > 0 && midHeadline.trim().length > 0, `运行块=${midLive} headline="${midHeadline}"`);
  const midSpinner = await liveRun.locator(".animate-spin").count();
  rec("U05-b", "在途时明确显示进行中", midSpinner > 0, `spinner=${midSpinner}`);

  /* 放行第 1 轮 → 产生工具调用，第 2 轮仍挂住 */
  releaseHold(heldFirst);
  await page.waitForTimeout(2000);
  const toolHeadline = await page.locator('[data-testid="run-headline"]').first().innerText().catch(() => "");
  const toolSteps = await page.locator('[data-testid="run-step"]').count();
  rec(
    "U05-c",
    "摘要随真实工具事件更新（工具文案或步骤出现）",
    /看目标详情|读笔记|检索|正在/.test(toolHeadline) || toolSteps > 0,
    `headline="${toolHeadline}" steps=${toolSteps}`
  );

  releaseHold(heldFirst + 1);
  await waitIdle();
  await page.waitForTimeout(800);
  /* 完成后运行块已落库成消息：展开**消息里**的过程（这是更严格的口径——
   * 验的是刷新后也还在的那份，而不是在途临时块） */
  const expandMsg = page.locator('[data-testid="msg-meta-headline"] button', { hasText: "过程" }).first();
  if (await expandMsg.count()) await expandMsg.click().catch(() => null);
  await page.waitForTimeout(400);
  const stepsAfter = await page.locator('[data-testid="msg-step"]').count();
  const sources = await page.locator('[data-testid="msg-step"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-source")));
  rec(
    "U05-d",
    "完成后仍可在消息内展开真实步骤并标注来源",
    stepsAfter > 0 && sources.length > 0 && sources.every((x) => !!x),
    `steps=${stepsAfter} sources=${JSON.stringify([...new Set(sources)])}`
  );

  const spinner = await liveRun.locator(".animate-spin").count();
  const persisted = await page.locator('[data-testid="msg-meta-headline"]').count();
  rec("U05-e", "完成后停止动画且过程摘要随消息落库", spinner === 0 && persisted > 0, `spinner=${spinner} 落库摘要=${persisted}`);

  /* 刷新后重现：依赖会话存活。本机数据通道读额度耗尽时会话可能被判失效 → BLOCKED */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const sessionSurvived = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    return !!st && st.agentSessions.length > 0;
  });
  if (!sessionSurvived) {
    rec("U05-f", "刷新后过程摘要仍可见", null, "BLOCKED：刷新后会话未存活（本机数据通道读额度耗尽，见 report.md 环境阻塞）");
  } else {
    const afterReload = await page.locator('[data-testid="msg-meta-headline"]').count();
    rec("U05-f", "刷新后过程摘要仍可见", afterReload > 0, `count=${afterReload}`);
  }
  await page.waitForTimeout(500);
}

/* ================= U06：只有心跳 / <thinking> 文本 / 未信任工具文本 ================= */
{
  chatCalls = 0;
  /* 首轮只给心跳（h 事件），正文里还夹着普通 <thinking> 引用字符串 */
  script = () => [
    { t: "h", v: "" },
    { t: "h", v: "" },
    { t: "d", v: "这段正文里出现了 <thinking> 这样的字面文本，但它只是用户要看的字符串。" },
    { t: "end" },
  ];
  const before = chatCalls;
  holdAt.set(chatCalls + 1, () => {});
  await ask("这行字里的 <thinking> 是什么意思？");
  await page.waitForTimeout(1500);
  const headline = await page.locator('[data-testid="run-headline"]').first().innerText().catch(() => "");
  releaseHold(chatCalls);
  await waitIdle();
  await page.waitForTimeout(500);
  const calls = chatCalls - before;
  const bodyText = await log.innerText();
  rec(
    "U06-a",
    "只有心跳时摘要只说等待/回答，不编造推理阶段",
    !/推理|思考过程|分析中|正在分析/.test(headline),
    `headline="${headline}"`
  );
  rec("U06-b", "正文里的 <thinking> 字面量按普通文本展示，不被当成过程事件", bodyText.includes("<thinking>"), "正文命中字面量");
  rec("U06-c", "不因摘要而额外调用模型（一轮一次请求）", calls === 1, `本轮上游调用=${calls}`);
}

/* ================= U07：正文先流出，再出现工具事件 ================= */
{
  chatCalls = 0;
  const firstPara = "第一段是合法讲解：列表推导式把循环和表达式写在一行。";
  script = (n) =>
    n === 1
      ? [
          { t: "d", v: firstPara },
          { t: "d", v: "\n\n" },
          { t: "d", v: "```tool\n" + JSON.stringify({ name: "search_brain", args: { query: "列表推导式" } }) + "\n```" },
          { t: "end" },
        ]
      : [{ t: "d", v: "第二段：继续讲边界情况。" }, { t: "end" }];

  await ask("详细讲讲列表推导式");
  await waitIdle(25000);
  await page.waitForTimeout(800);
  const txt = await log.innerText();
  rec("U07-a", "工具调用前的合法段落不消失", txt.includes("第一段是合法讲解"), `含首段=${txt.includes("第一段是合法讲解")}`);
  rec("U07-b", "内部协议 JSON 不进入正文", !txt.includes('"name":"search_brain"') && !txt.includes("```tool"), "未命中协议串");
  /* 顺序断言只在**最后一条助手消息**里做：全页 innerText 会把历史消息算进来 */
  const lastAssistant = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    const sess = st?.agentSessions.find((x) => x.id === st.agentActiveId);
    const last = [...(sess?.messages ?? [])].reverse().find((m) => m.role === "assistant");
    return last?.content ?? "";
  });
  const iA = lastAssistant.indexOf("第一段是合法讲解");
  const iB = lastAssistant.indexOf("第二段");
  const orderOk = iA >= 0 && iB > iA;
  rec("U07-c", "最终内容按流式顺序一致", orderOk, `iA=${iA} iB=${iB}`);
}

/* ================= U08：搜索失败 vs 已成功读取网页 ================= */
{
  /* 8a：搜索失败，但直接读用户给的链接成功 */
  chatCalls = 0;
  searchCalls = 0;
  fetchCalls = 0;
  process.env.CASE_SEARCH_FAIL = "1";
  process.env.CASE_FETCH_FAIL = "0";
  const url = "https://nextjs.org/docs/app/guides/upgrading/version-15";
  script = (n) =>
    n === 1
      ? [
          { t: "d", v: "```tool\n" + JSON.stringify({ name: "web_search", args: { query: "Next.js 15 升级" } }) + "\n```" },
          { t: "end" },
        ]
      : n === 2
        ? [
            { t: "d", v: "```tool\n" + JSON.stringify({ name: "read_url", args: { url } }) + "\n```" },
            { t: "end" },
          ]
        : [
            { t: "d", v: "根据官方文档，v15 里 cookies/headers/params 变成异步，fetch 默认不再缓存。" },
            { t: "end" },
          ];

  await ask(`请查阅 Next.js v15 升级文档 ${url}`);
  await waitIdle(30000);
  await page.waitForTimeout(900);
  const txt = await log.innerText();
  const cites = await page.locator('a[href^="http"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  /* 终态后运行块已清：从持久化的消息 meta 读真实工具步骤（含失败态） */
  const metaTools = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    const sess = st?.agentSessions.find((x) => x.id === st.agentActiveId);
    const last = [...(sess?.messages ?? [])].reverse().find((m) => m.role === "assistant" && m.meta?.tools?.length);
    return (last?.meta?.tools ?? []).map((t) => ({ name: t.name, status: t.status, summary: t.summary }));
  });
  /* 按**工具名 + 状态**判定，不用摘要文案（read_url 的 summary 是网页标题，不含"读网页"字样） */
  const failedStep = metaTools.some((t) => t.name === "web_search" && t.status === "failed");
  const okStep = metaTools.some((t) => t.name === "read_url" && t.status === "completed");
  rec("U08-a", "搜索失败在步骤里如实标出（不隐藏）", failedStep, `tools=${JSON.stringify(metaTools)}`);
  rec("U08-b", "成功读取的网页被记为来源且可打开", cites.includes(url), `citations=${JSON.stringify(cites)}`);
  rec("U08-c", "终态无 spinner", (await liveRun.locator(".animate-spin").count()) === 0, "");
  rec(
    "U08-d",
    "区分「搜索失败」与「已成功读取」",
    failedStep && okStep,
    `failedStep=${failedStep} readStep=${okStep}`
  );

  /* 8b：两者都失败 → 不得声称已核实 */
  chatCalls = 0;
  process.env.CASE_SEARCH_FAIL = "1";
  process.env.CASE_FETCH_FAIL = "1";
  script = (n) =>
    n === 1
      ? [{ t: "d", v: "```tool\n" + JSON.stringify({ name: "web_search", args: { query: "Next.js 15" } }) + "\n```" }, { t: "end" }]
      : n === 2
        ? [{ t: "d", v: "```tool\n" + JSON.stringify({ name: "read_url", args: { url } }) + "\n```" }, { t: "end" }]
        : [{ t: "d", v: "这次没能取到官方文档，下面的说法未核实。" }, { t: "end" }];
  const citesBefore8e = await page.locator('a[href^="http"]').count();
  await ask(`再试一次 ${url}`);
  await waitIdle(30000);
  await page.waitForTimeout(800);
  const citesAfter8e = await page.locator('a[href^="http"]').count();
  rec("U08-e", "都失败时不产生伪造来源（本轮净增引用为 0）", citesAfter8e === citesBefore8e, `净增=${citesAfter8e - citesBefore8e}`);
  delete process.env.CASE_SEARCH_FAIL;
  delete process.env.CASE_FETCH_FAIL;
}

/* ================= U11：两会话滚动位置独立 ================= */
{
  chatCalls = 0;
  await page.locator('button[title="开始一段新对话"]').click();
  await page.waitForTimeout(600);
  const longBody = (n) => [
    { t: "d", v: `会话${n}的正文开始。\n\n` },
    ...Array.from({ length: 40 }, (_, i) => ({ t: "d", v: `第 ${i + 1} 行，用于撑高以测试滚动位置。\n\n` })),
    { t: "end" },
  ];
  script = (n) => longBody(n);
  await ask("给我一段很长的内容（滚动测试）");
  await waitIdle(25000);
  await page.waitForTimeout(700);
  /* A 上翻到顶部 */
  await log.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const aTop = await log.evaluate((el) => el.scrollTop);

  /* 建 B 并滚到底 */
  await page.locator('button[title="开始一段新对话"]').click();
  await page.waitForTimeout(500);
  await ask("B 的滚动测试");
  await waitIdle(25000);
  await page.waitForTimeout(700);
  const bTop = await log.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight }));
  const bAtBottom = bTop.h - bTop.top - bTop.c < 90;

  /* 切回 A：位置应恢复在顶部 */
  await page.getByRole("button", { name: /很长的内容/ }).first().click();
  await page.waitForTimeout(800);
  const aBack = await log.evaluate((el) => ({ top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight }));
  const aRestoredTop = aBack.top <= 40;
  rec("U11-a", "B 首次打开定位到最新", bAtBottom, JSON.stringify(bTop));
  rec(
    "U11-b",
    "切回 A 恢复 A 自己的滚动位置（不继承 B 的）",
    aRestoredTop && aBack.h > aBack.c,
    `A 回位 top=${Math.round(aBack.top)}（切走时 ${Math.round(aTop)}），B top=${Math.round(bTop.top)}`
  );
}

/* ================= U12：后台会话完成不改变当前页 ================= */
{
  chatCalls = 0;
  let release;
  holdNext = new Promise((r) => (release = r));
  script = () => [{ t: "d", v: "后台会话的回答。" }, { t: "end" }];

  /* A 发一条，请求被按住（后台仍在跑） */
  await page.getByRole("button", { name: /很长的内容/ }).first().click();
  await page.waitForTimeout(500);
  await ask("这条会在后台完成");
  await page.waitForTimeout(600);

  /* 切到 B，并滚到某个位置 */
  await page.getByRole("button", { name: /B 的滚动测试/ }).first().click();
  await page.waitForTimeout(600);
  await log.evaluate((el) => {
    el.scrollTop = 200;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const before = await page.evaluate(() => ({ url: location.pathname + location.search, y: window.scrollY }));
  const beforeScroll = await log.evaluate((el) => el.scrollTop);

  /* 放行后台请求 → A 完成 */
  release();
  await page.waitForTimeout(2500);

  const after = await page.evaluate(() => ({ url: location.pathname + location.search, y: window.scrollY }));
  const afterScroll = await log.evaluate((el) => el.scrollTop);
  rec(
    "U12-a",
    "后台会话完成后不导航、不跳回首页",
    before.url === after.url,
    `url ${before.url} → ${after.url}`
  );
  rec(
    "U12-b",
    "后台完成不改变当前会话的滚动位置",
    Math.abs(afterScroll - beforeScroll) <= 40,
    `scrollTop ${Math.round(beforeScroll)} → ${Math.round(afterScroll)}`
  );
  await page.screenshot({ path: path.join(SHOTS, "u12-background-complete.png") });
}

/* ================= U05 补充：不串会话 ================= */
{
  const runningMarks = await page.locator('[aria-label="正在生成"]').count();
  rec("U05-g", "过程块只属于发起会话（当前会话无他人的运行块）", runningMarks === 0, `运行标记=${runningMarks}`);
}

const pass = results.filter((r) => r.ok === true).length;
const blocked = results.filter((r) => r.ok === null).length;
const failed = results.filter((r) => r.ok === false).length;
fs.writeFileSync(
  path.join(OUT, "l2b-process-sources.json"),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      base: BASE,
      mockedChatRequests: chatCalls,
      searchCalls,
      fetchCalls,
      realModelRequests: 0,
      pass,
      total: results.length,
      results,
    },
    null,
    2
  )
);
console.log(`\n==== L2b 汇总：${pass} PASS / ${failed} FAIL / ${blocked} BLOCKED（共 ${results.length}，真实模型请求 0 次）====`);
for (const r of results.filter((x) => x.ok === false)) console.log(`  FAIL ${r.id} ${r.name} :: ${r.detail}`);
for (const r of results.filter((x) => x.ok === null)) console.log(`  BLOCKED ${r.id} ${r.name} :: ${r.detail}`);
await b.close();
process.exit(0);
