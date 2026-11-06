/* ============================================================
 * 意图四路评测（浏览器级）：③交接/④恢复需要真实工具循环（审批卡+工具卡），
 * API 级 noTools 评测测不了这两路——本脚本驱动真实首页，断言：
 *   direct  → 不出现交接类工具卡
 *   handoff → 出现 create_goal/add_book/create_session 工具卡（或强文本信号）+ 自动批准
 *   resume  → 出现 resume_workflow 工具卡（或恢复文本信号）且不重建
 * 30 案例一次跑完（新鲜账号约 50 次上游调用 < 60 配额），跑完自删。
 * ============================================================ */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3000";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const fixtures = JSON.parse(fs.readFileSync("scripts/eval-intent.fixtures.json", "utf8"));
const only = (process.env.CASES || "").split(",").map((s) => s.trim()).filter(Boolean);
const cases = fixtures.cases.filter((c) => (only.length ? only.includes(c.id) : true));

const HANDOFF_TOOLS = new Set(["新建学习目标", "加书上架", "新建会话"]);
const RESUME_TOOL = "恢复工作流";
const TOOL_LABELS = /检索笔记|查看我的状态|读笔记全文|列出学习目标|看目标详情|看书架|列出会话|查看设置|出题检验|联网搜索|读网页正文|存为新笔记|修改笔记|删除笔记|新建学习目标|加书上架|新建会话|修改设置|恢复工作流|长期记忆|定时提醒/;

const b = await chromium.launch({ executablePath: EXE, headless: true, ...(process.env.PW_PROXY ? { proxy: { server: process.env.PW_PROXY } } : {}) });
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();

/* 管理员开激活码 → 注册新鲜账号（独享配额） */
console.log("bootstrap: mint…");
const env = fs.readFileSync(".env.local", "utf8");
const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
const email = `intent-${Date.now().toString(36)}@163.com`;
const password = "It#ent" + Math.random().toString(36).slice(2, 8);
const gen = await (await fetch(`${BASE}/api/admin/licenses`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-admin-password": adminPw },
  body: JSON.stringify({ count: 1, days: 30 }),
  signal: AbortSignal.timeout(30000),
})).json();
const code = gen.codes?.[0];
if (!code) throw new Error(`生成激活码失败: ${JSON.stringify(gen).slice(0, 120)}`);
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "意图评测", inviteCode: code }),
  signal: AbortSignal.timeout(30000),
});
const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
if (!tok) throw new Error(`注册失败 ${reg.status}`);
await ctx.addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
console.log("bootstrap: register done, goto 首页…");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
console.log("goto done");

const newChat = async () => {
  try {
    await page.getByRole("button", { name: /新对话/ }).first().click({ timeout: 8000 });
  } catch {
    /* 页面状态卡死（残留审批/导航异常）→ 直接回首页重来 */
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.getByRole("button", { name: /新对话/ }).first().click({ timeout: 15000 });
  }
  await page.waitForTimeout(600);
};

const runCase = async (c) => {
  await newChat();
  await page.getByPlaceholder(/提问、搜索/).fill(c.question);
  await page.getByRole("button", { name: "发送" }).click();
  /* 停止按钮 visible→hidden = 一轮完成；期间持续批准审批卡（交接类必须批准才走完） */
  let done = false;
  const stopped = (async () => {
    await page.getByRole("button", { name: "停止" }).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await page.getByRole("button", { name: "停止" }).waitFor({ state: "hidden", timeout: 300000 }).catch(() => {});
    done = true;
  })();
  const approver = (async () => {
    while (!done) {
      const btn = page.getByRole("button", { name: "批准执行" }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(400);
      } else {
        await page.waitForTimeout(400);
      }
    }
  })();
  await stopped;
  /* 清掉可能残留的审批卡（拒绝），避免污染下一个案例 */
  const rej = page.getByRole("button", { name: "拒绝" }).first();
  if (await rej.isVisible().catch(() => false)) await rej.click().catch(() => {});
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const toolRows = [...document.querySelectorAll("div")]
      .filter((d) => TOOL_LABELS_TEST(d) && d.className.includes("border"))
      .map((d) => d.querySelector("span.font-medium")?.textContent || "");
    const mds = [...document.querySelectorAll(".prose-mentora")];
    const body = document.body.innerText;
    return {
      text: mds[mds.length - 1]?.innerText || "",
      toolRows: [...new Set(toolRows)],
      tool429: body.includes("已达上限"),
    };
    function TOOL_LABELS_TEST(d) {
      const label = d.querySelector("span.font-medium")?.textContent || "";
      return /检索笔记|查看我的状态|读笔记全文|列出学习目标|看目标详情|看书架|列出会话|查看设置|出题检验|联网搜索|读网页正文|存为新笔记|修改笔记|删除笔记|新建学习目标|加书上架|新建会话|修改设置|恢复工作流|长期记忆|定时提醒/.test(label);
    }
  });
};

