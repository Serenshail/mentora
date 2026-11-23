/* ============================================================
 * L3 真实模型验收跑批（PRD §7.3 / §8；独立复核 2026-11-12 §5 第三、四步）
 *
 * 做什么：
 *   1) 读 QUALITY-CASES.json 的 Q01–Q08 原样输入（不改题、不改评分器）
 *   2) 用**真实** /api/chat 逐题跑一次，保留首轮全文 + sha256（首次结果不得替换）
 *   3) 逐请求记账：run/session/requestId、起止、usage（拿不到写 unknown）、失败/重试
 *   4) 硬上限 48 次实际 provider 请求，到上限立即保存并停止
 *   5) 另外跑一条真实「计划修改闭环」：读目标 → 改标题 → 读回验证 → 刷新保留
 *
 * 不做什么：不评分（评分是独立评审的活）、不重跑替换首轮、不改判据。
 *
 * 用法：
 *   BASE=http://localhost:3013 \
 *   PHASE=baseline|quality|plan-edit \
 *   OUT=docs/.../evidence/run-xxx \
 *   node scripts/verify-agent-experience-l3.mjs
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3013";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = process.env.OUT || "docs/agent-experience-prd-2026-11-11/evidence/run-2026-11-12-b";
const PHASE = process.env.PHASE || "quality"; // baseline | quality | plan-edit
const LIMIT = Number(process.env.REQUEST_LIMIT || 48);
const ONLY = (process.env.CASES || "").split(",").map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(OUT, { recursive: true });
const CASES_FILE = "docs/agent-experience-prd-2026-11-11/QUALITY-CASES.json";
const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8"));
const picked = cases.cases.filter((c) => (ONLY.length ? ONLY.includes(c.id) : true));

/* ---------- 请求账本（本进程内） ---------- */
const requests = [];
let seq = 0;
const startedAt = new Date().toISOString();

function sha256(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

const b = await chromium.launch({
  executablePath: EXE,
  headless: true,
  ...(process.env.PW_PROXY ? { proxy: { server: process.env.PW_PROXY } } : {}),
});
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();

/* 真实请求记账：只旁听，不拦截、不修改上游 */
page.on("request", (req) => {
  if (!/\/api\/chat$/.test(new URL(req.url()).pathname)) return;
  seq += 1;
  requests.push({
    id: `rq_${seq}`,
    url: req.url(),
    startedAt: Date.now(),
    task: (() => {
      try {
        return JSON.parse(req.postData() || "{}").task ?? "unknown";
      } catch {
        return "unknown";
      }
    })(),
  });
});
page.on("response", async (res) => {
  if (!/\/api\/chat$/.test(new URL(res.url()).pathname)) return;
  /* 用 startedAt 反查最近一条未结束的（同 URL 串行） */
  const rec = [...requests].reverse().find((r) => r.endedAt == null);
  if (!rec) return;
  rec.status = res.status();
  rec.endedAt = Date.now();
  rec.ok = res.status() === 200;
  /* usage 不在这里读：response 事件触发时 runner 的 onUsage 可能还没执行
   * （流式响应体读到 t=u 之后才回调）。统一在每题结束后用 syncUsageFromLedger()
   * 按 runId 回填，避免时序导致的假 unknown。 */
});

/* ---------- bootstrap：隔离账户（真注册，走真实后端） ---------- */
console.log(`bootstrap: ${PHASE} …`);
const env = fs.readFileSync(".env.local", "utf8");
const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
const email = `l3-${PHASE}-${Date.now().toString(36)}@163.com`;
const password = "L3#agent" + Math.random().toString(36).slice(2, 8);

let tok = process.env.L3_COOKIE || "";
if (!tok) {
  let gen = {};
  for (let i = 0; i < 5; i++) {
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
    console.log(`开码第 ${i + 1} 次失败，4s 后重试`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!gen.codes?.[0]) throw new Error(`开码失败（上游依赖）: ${JSON.stringify(gen).slice(0, 160)}`);
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "L3 验收", inviteCode: gen.codes[0] }),
    signal: AbortSignal.timeout(60000),
  });
  tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  if (!tok) throw new Error(`注册失败 status=${reg.status}`);
}
await ctx.addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
console.log(`bootstrap ok${process.env.L3_COOKIE ? "（复用会话）" : `: ${email}`}`);

