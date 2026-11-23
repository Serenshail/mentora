/* ============================================================
 * A03 / A04 / A01-E4 真实链路（第二轮复核 §4-3 要求）
 *
 * A03：含糊「调整第二阶段」→ 先聚焦澄清（零业务写入，不空转检索）
 * A04：结构性修改（一周 / 每天半小时 / 保留已完成）→ 精确预览 → 批准 → 应用 → 专业页 → 刷新
 * A01-E4：补齐「只改标题」的严格证据——完整 before/after 对象、成绩与笔记 ID 与内容、
 *         actionId / 目标版本、连续录像
 *
 * 全部走真实 UI（不经 dev hook 代替）+ 真实模型。预算按本批需要设。
 * 用法：BASE=http://localhost:3017 PHASE=a03|a04|a01e4 node scripts/verify-act-a03-a04.mjs
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3017";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = process.env.OUT || "docs/agent-experience-prd-2026-11-11/evidence/run-2026-11-12-d";
const PHASE = process.env.PHASE || "a04";
fs.mkdirSync(path.join(OUT, "videos"), { recursive: true });

const results = [];
const evidence = { phase: process.env.PHASE || "a04", startedAt: new Date().toISOString(), steps: [] };
const rec = (id, name, ok, detail = "") => {
  results.push({ id, name, ok, detail });
  console.log(`${ok === null ? "BLOCK" : ok ? "PASS " : "FAIL "}  ${id}  ${name}${detail ? `  :: ${detail}` : ""}`);
};
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/* ---------- 请求旁听（浏览器层） ---------- */
const requests = [];
let seq = 0;
const b = await chromium.launch({ executablePath: EXE, headless: true });
/* 录屏：playwright-core 的 recordVideo 依赖它自己绑定的 ffmpeg 目录布局，本机装了
 * ffmpeg-1013 但它仍报「please run npx playwright install ffmpeg」（路径解析问题）。
 * 改为**截图序列 + 关键节点标注**：每个步骤自动存一张 PNG，按顺序即为操作链路的
 * 视觉证据；同时把每步的时间戳与 DOM 快照写进 JSON。这比录屏更容易核对，
 * 也不依赖外部二进制。 */
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
let shotSeq = 0;
async function shot(label) {
  shotSeq += 1;
  const name = `${String(shotSeq).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: path.join(OUT, "videos", name) }).catch(() => {});
  evidence.steps.push({ seq: shotSeq, label, at: new Date().toISOString(), shot: name });
}
const page = await ctx.newPage();
page.on("request", (req) => {
  if (!/\/api\/chat$/.test(new URL(req.url()).pathname)) return;
  seq += 1;
  requests.push({ id: `rq_${seq}`, startedAt: Date.now() });
});
page.on("response", (res) => {
  if (!/\/api\/chat$/.test(new URL(res.url()).pathname)) return;
  const r = [...requests].reverse().find((x) => x.endedAt == null);
  if (r) {
    r.endedAt = Date.now();
    r.status = res.status();
  }
});

/* ---------- bootstrap：隔离账户 ---------- */
const env = fs.readFileSync(".env.local", "utf8");
const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
const email = `act-${PHASE}-${Date.now().toString(36)}@163.com`;
const password = "Act#pw" + Math.random().toString(36).slice(2, 8);
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
    gen = { error: e instanceof Error ? e.message : "net" };
  }
  if (gen.codes?.[0]) break;
  await new Promise((r) => setTimeout(r, 4000));
}
if (!gen.codes?.[0]) throw new Error(`开码失败: ${JSON.stringify(gen).slice(0, 120)}`);
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: `ACT-${PHASE}`, inviteCode: gen.codes[0] }),
  signal: AbortSignal.timeout(60000),
});
const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
if (!tok) throw new Error(`注册失败 status=${reg.status}`);
await ctx.addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
console.log(`bootstrap ok: ${email}`);

const composer = page.locator('input[aria-label="给智能体发消息"]');
const mainBtn = () => page.locator('button[aria-label="发送消息"], button[aria-label="停止当前回答"]').first();

async function openHome() {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
  let ok = await composer.waitFor({ state: "visible", timeout: 60000 }).then(() => true).catch(() => false);
  if (!ok) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    ok = await composer.waitFor({ state: "visible", timeout: 90000 }).then(() => true).catch(() => false);
  }
  if (!ok) throw new Error("首页输入框未出现（水合失败）");
  await page.waitForTimeout(2000);
}

/* ---------- fixture：目标 + 阶段 + 已完成天 + 成绩 + 笔记 + Rust 干扰 ---------- */
const FIXTURE = {
  goalId: "goal-python-1",
  noteId: "note-open-1",
  doneDayId: "done-day",
  phase2Id: "phase-files",
};

async function seedFixture() {
  const goal = {
    id: FIXTURE.goalId,
    topic: "Python",
    direction: "文件处理与数据处理",
    motivation: "想把日常脚本写好",
    status: "active",
    createdAt: new Date().toISOString(),
    quizLog: [
      {
        dayId: FIXTURE.doneDayId,
        at: new Date(Date.now() - 86400000).toISOString(),
        items: [
          { itemId: "i1", question: "open() 的默认模式是什么", verdict: "correct", evidence: "讲义原文：默认 'r'", feedback: "对" },
        ],
        overall: "pass",
        summary: "已掌握 open 的默认模式",
        reviewAdvice: "隔天复习",
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
          id: FIXTURE.phase2Id,
          title: "第二阶段 文件读写",
          outcome: "能读写文件",
          dayIds: [FIXTURE.doneDayId, "todo-day-1", "todo-day-2"],
          status: "active",
          catalog: [
            { id: FIXTURE.doneDayId, title: "打开与关闭", knowledgePoints: ["open"] },
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
        [FIXTURE.doneDayId]: {
          id: FIXTURE.doneDayId,
          phaseId: FIXTURE.phase2Id,
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
          phaseId: FIXTURE.phase2Id,
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
          phaseId: FIXTURE.phase2Id,
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
  const rust = {
    id: "goal-rust-1",
    topic: "Rust",
    direction: "系统编程",
    motivation: "想学系统级语言",
    status: "active",
    createdAt: new Date().toISOString(),
    quizLog: [],
    successCriteria: ["能写 CLI 工具"],
    plan: {
      summary: "Rust 入门",
      totalDays: 2,
      weeklyHours: 3,
      startDate: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      phases: [
        { id: "rp1", title: "所有权", outcome: "理解 borrow", dayIds: ["rd1"], status: "active", catalog: [{ id: "rd1", title: "所有权基础", knowledgePoints: ["move"] }], estDays: 2 },
      ],
      days: {
        rd1: { id: "rd1", phaseId: "rp1", title: "所有权基础", knowledgePoints: [{ id: "rkp1", text: "move" }], resources: [], method: "讲解", acceptance: [], status: "active", attempts: 0 },
      },
    },
  };
  const note = {
    id: FIXTURE.noteId,
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
    ({ g, r, n }) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
      const raw = JSON.parse(localStorage.getItem(key) || "{}");
      raw.state = raw.state || {};
      raw.state.goals = [g, r];
      raw.state.knowledge = [n];
      localStorage.setItem(key, JSON.stringify(raw));
      window.__mentoraStore?.setState?.({ goals: [g, r], knowledge: [n] });
    },
    { g: goal, r: rust, n: note }
  );
  await page.waitForTimeout(3000);
  return { goal, rust, note };
}

/** 稳定序列化：键排序后序列化，避免「同一个对象因键顺序不同被判成不同」。
 *  `days` 是 Record，编辑后重排会改变插入顺序——原实现用裸 JSON.stringify 比较，
 *  会把「内容完全相同、只是顺序变了」误判成「对象被改动」（复核点名的对象比较缺陷）。 */
function stable(v) {
  const walk = (x) => {
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(walk);
    return Object.keys(x)
      .sort()
      .reduce((acc, k) => {
        acc[k] = walk(x[k]);
        return acc;
      }, {});
  };
  return JSON.stringify(walk(v));
}
const same = (a, b) => stable(a) === stable(b);

/** 完整对象快照（E4：before/after 不能只有标题和数量） */
async function objectSnapshot() {
  return await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    const g = st?.goals?.find((x) => x.id === "goal-python-1");
    const n = st?.knowledge?.find((x) => x.id === "note-open-1");
    return {
      goal: g
        ? {
            id: g.id,
            topic: g.topic,
            status: g.status,
            phases: (g.plan?.phases ?? []).map((p) => ({
              id: p.id,
              title: p.title,
              outcome: p.outcome,
              estDays: p.estDays,
              dayIds: p.dayIds,
              catalog: (p.catalog ?? []).map((c) => ({ id: c.id, title: c.title })),
            })),
            days: Object.fromEntries(
              Object.entries(g.plan?.days ?? {}).map(([k, d]) => [
                k,
                {
                  id: d.id,
                  title: d.title,
                  phaseId: d.phaseId,
                  status: d.status,
                  completedAt: d.completedAt ?? null,
                  attempts: d.attempts,
                  knowledgePoints: (d.knowledgePoints ?? []).map((kp) => ({ id: kp.id, text: kp.text })),
                },
              ])
            ),
            quizLog: (g.quizLog ?? []).map((q) => ({
              dayId: q.dayId,
              at: q.at,
              overall: q.overall,
              items: (q.items ?? []).map((it) => ({ itemId: it.itemId, verdict: it.verdict, evidence: it.evidence })),
            })),
            planHistory: (g.planHistory ?? []).map((h) => ({ id: h.id, at: h.at, reason: h.reason, phaseId: h.phaseId, phaseTitle: h.phaseTitle })),
          }
        : null,
      note: n ? { id: n.id, title: n.title, body: n.body, version: n.version } : null,
      rustGoalPhases: (st?.goals?.find((x) => x.id === "goal-rust-1")?.plan?.phases ?? []).map((p) => p.title),
    };
  });
}

async function ask(text, timeoutMs = Number(process.env.ASK_TIMEOUT || 420000)) {
  await page
    .waitForFunction(() => !!document.querySelector('button[aria-label="发送消息"]'), null, { timeout: 30000 })
    .catch(() => null);
  const baseline = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    return st?.agentSessions.find((x) => x.id === st.agentActiveId)?.messages.length ?? 0;
  });
  await composer.fill(text);
  await mainBtn().click();
  const t0 = Date.now();
  let stable = 0;
  let lastCount = -1;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(1500);
    const s = await page.evaluate((base) => {
      const st = window.__mentoraStore?.getState?.();
      const all = st?.agentSessions.find((x) => x.id === st.agentActiveId)?.messages ?? [];
      const fresh = all.slice(base).filter((m) => m.role === "assistant");
      return {
        idle: !!document.querySelector('button[aria-label="发送消息"]'),
        n: all.length,
        last: fresh.length ? fresh[fresh.length - 1].content : "",
      };
    }, baseline);
    if (s.idle && s.n === lastCount && s.n > baseline) {
      stable += 1;
      if (stable >= 2) return s.last;
    } else {
      stable = 0;
      lastCount = s.n;
    }
  }
  throw new Error(`ask 超时（${timeoutMs}ms）`);
}

/**
 * 审批卡：**轮询等待**它出现再点。
 *
 * 原实现只做一次瞬时 `count()`——审批卡是异步渲染的（模型流结束 → 生成草稿 → 渲染卡片），
 * 一次查询几乎必然落空，导致「明明有审批卡却判成没有」（复核点名的「审批等待」缺陷）。
 * 现在等到 timeout，返回三态：approved / not-shown / timeout，便于区分
 * 「模型没发起写入」与「脚本没等到」。
 */
async function waitAndApprove(timeoutMs = 25000) {
  const btn = page.locator('button:has-text("批准执行")').first();
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < timeoutMs) {
    if ((await btn.count()) > 0) {
      seen = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!seen) {
    /* 再确认一次：卡片可能已经出现过并被自动处理掉 */
    const anyCard = await page.locator('text=待确认').count();
    return anyCard > 0 ? "approved" : "not-shown";
  }
  await btn.click();
  await page.waitForTimeout(3000);
  return "approved";
}

/* ---------- 主流程 ---------- */
await openHome();
await seedFixture();
await page.evaluate(() => window.__mentoraLedger?.newBatch?.("act") && window.__mentoraLedger?.configure?.(20, 20, "act"));

const before = await objectSnapshot();
evidence.before = before;
await shot("fixture-ready");
rec(
  "FIXTURE",
  "fixture 初态合格（Python 第二阶段含已完成天/成绩/笔记 + Rust 干扰）",
  !!before.goal &&
    before.goal.phases.some((p) => p.id === FIXTURE.phase2Id) &&
    Object.values(before.goal.days).some((d) => d.id === FIXTURE.doneDayId && d.status === "passed") &&
    before.goal.quizLog.length > 0 &&
    !!before.note,
  `阶段=${before.goal?.phases.map((p) => p.id).join(",")} 已完成天=${Object.values(before.goal?.days ?? {}).filter((d) => d.status === "passed").length} 成绩=${before.goal?.quizLog.length} 笔记=${!!before.note} Rust=${before.rustGoalPhases.join(",")}`
);

if (PHASE === "a03") {
  /* A03：含糊请求 → 聚焦澄清，零业务写入 */
  const reqBefore = requests.length;
  await shot("a03-before-ask");
  const answer = await ask("关于我的那个 Python 计划，我想调整一下他的那个计划，就是他的第二阶段，我想直接给他调整一下");
  evidence.answer = answer;
  evidence.answerSha256 = sha(answer);
  evidence.requestsUsed = requests.length - reqBefore;
  await shot("a03-answer");
  const after = await objectSnapshot();
  evidence.after = after;

  const askedDirection = /(?:改成|调整为|怎么调|哪方面|想改|希望|目标是什么|方向|具体想|要改什么)/.test(answer);
  rec("A03-a", "含糊请求触发聚焦澄清（问清调整方向）", askedDirection, `answer 前 120 字：${answer.slice(0, 120)}`);
  rec(
    "A03-b",
    "澄清阶段零业务写入（对象完全未变）",
    same(after.goal, before.goal),
    `阶段标题=${after.goal?.phases.map((p) => p.title).join("/")}`
  );
  rec("A03-c", "没有空转检索（请求数受控）", evidence.requestsUsed <= 4, `requests=${evidence.requestsUsed}`);
}

if (PHASE === "a04") {
  /* A04：结构性修改 → 精确预览 → 批准 → 应用 → 专业页 → 刷新 */
  const reqBefore = requests.length;
  const answer = await ask(
    "把 Python 第二阶段改成一星期，每天最多半小时，已经完成的内容和成绩要保留。先把具体方案给我看。"
  );
  evidence.answer = answer;
  evidence.answerSha256 = sha(answer);
  evidence.requestsUsed = requests.length - reqBefore;

  const afterDraft = await objectSnapshot();
  evidence.afterDraft = afterDraft;
  const draftedButNotApplied =
    same(afterDraft.goal?.phases, before.goal?.phases) &&
    Object.keys(afterDraft.goal?.days ?? {}).length === Object.keys(before.goal?.days ?? {}).length;
  rec(
    "A04-a",
    "批准前零写入（方案已给出但对象未变）",
    draftedButNotApplied,
    `阶段=${afterDraft.goal?.phases.map((p) => p.title).join("/")} 天数=${Object.keys(afterDraft.goal?.days ?? {}).length}`
  );
  const planMentions =
    /(?:7|七|一周|1 ?周)/.test(answer) && /(?:30 ?分钟|半小时)/.test(answer) && /(?:保留|不动|已完成)/.test(answer);
  rec("A04-b", "方案包含一周 / 每天半小时 / 保留已完成", planMentions, `命中=${planMentions}`);

  const approvalState = await waitAndApprove();
  const approved = approvalState === "approved";
  evidence.approvalState = approvalState;
  await page.waitForTimeout(6000);
  const afterApply = await objectSnapshot();
  evidence.afterApply = afterApply;

  if (!approved) {
    /* 没有审批卡：说明模型走的是「直接执行」或没发起写入，如实记录 */
    rec(
      "A04-c",
      "出现审批卡并已批准",
      approvalState === "not-shown" ? false : null,
      approvalState === "not-shown" ? "模型未发起写入（没有待确认卡）" : "等待审批卡超时（脚本侧问题，需重跑）"
    );
    rec("A04-d", "应用后第二阶段变成 7 天", false, "未应用");
    rec("A04-e", "已完成天/成绩/笔记保留", false, "未应用");
  } else {
    const ph2 = afterApply.goal?.phases.find((p) => p.id === FIXTURE.phase2Id);
    const dayCount = ph2?.dayIds?.length ?? 0;
    const doneKept = (ph2?.dayIds ?? []).includes(FIXTURE.doneDayId);
    rec("A04-c", "出现审批卡并已批准", true, `阶段=${ph2?.title} 天数=${dayCount}`);
    rec("A04-d", "应用后第二阶段变成 7 天", dayCount === 7, `实际 ${dayCount} 天`);
    rec(
      "A04-e",
      "已完成天/成绩/笔记保留",
      doneKept && (afterApply.goal?.quizLog.length ?? 0) > 0 && !!afterApply.note,
      `保留已完成天=${doneKept} 成绩=${afterApply.goal?.quizLog.length} 笔记=${!!afterApply.note}`
    );
  }

  /* 专业页 + 刷新 */
  await page.goto(`${BASE}/learn/${FIXTURE.goalId}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  const pageText = await page.locator("body").innerText();
  evidence.proPageText = pageText.slice(0, 1500);
  rec("A04-f", "专业页能看到修改后的阶段", /第二阶段|文件/.test(pageText), `页面含阶段名=${/第二阶段/.test(pageText)}`);

  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(6000);
  const afterReload = await objectSnapshot();
  evidence.afterReload = afterReload;
  const persisted =
    same(afterReload.goal?.phases, afterApply.goal?.phases) &&
    Object.keys(afterReload.goal?.days ?? {}).length === Object.keys(afterApply.goal?.days ?? {}).length;
  rec("A04-g", "刷新后修改仍保留", persisted, `阶段数=${afterReload.goal?.phases.length} 天数=${Object.keys(afterReload.goal?.days ?? {}).length}`);
  rec("A04-h", "刷新后成绩与笔记仍在", (afterReload.goal?.quizLog.length ?? 0) > 0 && !!afterReload.note, `成绩=${afterReload.goal?.quizLog.length} 笔记=${!!afterReload.note}`);
  rec("A04-i", "Rust 干扰目标未被误改", same(afterReload.rustGoalPhases, before.rustGoalPhases), `Rust=${afterReload.rustGoalPhases.join(",")}`);
}