const results = [];
let idx = 0;
for (const c of cases) {
  idx += 1;
  process.stdout.write(`- ${c.id} (${idx}/${cases.length}) ... `);
  let out;
  let err = "";
  try {
    out = await runCase(c);
  } catch (e) {
    err = e.message.slice(0, 80);
  }
  const tools = out?.toolRows ?? [];
  const hasHandoffTool = tools.some((t) => HANDOFF_TOOLS.has(t));
  const hasResumeTool = tools.includes(RESUME_TOOL);
  const text = out?.text ?? "";
  let routeOk;
  if (c.route === "direct") {
    routeOk = !hasHandoffTool && !hasResumeTool && CJKOK(text);
  } else if (c.route === "handoff") {
    routeOk = hasHandoffTool || /帮你.{0,16}(建|创建|立|拆|安排|加入)|学习页|引导对话|加入书架|圆桌/.test(text);
  } else {
    routeOk = hasResumeTool || (/进度|继续|恢复|已有|之前|接着|上次|还在/.test(text) && !/重新立|新建一个.{0,8}目标/.test(text));
  }
  const quota = out?.tool429;
  results.push({ id: c.id, route: c.route, ok: routeOk && !quota, err, tools, quota, text: text.slice(0, 600) });
  console.log(quota ? "QUOTA" : routeOk ? "PASS" : "FAIL", err, `tools=[${tools.join(",")}]`);
}
function CJKOK(t) {
  return /[\u4e00-\u9fff]/.test(t) && t.length > 60;
}

const pass = results.filter((r) => r.ok).length;
const sha = (() => {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "unknown"; }
})();
const outDir = "docs/evidence";
fs.mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}/eval-intent-ui-${new Date().toISOString().slice(0, 10)}-${sha}.json`;
let archive = {
  promptVersion: sha,
  task: "agent-intent-ui", scenario: fixtures.scenario, base: BASE,
  date: new Date().toISOString(), summary: { total: results.length, pass, fail: results.length - pass },
  results,
};
if (fs.existsSync(outFile)) {
  const prev = JSON.parse(fs.readFileSync(outFile, "utf8"));
  const byId = new Map(prev.results.map((r) => [r.id, r]));
  for (const r of results) byId.set(r.id, r);
  const merged = [...byId.values()];
  archive = { ...archive, results: merged, summary: { total: merged.length, pass: merged.filter((r) => r.ok).length, fail: merged.filter((r) => !r.ok).length }, mergedRuns: [...new Set([...(prev.mergedRuns ?? [prev.date]), archive.date])] };
}
fs.writeFileSync(outFile, JSON.stringify({
  promptVersion: sha,
  task: "agent-intent-ui",
  scenario: fixtures.scenario,
  base: BASE,
  date: new Date().toISOString(),
  summary: { total: results.length, pass, fail: results.length - pass },
  results,
}, null, 1));
console.log(`\n归档：${outFile}`);
console.log(`结果：${pass}/${results.length} PASS`);
const failing = results.filter((r) => !r.ok).map((r) => r.id);
if (failing.length) console.log(`未过：${failing.join(" ")}`);

await fetch(`${BASE}/api/auth/account`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json", cookie: "mentora_session=" + tok },
  body: JSON.stringify({ password }),
}).catch(() => {});
await b.close();
process.exit(results.some((r) => r.quota) ? 3 : results.some((r) => !r.ok) ? 1 : 0);