const composer = page.locator('input[aria-label="给智能体发消息"]');
const mainBtn = () => page.locator('button[aria-label="发送消息"], button[aria-label="停止当前回答"]').first();
const log = page.locator('[role="log"][aria-label="对话消息"]');

async function openHome() {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
  let ok = await composer.waitFor({ state: "visible", timeout: 60000 }).then(() => true).catch(() => false);
  if (!ok) {
    /* 水合依赖 /api/auth/me（读 D1），实测可慢到 5s+；重载一次再等 */
    console.log("首屏 60s 未出现输入框，重载一次…");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    ok = await composer.waitFor({ state: "visible", timeout: 90000 }).then(() => true).catch(() => false);
  }
  if (!ok) {
    /* 如实报阻塞，不伪造结果 */
    throw new Error("首页输入框 150s 未出现（水合失败：/api/auth/me 或 /api/sync 依赖的数据通道过慢/不可用）");
  }
  await page.waitForTimeout(2000);
}

async function newSession() {
  const btn = page.locator('button[title="开始一段新对话"]');
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(800);
  }
}

async function ask(text, timeoutMs = Number(process.env.ASK_TIMEOUT || 480000)) {
  await page
    .waitForFunction(() => !!document.querySelector('button[aria-label="发送消息"]'), null, { timeout: 30000 })
    .catch(() => null);
  /* 记录本轮开始前的消息数：本轮回答 = 该位置之后新增的 assistant 消息 */
  const baselineMsgs = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    const sess = st?.agentSessions.find((x) => x.id === st.agentActiveId);
    return sess?.messages.length ?? 0;
  });
  await composer.fill(text);
  await mainBtn().click();
  /* 等终态：主按钮回到「发送消息」且消息数不再变化 */
  const t0 = Date.now();
  let stable = 0;
  let last = -1;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(1500);
    const state = await page.evaluate((baselineMsgs) => {
      const st = window.__mentoraStore?.getState?.();
      const sess = st?.agentSessions.find((x) => x.id === st.agentActiveId);
      const all = sess?.messages ?? [];
      /* 只取**本轮新增**的助手消息：fixture 预置的历史里也有 assistant，
       * 用「最后一条 assistant」会把 fixture 的复述当成本轮回答（Q08 曾因此只得 21 字）。 */
      const fresh = all.slice(baselineMsgs).filter((m) => m.role === "assistant");
      return {
        idle: !!document.querySelector('button[aria-label="发送消息"]'),
        msgs: all.length,
        last: fresh.length ? fresh[fresh.length - 1].content : "",
      };
    }, baselineMsgs);
    if (state.idle && state.msgs === last && state.msgs > 0) {
      stable += 1;
      if (stable >= 2) return state.last;
    } else {
      stable = 0;
      last = state.msgs;
    }
  }
  throw new Error(`ask 超时（${timeoutMs}ms）`);
}

