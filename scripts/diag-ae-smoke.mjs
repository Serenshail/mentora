/* V26.2 诊断：A 场景精确复现 + E 场景全流程验证（含 H5 语义断言：历史留痕/成绩保留/目录更新） */
import { chromium } from "playwright-core";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const EXE = process.env.SMOKE_CHROME ?? "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const PROBE_EMAIL = process.env.SMOKE_PROBE_EMAIL || "probe-x2@163.com";
const PROBE_PW = process.env.SMOKE_PROBE_PW || "Pr#obe123";

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PW }),
  signal: AbortSignal.timeout(30000),
});
const token = /mentora_session=([^;]+)/.exec(loginRes.headers.get("set-cookie") || "")?.[1];
if (!token) throw new Error("probe login failed");

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: "mentora_session", value: token, url: BASE }]);
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 150)));

const today = new Date().toISOString().slice(0, 10);
const stubDay = (id, phaseId, title, kps) => ({
  id, phaseId, title, stub: true,
  knowledgePoints: kps.map((t, i) => ({ id: `${id}-kp${i + 1}`, text: t })),
  resources: [], method: "", acceptance: [], status: "locked", attempts: 0,
});

const storeMutate = (op, payload = null) =>
  page.evaluate(({ op, payload }) => {
    const hits = [];
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith("mentora-store-") || k.includes("anon")) continue;
      try {
        const st = JSON.parse(localStorage.getItem(k) || "{}");
        if (!st?.state) continue;
        if (op === "reset") {
          st.state.agentSessions = [];
          st.state.agentChat = [];
          st.state.agentActiveId = null;
        } else if (op === "goal") {
          st.state.goals = [payload, ...(st.state.goals ?? []).filter((x) => x.id !== payload.id)];
        }
        localStorage.setItem(k, JSON.stringify(st));
        hits.push(k);
      } catch {}
    }
    return hits;
  }, { op, payload });

/* ---------- Part 1: A 场景精确复现 ---------- */
console.log("=== Part 1: A 复现（reset→goto→新对话→fill） ===");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
console.log("reset:", await storeMutate("reset"));
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
const ncBtn = page.getByRole("button", { name: /新对话/ }).first();
try { await ncBtn.click({ timeout: 8000 }); } catch { console.log("新对话点击失败（可能不存在）"); }
await page.waitForTimeout(600);
const aState = await page.evaluate(() => {
  const input = [...document.querySelectorAll("input")].find((i) => /提问、搜索/.test(i.placeholder || ""));
  const modal = document.querySelector("[role=dialog]");
  return { found: !!input, disabled: input ? input.disabled : null,
    btns: [...document.querySelectorAll("button")].filter((b) => /新对话/.test(b.textContent || "")).length,
    modalText: modal ? (modal.textContent || "").slice(0, 120) : "" };
});
console.log("A 复现 composer 状态:", JSON.stringify(aState), "pageerrors:", errors.length);

/* ---------- Part 2: E 场景全流程（真实重排 + H5 语义断言） ---------- */
console.log("=== Part 2: E 全流程 ===");
const seedGoalE = {
  id: "goal-v26e-diag", topic: "重排诊断学科",
  direction: "诊断阶段重排语义", domainKind: "coding", motivation: "（诊断）", background: "（诊断）",
  weeklyHours: 8, successCriteria: ["完成一次重排"],
  status: "active", createdAt: new Date().toISOString(), quizLog: [], intakeTranscript: [],
  plan: {
    summary: "单阶段三天的最小计划。", totalDays: 3, weeklyHours: 8,
    startDate: today, createdAt: new Date().toISOString(),
    phases: [{
      id: "ph-v26e-diag", title: "第一阶段：重排诊断", outcome: "能完成阶段重排",
      dayIds: ["day-e1", "day-e2", "day-e3"], status: "active", planned: false,
      catalog: [
        { id: "day-e1", title: "Day 1：理论先行的骨架", knowledgePoints: ["知识点甲"] },
        { id: "day-e2", title: "Day 2：概念辨析的骨架", knowledgePoints: ["知识点乙"] },
        { id: "day-e3", title: "Day 3：综合练习的骨架", knowledgePoints: ["知识点丙"] },
      ],
    }],
    days: {
      "day-e1": stubDay("day-e1", "ph-v26e-diag", "Day 1：理论先行的骨架", ["知识点甲"]),
      "day-e2": stubDay("day-e2", "ph-v26e-diag", "Day 2：概念辨析的骨架", ["知识点乙"]),
      "day-e3": stubDay("day-e3", "ph-v26e-diag", "Day 3：综合练习的骨架", ["知识点丙"]),
    },
  },
};
await storeMutate("goal", seedGoalE);
await page.goto(`${BASE}/learn/goal-v26e-diag`, { waitUntil: "domcontentloaded", timeout: 60000 });
const panel = await page.getByText("下一程").first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
console.log("下一程 面板出现:", panel);
const btnCount = await page.getByRole("button", { name: /重排本阶段/ }).count();
console.log("重排按钮数量（H6 应为 2：面板+路径列表）:", btnCount);
page.once("dialog", (d) => d.accept("想要更实践向的内容").catch(() => {}));
await page.getByRole("button", { name: /重排本阶段/ }).first().click();
/* 等完成 toast（成功=「目录已重排」，失败=error）——最长 180s */
const done = await page.waitForFunction(() => {
  const toasts = [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent || "");
  return toasts.find((t) => t.includes("目录已重排") || t.includes("重排失败") || t.includes("失败")) || null;
}, null, { timeout: 180000 }).then((h) => h()).catch(() => null);
console.log("重排结果 toast:", done || "(180s 内未见终态 toast)");
await page.waitForTimeout(1000);
const after = await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("mentora-store-") || k.includes("anon")) continue;
    try {
      const st = JSON.parse(localStorage.getItem(k) || "{}");
      const g = (st?.state?.goals ?? []).find((x) => x.id === "goal-v26e-diag");
      if (!g?.plan) continue;
      const ph = g.plan.phases[0];
      return {
        newCatalog: ph.catalog?.map((c) => c.title) ?? [],
        dayIdsReused: ph.dayIds.filter((id) => ["day-e1", "day-e2", "day-e3"].includes(id)).length,
        historyLen: (g.planHistory ?? []).length,
        historyReason: g.planHistory?.[0]?.reason ?? "",
        daysCount: Object.keys(g.plan.days).length,
        quizLogLen: (g.quizLog ?? []).length,
      };
    } catch {}
  }
  return null;
});
console.log("H5 语义断言:", JSON.stringify(after));
console.log("pageerrors:", errors.length ? errors : "(none)");
await browser.close();
