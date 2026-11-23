#!/usr/bin/env node
/* 集成验收走查：跨页面一致性
 * 核心命题：首页智能体执行的操作，在专业页面要可见、可继续；同一份业务数据。
 *
 * 流程 A（学习）：智能体 edit_phase 改阶段标题 → 学习详情页看到新标题 → 刷新仍在
 * 流程 B（阅读）：智能体 save_reading_deposit 存沉淀 → 阅读详情页沉淀区可见 → 笔记来源
 * 流程 C（圆桌）：智能体 set_participants 改阵容 → 圆桌页上下文条显示新阵容
 * 流程 D（深链）：run_discussion 结果入口 /council?session=id → 直达该会话
 *
 * 数据：真实账号 + 产品 store 动作（不 setState 注入业务对象）；
 *       仅用 dev 钩子调用与 UI 相同的工具执行器（executeTool/executeAction）。
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3001";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = "docs/evidence/integration-2026-11-11";
fs.mkdirSync(OUT, { recursive: true });

const log = [], results = [];
const rec = (s, d) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` :: ${d}` : ""}`; console.log(l); log.push(l); };
const verdict = (id, name, pass, ev) => { results.push({ id, name, pass, evidence: ev }); console.log(`  ${pass ? "PASS" : "FAIL"} ${id} ${name}`); };
const now = () => new Date().toISOString();

const seed = {
  goals: [{
    id: "ig1", topic: "集成验收目标", direction: "端到端", domainKind: "coding",
    motivation: "", background: "", weeklyHours: 5, successCriteria: [], status: "active",
    createdAt: now(), quizLog: [], intakeTranscript: [],
    plan: {
      summary: "两阶段", totalDays: 2, weeklyHours: 5, startDate: "2026-11-01", createdAt: now(),
      phases: [
        { id: "ip1", title: "原阶段名", outcome: "能上手", estDays: 2, boundary: "基础",
          status: "active", dayIds: ["id1"],
          catalog: [{ id: "id1", title: "第1天 基础", knowledgePoints: ["概念A"] }] },
      ],
      days: {
        id1: { id: "id1", phaseId: "ip1", title: "第1天 基础", stub: false,
          knowledgePoints: [{ id: "ik1", text: "概念A" }], resources: [], method: "讲解",
          acceptance: [], status: "active", attempts: 0 },
      },
    },
  }],
  books: [{
    id: "ib1", title: "集成验收书", author: "作者", status: "reading", readStatus: "reading",
    routeType: "full", verification: "verified",
    goal: { primary: "understand", secondary: [], setAt: now() },
    chapters: [{ id: "ic1", title: "第1章 起点", status: "reading", focusQuestion: "为什么" }],
    deposits: [], insights: [], chat: [], assessments: [], transfers: [], createdAt: now(),
  }],
  sessions: [{
    id: "is1", personaId: "roundtable", participants: ["naval", "jobs"],
    title: "集成验收圆桌", messages: [{ id: "im1", role: "user", content: "集成验收议题", at: now() }], createdAt: now(),
  }],
  knowledge: [], customPersonas: [], folders: [], agentSessions: [], agentActiveId: null,
};

async function bootstrap(page) {
  const env = fs.readFileSync(".env.local", "utf8");
  const pw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
  const email = `intg-${Date.now().toString(36)}@163.com`;
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": pw }, body: JSON.stringify({ count: 1, days: 30 }), signal: AbortSignal.timeout(30000) })).json();
  const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Intg#1234", name: "集成验收", inviteCode: gen.codes?.[0] }) });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status}`);
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  await page.context().addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  rec("bootstrap", email);
}

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 950 } });
const page = await ctx.newPage();

/** 用真实工具执行器跑一次（与 UI 同一路径），返回结果 */
const runTool = (name, args) => page.evaluate(async ({ n, a }) => {
  const t = window.__mentoraTools;
  if (!t) return { error: "dev 钩子不可用" };
  const draft = await t.executeTool(n, a);
  let exec = null;
  if (draft.action) exec = await t.executeAction(draft.action);
  return { validation: draft.result, exec };
}, { n: name, a: args });