/* ---------- 预置数据（fixture）：目标/阶段/已完成天 ---------- */
async function seedPlanFixture() {
  const goal = {
    id: "goal-python-1",
    topic: "Python",
    direction: "文件处理与数据处理",
    motivation: "想把日常脚本写好",
    status: "active",
    createdAt: new Date().toISOString(),
    quizLog: [
      {
        dayId: "done-day",
        at: new Date(Date.now() - 86400000).toISOString(),
        items: [{ itemId: "i1", question: "open() 的默认模式是什么", verdict: "correct", evidence: "讲义原文", feedback: "对" }],
        overall: "pass",
        summary: "已掌握",
        reviewAdvice: "",
      },
    ],
    successCriteria: ["能独立写文件处理脚本"],
    plan: {
      summary: "从基础语法到文件与数据处理",
      totalDays: 5,
      weeklyHours: 5,
      startDate: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      phases: [
        {
          id: "phase-basics",
          title: "第一阶段 语法基础",
          outcome: "能写简单脚本",
          dayIds: ["d1"],
          status: "active",
          catalog: [{ id: "d1", title: "变量与类型", knowledgePoints: ["int/str"] }],
          estDays: 2,
        },
        {
          id: "phase-files",
          title: "第二阶段 文件读写",
          outcome: "能读写文件",
          dayIds: ["done-day", "todo-day-1", "todo-day-2"],
          status: "active",
          catalog: [
            { id: "done-day", title: "打开与关闭", knowledgePoints: ["open"] },
            { id: "todo-day-1", title: "读写文本", knowledgePoints: ["read/write"] },
            { id: "todo-day-2", title: "异常处理", knowledgePoints: ["try"] },
          ],
          estDays: 3,
        },
      ],
      days: {
        d1: {
          id: "d1",
          phaseId: "phase-basics",
          title: "变量与类型",
          knowledgePoints: [{ id: "kp1", text: "int/str" }],
          resources: [],
          method: "讲解+练习",
          acceptance: [],
          status: "passed",
          completedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
          attempts: 1,
        },
        "done-day": {
          id: "done-day",
          phaseId: "phase-files",
          title: "打开与关闭",
          knowledgePoints: [{ id: "kp2", text: "open" }],
          resources: [],
          method: "讲解+练习",
          acceptance: [],
          status: "passed",
          completedAt: new Date(Date.now() - 86400000).toISOString(),
          attempts: 1,
        },
        "todo-day-1": {
          id: "todo-day-1",
          phaseId: "phase-files",
          title: "读写文本",
          knowledgePoints: [{ id: "kp3", text: "read/write" }],
          resources: [],
          method: "讲解+练习",
          acceptance: [],
          status: "active",
          attempts: 0,
        },
        "todo-day-2": {
          id: "todo-day-2",
          phaseId: "phase-files",
          title: "异常处理",
          knowledgePoints: [{ id: "kp4", text: "try" }],
          resources: [],
          method: "讲解+练习",
          acceptance: [],
          status: "locked",
          attempts: 0,
        },
      },
    },
  };
  const note = {
    id: "note-open-1",
    title: "open() 用法笔记",
    body: "open(path, mode) 默认 'r'。用完要 close，或用 with 语句。",
    domain: "Python",
    tags: [],
    links: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  await page.evaluate(
    ({ g, n }) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
      const raw = JSON.parse(localStorage.getItem(key) || "{}");
      raw.state = raw.state || {};
      raw.state.goals = [g];
      raw.state.knowledge = [n];
      localStorage.setItem(key, JSON.stringify(raw));
      window.__mentoraStore?.setState?.({ goals: [g], knowledge: [n] });
    },
    { g: goal, n: note }
  );
  await page.waitForTimeout(2500); // 等云同步把 fixture 推上去
  return goal;
}

/** 发请求前断言真实 store 里的 fixture 内容（E3 要求）。
 *  不合格就零请求退出，不产生任何不可用的「结果」。 */
async function assertFixture() {
  const observed = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    const goals = st?.goals ?? [];
    const py = goals.find((g) => g.id === "goal-python-1");
    const phases = py?.plan?.phases ?? [];
    const phase2 = phases.find((p) => p.id === "phase-files");
    const doneDays = (phase2?.dayIds ?? []).filter((id) => {
      const d = py?.plan?.days?.[id];
      return d && (d.status === "passed" || d.status === "skipped");
    });
    return {
      goalCount: goals.length,
      hasPythonGoal: !!py,
      phaseIds: phases.map((p) => p.id),
      phase2Title: phase2?.title ?? null,
      phase2DoneDays: doneDays.length,
      quizLogCount: py?.quizLog?.length ?? 0,
      knowledgeCount: (st?.knowledge ?? []).length,
      hasRustDistractor: goals.some((g) => /Rust/i.test(g.topic)),
    };
  });
  const problems = [];
  if (!observed.hasPythonGoal) problems.push("缺 goal-python-1");
  if (!observed.phaseIds.includes("phase-files")) problems.push("缺 phase-files（第二阶段）");
  if (observed.phase2DoneDays < 1) problems.push("第二阶段没有已完成天");
  if (observed.quizLogCount < 1) problems.push("缺已完成成绩记录");
  return {
    ok: problems.length === 0,
    reason: problems.join("；"),
    observed,
    summary: `goals=${observed.goalCount} phase2="${observed.phase2Title}" 已完成天=${observed.phase2DoneDays} 成绩=${observed.quizLogCount} 笔记=${observed.knowledgeCount} Rust干扰=${observed.hasRustDistractor}`,
  };
}

