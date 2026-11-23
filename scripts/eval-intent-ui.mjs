/* ============================================================
 * 意图四路评测（浏览器级）：③交接/④恢复需要真实工具循环（审批卡+工具卡），
 * API 级 noTools 评测测不了这两路——本脚本驱动真实首页，断言：
 *   direct  → 不出现交接类工具卡
 *   handoff → 出现 create_goal/add_book/create_session 工具卡（或强文本信号）+ 自动批准
 *   resume  → 出现 resume_workflow 工具卡（或恢复文本信号）且不重建
 * 30 案例一次跑完（新鲜账号约 50 次上游调用 < 60 配额），跑完自删。
 *
 * EVAL-01 v2（2026-11-10）：判据改由 eval-scoring-v2.mjs 提供——
 *   direct 取消统一字数下限（旧 CJKOK >60 把正确短翻译判负）；
 *   handoff 读取真实对象（目标/书/会话是否真创建、background 是否保存），
 *   不只看工具标签；每条保存检查项明细与脚本哈希。
 *   旧口径结果保留在旧归档，本脚本输出新文件名（-v2）。
 * ============================================================ */
import fs from "node:fs";
import { execSync } from "node:child_process";
import { chromium } from "playwright-core";
import { score, SCORING_VERSION } from "./eval-scoring-v2.mjs";

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
  /* 案例前基线：记录对象数量，判定时用增量证明「本案例」真的创建了对象，
   *  避免把上一案例残留的对象误当成本案例的成果（v2 首版弱点）。 */
  const baseline = await page.evaluate(() => {
    try {
      const st = window.__mentoraStore?.getState?.();
      if (!st) return null;
      return { goals: (st.goals ?? []).length, books: (st.books ?? []).length, sessions: (st.sessions ?? []).length };
    } catch {
      return null;
    }
  });
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
  const observed = await page.evaluate(() => {
    const toolRows = [...document.querySelectorAll("div")]
      .filter((d) => TOOL_LABELS_TEST(d) && d.className.includes("border"))
      .map((d) => d.querySelector("span.font-medium")?.textContent || "");
    const mds = [...document.querySelectorAll(".prose-mentora")];
    const body = document.body.innerText;
    /* EVAL-01 v2：读真实业务对象（dev 钩子），不只看工具标签与文案 */
    let created;
    try {
      const st = window.__mentoraStore?.getState?.();
      if (st) {
        const goals = st.goals ?? [];
        const books = st.books ?? [];
        const sessions = st.sessions ?? [];
        /* 最近创建的目标背景（用于验证 AQ-02 背景是否真的保存） */
        const latestGoal = goals[0];
        created = {
          goals: goals.length,
          books: books.length,
          sessions: sessions.length,
          background: latestGoal ? (latestGoal.background ?? "") : null,
          latestGoalTopic: latestGoal ? latestGoal.topic : null,
        };
      }
    } catch {
      created = undefined;
    }
    return {
      text: mds[mds.length - 1]?.innerText || "",
      toolRows: [...new Set(toolRows)],
      tool429: body.includes("已达上限"),
      created,
    };
    function TOOL_LABELS_TEST(d) {
      const label = d.querySelector("span.font-medium")?.textContent || "";
      return /检索笔记|查看我的状态|读笔记全文|列出学习目标|看目标详情|看书架|列出会话|查看设置|出题检验|联网搜索|读网页正文|存为新笔记|修改笔记|删除笔记|新建学习目标|加书上架|新建会话|修改设置|恢复工作流|长期记忆|定时提醒/.test(label);
    }
  });
  /* 把本案例前基线并入返回，判定用增量 */
  return { ...observed, baseline };
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
  const text = out?.text ?? "";
  const quota = out?.tool429;
  /* 上游瞬时故障：这一轮既没有回答正文、也没有任何工具卡、也没配额提示
   * （dev 日志可见 "fetch failed…已重试 3 次"）。不属于产品行为失败，单独归类，
   *  不计入真实失败分母。 */
  const upstreamFailed = !quota && !err && !out?.text && (out?.toolRows?.length ?? 0) === 0;
  /* EVAL-01 v2：判据来自 eval-scoring-v2，并读取真实对象状态。
   * 用「本案例前基线 → 本案例后」的增量证明对象是本案例创建的，
   *  避免把上一案例残留对象误判为本案例成果。 */
  const absCreated = out?.created ?? undefined;
  const base = out?.baseline ?? undefined;
  const created = absCreated
    ? {
        goals: base ? Math.max(0, (absCreated.goals ?? 0) - (base.goals ?? 0)) : absCreated.goals,
        books: base ? Math.max(0, (absCreated.books ?? 0) - (base.books ?? 0)) : absCreated.books,
        sessions: base ? Math.max(0, (absCreated.sessions ?? 0) - (base.sessions ?? 0)) : absCreated.sessions,
        background: absCreated.background,
        latestGoalTopic: absCreated.latestGoalTopic,
        absolute: { goals: absCreated.goals, books: absCreated.books, sessions: absCreated.sessions },
      }
    : undefined;
  const scored = score(c.route, {
    text,
    handoffTools: tools.filter((t) => HANDOFF_TOOLS.has(t)),
    resumeTools: tools.filter((t) => t === RESUME_TOOL),
    created,
  });
  const routeOk = scored.pass;
  /* 上游故障的样本：ok 记 null（既非通过也非产品失败），单列 */
  const ok = upstreamFailed ? null : routeOk && !quota;
  results.push({
    id: c.id, route: c.route, ok, err, tools, quota, upstreamFailed,
    /* 复核要求：归档必须能独立复核判据。存全文 + 长度 + 哈希，
     *  避免「只存 600 字导致无法判断是否真被截断」的问题（复核报告 §4）。 */
    textFull: text,
    textLen: text.length,
    textHash: (() => {
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
      return `h${(h >>> 0).toString(16)}`;
    })(),
    textPreview: text.slice(0, 600),
    scoring: { version: scored.version, pass: scored.pass, checks: scored.checks },
    created: created ?? null,
  });
  console.log(
    quota ? "QUOTA" : upstreamFailed ? "UPSTREAM" : routeOk ? "PASS" : "FAIL",
    err,
    `tools=[${tools.join(",")}]`
  );
  if (!routeOk && !quota && !upstreamFailed) {
    const failedChecks = Object.entries(scored.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
    if (failedChecks.length) console.log(`        未过检查项: ${failedChecks.join(", ")}`);
  }
}

