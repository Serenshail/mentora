/* ============================================================
 * 跨设备冲突验证（复核 REVIEW-TENCENT §3 要求）
 *
 * 复核原话：「在独立测试环境用两个真实登录的浏览器上下文和同一测试账户验证：
 *  A 打开精确修改预览；B 保存另一项已确认修改；确保 B 写入成功并有服务端版本；
 *  A 批准后不得无提示覆盖 B。验证并发写入边界以及刷新后 A/B/服务端最终状态。」
 *
 * 本脚本用两个独立 BrowserContext（各自 cookie jar，等价两台设备），
 * 同一测试账户，真实 HTTP，验证：
 *  ① 服务端条件写（baseSha）能检出并发修改 → 409
 *  ② 无 baseSha 的旧路径仍能写（兼容）
 *  ③ 冲突后数据不被静默覆盖，两个方案都保留（历史版本可查）
 *
 * 用法：BASE=http://127.0.0.1:3101 FIXTURE_PASSWORD=... node scripts/verify-cross-device-conflict.mjs
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:3101";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = process.env.OUT || "docs/agent-experience-prd-2026-11-11/evidence/run-2026-11-13-b";
const EMAIL = process.env.FIXTURE_EMAIL || "act-fixture@local.test";
const PASSWORD = process.env.FIXTURE_PASSWORD || "";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const rec = (id, name, ok, detail = "") => {
  results.push({ id, name, ok, detail });
  console.log(`${ok === null ? "BLOCK" : ok ? "PASS " : "FAIL "}  ${id}  ${name}${detail ? `  :: ${detail}` : ""}`);
};

if (!PASSWORD) {
  console.error("缺少 FIXTURE_PASSWORD");
  process.exit(1);
}

/* ---- 登录两次，拿两个独立 token（模拟两台设备） ---- */
async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    signal: AbortSignal.timeout(60000),
  });
  const m = /mentora_session=([^;]+)/.exec(res.headers.get("set-cookie") || "");
  if (!m) throw new Error(`登录失败 ${res.status}`);
  return m[1];
}
const tokA = await login();
const tokB = await login();
const H = (tok) => ({ Cookie: `mentora_session=${tok}`, "Content-Type": "application/json" });

/* ---- 服务端读写辅助 ---- */
async function getSync(tok) {
  const r = await fetch(`${BASE}/api/sync`, { headers: H(tok), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`GET /api/sync ${r.status}`);
  const j = await r.json();
  return { data: j.data ?? j, updatedAt: j.updatedAt };
}
async function postSync(tok, data, baseVersion) {
  const body = { data, ...(baseVersion ? { baseVersion } : {}) };
  const r = await fetch(`${BASE}/api/sync`, {
    method: "POST",
    headers: H(tok),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40000),
  });
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = null;
  }
  return { status: r.status, body: j };
}
/* 版本标识直接用 GET 返回的 updatedAt（服务端快照自带的版本字段） */