/* ---------- 主流程 ---------- */
const answers = [];
const planEdit = { steps: [] };
let budgetHit = false;

/* 每题跑完立刻落盘：进程崩溃/超时不会把已经拿到的真实回答丢掉
 * （上一轮 Q01–Q05 就因为崩在 Q06 而全部丢失，这是必须修的取证缺陷）。 */
function flushAnswers() {
  fs.writeFileSync(
    path.join(OUT, `l3-${PHASE}.answers.jsonl`),
    answers.map((a) => JSON.stringify(a)).join("\n") + (answers.length ? "\n" : ""),
    "utf8"
  );
  fs.writeFileSync(
    path.join(OUT, `l3-${PHASE}.requests.jsonl`),
    requests.map((r) => JSON.stringify(r)).join("\n") + (requests.length ? "\n" : ""),
    "utf8"
  );
}

function remaining() {
  return LIMIT - requests.length;
}

/** 从页面账本按顺序回填 usage（runner 真实收到的 onUsage）。
 *  必须在本题完全结束后调用：流式响应体读到 t=u 才回调，早读会得到 unknown。 */
async function syncUsageFromLedger() {
  let ledger = null;
  try {
    ledger = await page.evaluate(() => window.__mentoraLedger?.summary?.() ?? null);
  } catch {
    return;
  }
  if (!ledger?.records?.length) return;
  /* 账本与本次 requests 一一对应（同一浏览器上下文、串行） */
  for (let i = 0; i < requests.length && i < ledger.records.length; i++) {
    const lr = ledger.records[i];
    const rec = requests[i];
    if (!lr || rec.usage) continue;
    rec.ledgerId = lr.id;
    rec.ledgerRound = lr.round;
    rec.ledgerRunId = lr.runId;
    if (lr.usageSource === "provider" && (lr.inputTokens != null || lr.outputTokens != null)) {
      rec.usage = { inputTokens: lr.inputTokens, outputTokens: lr.outputTokens, cachedTokens: lr.cachedTokens };
      rec.usageSource = "provider";
    } else {
      rec.usageSource = "unknown";
    }
    rec.ok = lr.ok ?? rec.ok;
    if (lr.error) rec.error = lr.error;
  }
}

await openHome();

/* 开新批次（E1）：批次 id 稳定写入 localStorage，跨刷新/重启累计。
 * 预算按**本批实际需要**设，不继承上一批的「48−已用」——
 * 余额不可查时，把上一批的剩余额度当成可用额度是不允许的。 */
const API_LIMIT = Number(process.env.API_LIMIT || 24);
const PROVIDER_LIMIT = Number(process.env.PROVIDER_LIMIT || 24);
const batchId = await page.evaluate(
  ([purpose, api, prov]) => {
    const l = window.__mentoraLedger;
    if (!l) return null;
    const id = l.newBatch(purpose);
    l.configure(api, prov, purpose);
    return id;
  },
  [PHASE, API_LIMIT, PROVIDER_LIMIT]
);
console.log(`批次 ${batchId}：api≤${API_LIMIT} provider≤${PROVIDER_LIMIT}（用途 ${PHASE}）`);