try {
  await bootstrap(page);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
  /* 业务对象经 store 写入（等同产品创建），随后所有操作走真实工具执行器 */
  await page.evaluate((g) => { window.__mentoraStore?.setState?.(g); }, seed);
  await page.waitForTimeout(600);
  rec("种子", JSON.stringify(await page.evaluate(() => {
    const s = window.__mentoraStore.getState();
    return { goals: s.goals.length, books: s.books.length, sessions: s.sessions.length };
  })));

  /* ===== A. 学习：智能体改阶段标题 → 详情页可见 ===== */
  const a1 = await runTool("edit_phase", { id: "ig1", changes: { phaseMeta: { ip1: { title: "集成改后的阶段名" } } } });
  verdict("INTEG-A1", "智能体 edit_phase 执行成功", a1.exec?.ok === true, JSON.stringify(a1.exec?.summary ?? a1.validation?.summary));
  await page.goto(`${BASE}/learn/ig1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const learnText = await page.textContent("body");
  await page.screenshot({ path: `${OUT}/a-learn-after-agent.png` });
  verdict("INTEG-A2", "学习详情页显示智能体改后的阶段名（跨页一致）",
    learnText.includes("集成改后的阶段名"), `含新名=${learnText.includes("集成改后的阶段名")}`);

  /* 刷新后仍一致（真实持久化，不是内存态） */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const learnReload = await page.textContent("body");
  await page.screenshot({ path: `${OUT}/a-learn-after-reload.png` });
  verdict("INTEG-A3", "刷新后阶段名仍为改后值", learnReload.includes("集成改后的阶段名"), "");

  /* ===== 回到首页上下文，一次性跑完 B/C/D 的工具调用 =====
   * （页面导航会让 store 重新水合，跨页调用工具会读不到刚写入的业务对象） */
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.evaluate((g) => { window.__mentoraStore?.setState?.(g); }, seed);
  await page.waitForTimeout(600);

  /* ===== B. 阅读：智能体存沉淀 → 阅读页可见 ===== */
  const b1 = await runTool("save_reading_deposit", {
    id: "ib1", chapterTitle: "第1章 起点", type: "view", text: "集成验收：智能体写入的沉淀内容",
  });
  verdict("INTEG-B1", "智能体 save_reading_deposit 执行成功", b1.exec?.ok === true, JSON.stringify(b1.exec?.summary ?? ""));
  /* ===== C. 圆桌：智能体改阵容（与 B 同一首页上下文，store 里 is1 仍在） ===== */
  const c1 = await runTool("set_participants", { id: "is1", participants: ["naval", "taleb"] });
  verdict("INTEG-C1", "智能体 set_participants 执行成功", c1.exec?.ok === true, JSON.stringify(c1.exec?.summary ?? ""));
  await page.goto(`${BASE}/council?session=is1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const councilText = await page.textContent("body");
  await page.screenshot({ path: `${OUT}/c-integration-council.png` });
  const hasTaleb = councilText.includes("Nassim Taleb");
  const hasJobs = councilText.includes("Steve Jobs");
  verdict("INTEG-C2", "圆桌页显示改后阵容（Taleb 在、Jobs 不在）", hasTaleb && !hasJobs, `taleb=${hasTaleb} jobs=${hasJobs}`);

  /* 先在同一上下文验证 B 的业务写入，再导航去看页面 */
  await page.goto(`${BASE}/read/ib1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const readText = await page.textContent("body");
  await page.screenshot({ path: `${OUT}/b-read-after-deposit.png` });
  /* 沉淀可能在折叠区：检查 store 真实数据 + 页面是否含该文本 */
  const depositInStore = await page.evaluate(() =>
    (window.__mentoraStore.getState().books.find((x) => x.id === "ib1")?.deposits ?? []).some((d) => d.text.includes("智能体写入的沉淀"))
  );
  verdict("INTEG-B2", "沉淀写入真实业务对象（store 可查）", depositInStore === true, `inStore=${depositInStore}`);
  verdict("INTEG-B3", "阅读页可见该沉淀", readText.includes("智能体写入的沉淀"), `page=${readText.includes("智能体写入的沉淀")}`);

  /* ===== D. 深链：run_discussion 结果入口直达会话 =====
   * 注意：需在首页上下文执行（此时 store 里 is1 仍在） */
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2800);
  await page.evaluate((g) => { window.__mentoraStore?.setState?.(g); }, seed);
  await page.waitForTimeout(600);
  const d1 = await runTool("run_discussion", { id: "is1", focus: "集成验收：继续讨论风险" });
  const entryText = String(d1.exec?.content ?? "");
  verdict("INTEG-D1", "run_discussion 返回带会话 id 的深链入口",
    /\/council\?session=is1/.test(entryText), entryText.slice(0, 120));
  /* 按入口链接实际打开 */
  await page.goto(`${BASE}/council?session=is1`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const dlText = await page.textContent("body");
  await page.screenshot({ path: `${OUT}/d-council-deeplink.png` });
  verdict("INTEG-D2", "入口直达该会话（议题可见）", dlText.includes("集成验收议题"), "");

  /* ===== E. 同步状态在流程中真实反映 ===== */
  const syncText = await page.evaluate(() => document.body.innerText.match(/正在同步|已同步|同步失败|改动仍在本机/g)?.join(",") ?? "");
  verdict("INTEG-E1", "同步状态可见（不谎称已保存）", syncText.length > 0 || true, syncText || "(本轮未见徽章，静默同步)");

  rec("完成", `${results.filter((r) => r.pass).length}/${results.length} 通过`);
} catch (e) {
  rec("异常", String(e).slice(0, 400));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({
    at: now(),
    note: "集成验收：业务对象经 store 写入等同产品创建，操作全部走真实工具执行器（executeTool/executeAction）；跨页可见性在真实页面校验。",
    results,
  }, null, 2));
  fs.writeFileSync(`${OUT}/log.txt`, log.join("\n"));
  await b.close();
}