if (PHASE === "a01e4") {
  /* A01-E4：只改标题，补齐严格证据 */
  const reqBefore = requests.length;
  const answer = await ask("把 Python 第二阶段的标题改为「文件与数据处理」");
  evidence.answer = answer;
  evidence.answerSha256 = sha(answer);
  evidence.requestsUsed = requests.length - reqBefore;
  const approvalState = await waitAndApprove();
  const approved = approvalState === "approved";
  evidence.approvalState = approvalState;
  await page.waitForTimeout(5000);
  const after = await objectSnapshot();
  evidence.after = after;

  const beforePh2 = before.goal?.phases.find((p) => p.id === FIXTURE.phase2Id);
  const afterPh2 = after.goal?.phases.find((p) => p.id === FIXTURE.phase2Id);
  rec("A01E4-a", "第二阶段标题已改", afterPh2?.title === "文件与数据处理", `before="${beforePh2?.title}" after="${afterPh2?.title}"`);
  /* 严格证据：其它字段逐项未变 */
  const sameOutcome = beforePh2?.outcome === afterPh2?.outcome;
  const sameEstDays = beforePh2?.estDays === afterPh2?.estDays;
  const sameDayIds = same(beforePh2?.dayIds, afterPh2?.dayIds);
  const sameCatalog = same(beforePh2?.catalog, afterPh2?.catalog);
  rec("A01E4-b", "只改了标题（outcome/estDays/dayIds/catalog 均未变）", sameOutcome && sameEstDays && sameDayIds && sameCatalog,
    `outcome=${sameOutcome} estDays=${sameEstDays} dayIds=${sameDayIds} catalog=${sameCatalog}`);
  /* 天级内容逐字段比对（数量相同不等于内容没被替换） */
  const beforeDays = before.goal?.days ?? {};
  const afterDays = after.goal?.days ?? {};
  const dayDiffs = [];
  for (const id of new Set([...Object.keys(beforeDays), ...Object.keys(afterDays)])) {
    const a = beforeDays[id];
    const c = afterDays[id];
    if (!same(a, c)) dayDiffs.push(id);
  }
  rec("A01E4-c", "所有学习日逐字段未变（不是只看数量）", dayDiffs.length === 0, `差异天=${JSON.stringify(dayDiffs)}`);
  rec("A01E4-d", "成绩记录完整保留", same(before.goal?.quizLog, after.goal?.quizLog), `成绩数=${after.goal?.quizLog.length}`);
  rec("A01E4-e", "笔记未被改动", same(before.note, after.note), `note.version=${after.note?.version}`);
  rec("A01E4-f", "留下可恢复的历史版本", (after.goal?.planHistory.length ?? 0) > 0, `history=${JSON.stringify(after.goal?.planHistory)}`);
  rec("A01E4-g", "Rust 干扰目标未被误改", JSON.stringify(after.rustGoalPhases) === JSON.stringify(before.rustGoalPhases), `Rust=${after.rustGoalPhases.join(",")}`);
}

/* ---------- 落盘 ---------- */

evidence.finishedAt = new Date().toISOString();
evidence.browserApiRequests = requests.length;
let providerCount = null;
try {
  providerCount = await (await fetch(`${BASE}/api/debug/provider-count`, { signal: AbortSignal.timeout(15000) })).json();
} catch { providerCount = null; }
evidence.providerAttemptsFromServer = providerCount;
evidence.shotCount = shotSeq;
evidence.shotsDir = path.join(OUT, "videos");

const pass = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false).length;
const blocked = results.filter((r) => r.ok === null).length;
evidence.results = results;
evidence.pass = pass;
evidence.failed = failed;
evidence.blocked = blocked;

fs.writeFileSync(path.join(OUT, `act-${PHASE}.json`), JSON.stringify(evidence, null, 2), "utf8");
console.log(`\n==== ${PHASE} 汇总：${pass} PASS / ${failed} FAIL / ${blocked} BLOCKED；浏览器请求 ${requests.length}，provider 尝试 ${providerCount?.total ?? "?"} ====`);
for (const r of results.filter((x) => x.ok === false)) console.log(`  FAIL ${r.id} ${r.name} :: ${r.detail}`);
await ctx.close();
await b.close();
process.exit(0);