if (PHASE === "quality" || PHASE === "baseline") {
  /* 冻结用例要求 fixture：Q08 需要「Python 第二阶段 + 已完成成果 + Rust 干扰目标」。
   * 上一轮（run-2026-11-12-b）只在 plan-edit 分支注入，导致 Q08 在「没有任何学习目标」
   * 的初态下跑，**用例初态不合格**（第二轮复核 E3）。这里在跑任何质量题之前注入，
   * 并在发请求前**断言真实 store 内容**；不符合就零请求退出。 */
  await seedPlanFixture();
  const fixtureCheck = await assertFixture();
  if (!fixtureCheck.ok) {
    fs.writeFileSync(
      path.join(OUT, `l3-${PHASE}.fixture-abort.json`),
      JSON.stringify({ aborted: true, reason: fixtureCheck.reason, observed: fixtureCheck.observed }, null, 2),
      "utf8"
    );
    console.error(`FIXTURE 断言失败，零请求退出：${fixtureCheck.reason}`);
    console.error(JSON.stringify(fixtureCheck.observed, null, 2));
    await b.close();
    process.exit(2);
  }
  console.log(`fixture 断言通过：${fixtureCheck.summary}`);

  for (const c of picked) {
    if (remaining() <= 2) {
      budgetHit = true;
      answers.push({ caseId: c.id, status: "SKIPPED_BUDGET", reason: `剩余预算 ${remaining()} 次，为保留收尾余量跳过` });
      continue;
    }
    await newSession();
    /* 带历史的案例（Q04/Q06/Q08）：按 fixture 逐条预置对话，最后一条为正式待答输入 */
    const msgs = c.messages;
    const turns = msgs.slice(0, -1);
    const finalAsk = msgs[msgs.length - 1].content;
    /* fixture 历史**全部直接写 store**，绝不通过 ask() 建立：
     * 通过 ask() 会让每一轮历史都真跑一次模型（Q06 有 8 轮历史 = 8 次请求），
     * 既浪费额度，又把「fixture 输入」和「模型输出」混在一起（违反证据纪律）。
     * 只有最后一条正式待答输入才真跑。 */
    if (turns.length > 0) {
      await page.evaluate((turnsIn) => {
        const st = window.__mentoraStore.getState();
        for (const t of turnsIn) {
          st.appendAgentMsg(
            { id: `fx_${Math.random().toString(36).slice(2, 10)}`, role: t.role, content: t.content, at: new Date().toISOString() },
            st.agentActiveId
          );
        }
      }, turns);
      await page.waitForTimeout(600);
    }
    const before = requests.length;
    let text = "";
    try {
      text = await ask(finalAsk);
    } catch (e) {
      await syncUsageFromLedger();
      answers.push({
        caseId: c.id,
        title: c.title,
        status: "TIMEOUT",
        fixtureTurnsPreseeded: turns.length,
        requestsUsed: requests.length - before,
        error: e instanceof Error ? e.message : "unknown",
        at: new Date().toISOString(),
      });
      flushAnswers();
      console.log(`  ${c.id} 超时/失败：${e instanceof Error ? e.message : "unknown"}`);
      continue; // 不中断整批
    }
    await syncUsageFromLedger();
    const used = requests.length - before;
    answers.push({
      caseId: c.id,
      title: c.title,
      status: "RAN",
      fixtureTurnsPreseeded: turns.length,
      requestsUsed: used,
      answer: text,
      answerSha256: sha256(text),
      answerChars: text.length,
      at: new Date().toISOString(),
    });
    flushAnswers(); // 立刻落盘
    console.log(`  ${c.id} 完成（${used} 次请求，${text.length} 字）`);
  }
}