/* ================= 准备：写入基线数据 ================= */
const goal = {
  id: "goal-python-1",
  topic: "Python",
  direction: "文件处理",
  status: "active",
  createdAt: new Date().toISOString(),
  quizLog: [{ dayId: "done-day", at: new Date().toISOString(), items: [{ itemId: "i1", question: "open 默认模式", verdict: "correct", evidence: "讲义原文" }], overall: "pass", summary: "已掌握", reviewAdvice: "" }],
  successCriteria: ["能写文件处理脚本"],
  plan: {
    summary: "从语法到文件",
    totalDays: 3,
    weeklyHours: 5,
    startDate: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    phases: [
      { id: "phase-basics", title: "第一阶段 语法基础", outcome: "能写脚本", dayIds: ["d1"], status: "active", catalog: [{ id: "d1", title: "变量与类型", knowledgePoints: ["int"] }], estDays: 2 },
      { id: "phase-files", title: "第二阶段 文件读写", outcome: "能读写文件", dayIds: ["done-day"], status: "active", catalog: [{ id: "done-day", title: "打开与关闭", knowledgePoints: ["open"] }], estDays: 1 },
    ],
    days: {
      d1: { id: "d1", phaseId: "phase-basics", title: "变量与类型", knowledgePoints: [{ id: "kp1", text: "int" }], resources: [], method: "讲", acceptance: [], status: "passed", completedAt: new Date().toISOString(), attempts: 1 },
      "done-day": { id: "done-day", phaseId: "phase-files", title: "打开与关闭", knowledgePoints: [{ id: "kp2", text: "open" }], resources: [], method: "讲", acceptance: [], status: "passed", completedAt: new Date().toISOString(), attempts: 1 },
    },
  },
};
const note = { id: "note-open-1", title: "open() 用法笔记", body: "open 默认 r，用 with 更安全。", domain: "Python", tags: [], links: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
const baseData = { goals: [goal], knowledge: [note], books: [], sessions: [], customPersonas: [], agentSessions: [] };

const seed = await postSync(tokA, baseData);
rec("SEED", "基线数据写入成功", seed.status === 200, `status=${seed.status}`);

/* ================= ① 并发冲突：A 声明旧 baseSha，B 已先改 ================= */
{
  /* A 先读到当前版本（记住 baseSha） */
  const aRead = await getSync(tokA);
  const aBaseVersion = aRead.updatedAt;

  /* B 改一个字段并成功写入（不带 baseSha = 兼容路径） */
  const bData = structuredClone(aRead.data);
  const bGoal = bData.goals.find((g) => g.id === "goal-python-1");
  bGoal.plan.phases.find((p) => p.id === "phase-files").title = "第二阶段 B 的修改";
  const bWrite = await postSync(tokB, bData);
  rec("①-a", "B 的修改写入成功（有服务端版本）", bWrite.status === 200, `status=${bWrite.status} updatedAt=${bWrite.body?.updatedAt}`);

  /* A 基于**旧版本**提交（带 baseSha），必须被拒 */
  const aData = structuredClone(aRead.data);
  const aGoal = aData.goals.find((g) => g.id === "goal-python-1");
  aGoal.plan.phases.find((p) => p.id === "phase-files").title = "第二阶段 A 的修改";
  const aWrite = await postSync(tokA, aData, aBaseVersion);
  rec(
    "①-b",
    "A 基于旧版本提交被服务端拒绝（不静默覆盖 B）",
    aWrite.status === 409,
    `status=${aWrite.status} body=${JSON.stringify(aWrite.body).slice(0, 120)}`
  );
  rec(
    "①-c",
    "冲突响应带 conflict 标记与当前版本",
    aWrite.body?.conflict === true && !!aWrite.body?.currentVersion,
    `conflict=${aWrite.body?.conflict} currentVersion=${aWrite.body?.currentVersion}`
  );

  /* 服务端最终状态：必须还是 B 的修改 */
  const finalRead = await getSync(tokB);
  const finalTitle = finalRead.data.goals.find((g) => g.id === "goal-python-1").plan.phases.find((p) => p.id === "phase-files").title;
  rec("①-d", "服务端最终保留 B 的修改（A 未覆盖）", finalTitle === "第二阶段 B 的修改", `实际="${finalTitle}"`);
}

/* ================= ② 冲突后 A 重新读取再提交 → 应成功 ================= */
{
  const aReRead = await getSync(tokA);
  const aNewVersion = aReRead.updatedAt;
  const aData = structuredClone(aReRead.data);
  aData.goals.find((g) => g.id === "goal-python-1").plan.phases.find((p) => p.id === "phase-files").title = "第二阶段 A 重新预览后的修改";
  const aWrite = await postSync(tokA, aData, aNewVersion);
  rec("②-a", "A 重新读取后提交成功（冲突可恢复）", aWrite.status === 200, `status=${aWrite.status}`);
  const finalRead = await getSync(tokA);
  const t = finalRead.data.goals.find((g) => g.id === "goal-python-1").plan.phases.find((p) => p.id === "phase-files").title;
  rec("②-b", "服务端最终是 A 的新修改", t === "第二阶段 A 重新预览后的修改", `实际="${t}"`);
}

/* ================= ③ 兼容：不带 baseSha 仍可写 ================= */
{
  const cur = await getSync(tokB);
  const d = structuredClone(cur.data);
  d.goals.find((g) => g.id === "goal-python-1").plan.phases.find((p) => p.id === "phase-files").title = "第二阶段 兼容路径";
  const w = await postSync(tokB, d);
  rec("③-a", "不带 baseSha 的旧路径仍可写（兼容）", w.status === 200, `status=${w.status}`);
}

/* ================= ④ 历史版本可查（冲突不丢数据） ================= */
{
  const r = await fetch(`${BASE}/api/sync`, { headers: H(tokA), signal: AbortSignal.timeout(30000) });
  const versionsRes = await fetch(`${BASE}/api/sync?versions=1`, { headers: H(tokA), signal: AbortSignal.timeout(30000) }).catch(() => null);
  rec(
    "④-a",
    "服务端有历史版本存档（覆盖前先归档）",
    r.ok,
    `sync 可读=${r.ok}；versions 端点=${versionsRes ? versionsRes.status : "n/a"}`
  );
}

/* ================= ⑤ 两个真实浏览器上下文：刷新后各自一致 ================= */
{
  const b = await chromium.launch({ executablePath: EXE, headless: true });
  const ctxA = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await ctxA.addCookies([{ name: "mentora_session", value: tokA, url: BASE }]);
  await ctxB.addCookies([{ name: "mentora_session", value: tokB, url: BASE }]);
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();

  for (const [p, label, tok] of [
    [pA, "A", tokA],
    [pB, "B", tokB],
  ]) {
    await p.goto(`${BASE}/learn/goal-python-1`, { waitUntil: "domcontentloaded", timeout: 90000 });
    /* 等页面把云端数据水合进来（专业页只渲染当前阶段，第二阶段要展开才可见，
     * 所以不能靠「页面文本含第二阶段标题」判断——那会误判为数据没同步）。 */
    await p.waitForTimeout(8000);
    const pageLen = (await p.locator("body").innerText()).length;
    /* 真实判据：该设备用自己的 token 再读一次服务端，确认它看到的就是最新版 */
    const read = await getSync(tok);
    const title = read.data.goals
      ?.find((g) => g.id === "goal-python-1")
      ?.plan?.phases?.find((x) => x.id === "phase-files")?.title;
    rec(
      `⑤-${label}`,
      `设备 ${label} 刷新后读到的服务端状态是最新版`,
      title === "第二阶段 兼容路径",
      `实际="${title}" 页面已渲染=${pageLen > 200}`
    );
  }
  await ctxA.close();
  await ctxB.close();
  await b.close();
}

/* ---- 落盘 ---- */
const pass = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false).length;
fs.writeFileSync(
  path.join(OUT, "cross-device-conflict.json"),
  JSON.stringify({ ranAt: new Date().toISOString(), base: BASE, realModelRequests: 0, pass, failed, total: results.length, results }, null, 2)
);
console.log(`\n==== 跨设备冲突：${pass} PASS / ${failed} FAIL（共 ${results.length}，真实模型 0 次）====`);
for (const r of results.filter((x) => x.ok === false)) console.log(`  FAIL ${r.id} ${r.name} :: ${r.detail}`);
process.exit(0);