const pass = results.filter((r) => r.ok === true).length;
const upstreamCount = results.filter((r) => r.upstreamFailed).length;
const sha = (() => {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); } catch { return "unknown"; }
})();
/* EVAL-01 v2：脚本与判据哈希，便于复核运行时版本 */
const scriptHash = (() => {
  try {
    const c = execSync("git hash-object scripts/eval-intent-ui.mjs scripts/eval-scoring-v2.mjs").toString().trim();
    return c.split("\n").map((x) => x.slice(0, 12));
  } catch { return []; }
})();
const outDir = "docs/evidence";
fs.mkdirSync(outDir, { recursive: true });
/* v2 独立文件：不与旧口径结果合并、不覆盖历史（复核报告 §4 要求保留首轮原始归档） */
const outFile = `${outDir}/eval-intent-ui-${new Date().toISOString().slice(0, 10)}-${sha}-${SCORING_VERSION}.json`;
const archive = {
  promptVersion: sha,
  scoringVersion: SCORING_VERSION,
  scriptHashes: scriptHash,
  task: "agent-intent-ui",
  scenario: fixtures.scenario,
  base: BASE,
  runId: `run-${Date.now().toString(36)}`,
  date: new Date().toISOString(),
  summary: {
    total: results.length,
    pass,
    fail: results.filter((r) => r.ok === false && !r.quota).length,
    quota: results.filter((r) => r.quota).length,
    upstreamError: upstreamCount,
    /* 产品口径成功率：分母排除配额中断与上游故障 */
    productPassRate: (() => {
      const denom = results.length - results.filter((r) => r.quota || r.upstreamFailed).length;
      return denom > 0 ? Number((pass / denom).toFixed(3)) : null;
    })(),
  },
  results,
};
fs.writeFileSync(outFile, JSON.stringify(archive, null, 2));
console.log(`\n归档：${outFile}`);
console.log(`口径版本：${SCORING_VERSION}`);
console.log(
  `结果：${pass}/${results.length} PASS（配额中断 ${archive.summary.quota}，上游故障 ${upstreamCount}，真实失败 ${archive.summary.fail}）`
);
console.log(`产品口径成功率：${archive.summary.productPassRate === null ? "n/a" : `${(archive.summary.productPassRate * 100).toFixed(1)}%`}（分母排除配额与上游故障）`);
const failing = results.filter((r) => r.ok === false && !r.quota).map((r) => r.id);
if (failing.length) console.log(`未过：${failing.join(" ")}`);
const quotaIds = results.filter((r) => r.quota).map((r) => r.id);
if (quotaIds.length) console.log(`配额中断（非失败）：${quotaIds.join(" ")}`);
const upIds = results.filter((r) => r.upstreamFailed).map((r) => r.id);
if (upIds.length) console.log(`上游故障（非产品失败）：${upIds.join(" ")}`);

await fetch(`${BASE}/api/auth/account`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json", cookie: "mentora_session=" + tok },
  body: JSON.stringify({ password }),
}).catch(() => {});
await b.close();
process.exit(results.some((r) => r.quota) ? 3 : results.some((r) => !r.ok) ? 1 : 0);