if (PHASE === "plan-edit") {
  await newSession();
  await seedPlanFixture();
  const before = requests.length;
  /* ① 明确小改动：第二阶段标题改名（PRD §1.2.6 应直接执行、不再二次批准） */
  const a1 = await ask("把 Python 第二阶段的标题改为「文件与数据处理」");
  planEdit.steps.push({ step: "rename-request", answer: a1, requestsUsed: requests.length - before });

  /* ② 读回验证：页面上的阶段标题真的变了吗 */
  await page.goto(`${BASE}/learn/goal-python-1`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  const pageTitle = await page.evaluate(() => document.body.innerText.includes("文件与数据处理"));
  planEdit.steps.push({ step: "verify-page", sawNewTitle: pageTitle });

  /* ③ 刷新后仍保留 */
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(5000);
  const afterReload = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    const g = st?.goals?.find((x) => x.id === "goal-python-1");
    return {
      phaseTitles: g?.plan?.phases?.map((p) => p.title) ?? [],
      daysCount: Object.keys(g?.plan?.days ?? {}).length,
      quizLogCount: g?.quizLog?.length ?? 0,
      historyCount: g?.planHistory?.length ?? 0,
    };
  });
  planEdit.steps.push({ step: "verify-after-reload", ...afterReload });
  planEdit.objectState = afterReload;
  console.log(`  plan-edit 完成：${JSON.stringify(afterReload)}`);
}

/* ---------- 落盘 ---------- */
/* provider 层权威计数（服务端实际发往上游的尝试数，含重试） */
let providerCount = null;
try {
  providerCount = await (await fetch(`${BASE}/api/debug/provider-count`, { signal: AbortSignal.timeout(15000) })).json();
} catch {
  providerCount = null;
}
/* 客户端账本（api/provider 两层分开） */
let ledger = null;
try {
  ledger = await page.evaluate(() => window.__mentoraLedger?.summary?.() ?? null);
} catch {
  ledger = null;
}
const finishedAt = new Date().toISOString();
const usageUnknown = requests.filter((r) => r.usage == null).length;
const tokenTotals = requests.reduce(
  (acc, r) => {
    if (r.usage) {
      acc.input += r.usage.inputTokens ?? 0;
      acc.output += r.usage.outputTokens ?? 0;
      acc.cached += r.usage.cachedTokens ?? 0;
      acc.withUsage += 1;
    }
    return acc;
  },
  { input: 0, output: 0, cached: 0, withUsage: 0 }
);

fs.writeFileSync(
  path.join(OUT, `l3-${PHASE}.answers.jsonl`),
  answers.map((a) => JSON.stringify(a)).join("\n") + (answers.length ? "\n" : ""),
  "utf8"
);
fs.writeFileSync(
  path.join(OUT, `l3-${PHASE}.requests.jsonl`),
  requests.map((r) => JSON.stringify(r)).join("\n") + (requests.length ? "\n" : ""),
  "utf8"
);
if (PHASE === "plan-edit") {
  fs.writeFileSync(path.join(OUT, "l3-plan-edit.json"), JSON.stringify(planEdit, null, 2), "utf8");
}
fs.writeFileSync(
  path.join(OUT, `l3-${PHASE}.summary.json`),
  JSON.stringify(
    {
      phase: PHASE,
      startedAt,
      finishedAt,
      base: BASE,
      requestLimit: LIMIT,
      batchId,
      /** 浏览器发出的 /api/chat 请求数（本脚本旁听到的） */
      browserApiRequests: requests.length,
      /** 服务端实际发往 provider 的尝试数（含上游重试）——这才是花钱口径 */
      providerAttemptsFromServer: providerCount,
      /** 客户端账本（分 api/provider 两层） */
      ledger: ledger
        ? { batchId: ledger.batchId, budget: ledger.budget, byLayer: ledger.byLayer, byCase: ledger.byCase }
        : null,
      budgetHit,
      usageUnknown,
      tokenTotals,
      cases: answers.map((a) => ({ caseId: a.caseId, status: a.status, requestsUsed: a.requestsUsed, chars: a.answerChars })),
      planEdit: PHASE === "plan-edit" ? planEdit.objectState : undefined,
    },
    null,
    2
  ),
  "utf8"
);
console.log(`\n==== L3 ${PHASE} 结束：真实请求 ${requests.length}/${LIMIT} 次，usage 缺失 ${usageUnknown} 条 ====`);
await b.close();
process.exit(0);
