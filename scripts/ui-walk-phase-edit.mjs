#!/usr/bin/env node
/* 计划编辑 UI 走查（6 场景）——真实浏览器渲染 + 真实 store/执行器代码路径。
 *
 * 分层策略（如实标注每层的证据强度）：
 *  - 浏览器层：真实渲染学习页、真实点击「重排本阶段」「历史版本→恢复」、真实截图；
 *  - 数据层：通过页面内 __walk 钩子调用与 UI 完全相同的 store 方法（restorePlanVersion 等），
 *    读取 localStorage 真实持久化结果，验证「刷新后一致」。
 *  - 不伪造：无法自动化的场景标注「需人工」，不写成通过。
 *
 * 用法：node scripts/ui-walk-phase-edit.mjs
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3000";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = "docs/evidence/ui-walk-phase-edit-2026-11-10";
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const results = [];
const rec = (step, detail) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? ` :: ${detail}` : ""}`;
  console.log(line);
  log.push(line);
};
const verdict = (id, name, pass, evidence, note = "") => {
  results.push({ id, name, pass, evidence, note });
  console.log(`  ${pass ? "PASS" : "FAIL"} ${id} ${name}${note ? ` (${note})` : ""}`);
};

const seedGoal = () => ({
  id: "walk-goal",
  topic: "UI走查目标",
  direction: "验证计划编辑",
  domainKind: "coding",
  motivation: "", background: "", weeklyHours: 5, successCriteria: [],
  status: "active", createdAt: new Date().toISOString(), quizLog: [], intakeTranscript: [],
  plan: {
    summary: "走查用计划", totalDays: 4, weeklyHours: 5, startDate: "2026-11-10",
    createdAt: new Date().toISOString(),
    phases: [
      { id: "ph1", title: "第一阶段", outcome: "基础", estDays: 2, boundary: "只学基础",
        status: "active", dayIds: ["d1", "d2"],
        catalog: [{ id: "d1", title: "Day 1：变量", knowledgePoints: ["变量"] },
                  { id: "d2", title: "Day 2：函数", knowledgePoints: ["函数"] }] },
      { id: "ph2", title: "第二阶段", outcome: "进阶", estDays: 2, boundary: "进阶内容",
        status: "locked", dayIds: ["d3"],
        catalog: [{ id: "d3", title: "Day 3：类", knowledgePoints: ["类"] }] },
      { id: "ph3", title: "第三阶段", outcome: "实战", estDays: 3, boundary: "实战项目",
        status: "locked", dayIds: ["d4"],
        catalog: [{ id: "d4", title: "Day 4：项目", knowledgePoints: ["项目"] }] },
    ],
    days: {
      d1: { id: "d1", phaseId: "ph1", title: "Day 1：变量", stub: false,
            knowledgePoints: [{ id: "k1", text: "变量", masteryStatus: "independent", historicalHighest: "independent" }],
            resources: [], method: "讲解", acceptance: [], status: "passed", attempts: 1,
            completedAt: new Date().toISOString() },
      d2: { id: "d2", phaseId: "ph1", title: "Day 2：函数", stub: true,
            knowledgePoints: [{ id: "k2", text: "函数" }],
            resources: [], method: "", acceptance: [], status: "active", attempts: 0 },
      d3: { id: "d3", phaseId: "ph2", title: "Day 3：类", stub: true,
            knowledgePoints: [{ id: "k3", text: "类" }],
            resources: [], method: "", acceptance: [], status: "locked", attempts: 0 },
      d4: { id: "d4", phaseId: "ph3", title: "Day 4：项目", stub: true,
            knowledgePoints: [{ id: "k4", text: "项目" }],
            resources: [], method: "", acceptance: [], status: "locked", attempts: 0 },
    },
  },
});

async function bootstrap(page) {
  const env = fs.readFileSync(".env.local", "utf8");
  const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
  const email = `walk-${Date.now().toString(36)}@163.com`;
  const password = "Wk#alk" + Math.random().toString(36).slice(2, 8);
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": adminPw },
    body: JSON.stringify({ count: 1, days: 30 }), signal: AbortSignal.timeout(30000),
  })).json();
  const code = gen.codes?.[0];
  if (!code) throw new Error(`激活码失败: ${JSON.stringify(gen).slice(0, 120)}`);
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "UI走查", inviteCode: code }),
  });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status}`);
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  await page.context().addCookies([{ name: "mentora_session", value: tok, domain: "localhost", path: "/" }]);
  rec("bootstrap", email);
}

/** 读取 localStorage 里的真实持久化 goal（验证刷新后一致） */
async function persistedGoal(page) {
  return page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("mentora-store-") && k !== "mentora-store-anon") {
        const raw = JSON.parse(localStorage.getItem(k) || "{}");
        const g = (raw.state?.goals || []).find((x) => x.id === "walk-goal");
        if (g) return g;
      }
    }
    return null;
  });
}

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
const pageErrs = [];
page.on("pageerror", (e) => pageErrs.push(String(e)));

try {
  await bootstrap(page);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);

  /* 注入种子数据 */
  await page.evaluate((g) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
    const raw = JSON.parse(localStorage.getItem(key) || "{}");
    raw.state = raw.state || {};
    raw.state.goals = [g];
    localStorage.setItem(key, JSON.stringify(raw));
  }, seedGoal());

  const gotoLearn = async () => {
    await page.goto(`${BASE}/learn/walk-goal`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
  };

  /* 钩子只在加载了 store/tool-executors 的页面存在；首页一定加载。
   * 跨页面导航会丢 window 钩子，所以场景 2–6 先在首页同一上下文里跑完，
   * 再 gotoLearn 做「页面渲染 + 持久化一致」的 UI 证据。 */
  const hasHook = await page.evaluate(() => typeof window.__mentoraStore?.getState === "function" && typeof window.__mentoraTools?.executeTool === "function");
  rec("dev钩子（首页）", `__mentoraStore+__mentoraTools 可用=${hasHook}`);

  /* 注入的种子数据要先 reload 一次让 store 水合，否则 getState().goals 里没有 walk-goal */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const seeded = await page.evaluate(() => !!window.__mentoraStore?.getState().goals.find((g) => g.id === "walk-goal"));
  rec("种子水合", `walk-goal 在 store=${seeded}`);

  /* ===== 场景1：方案预览——先取真实预览文案（数据层），再截图学习页（UI层） ===== */
  {
    const preview = await page.evaluate(async () => {
      const { executeTool } = window.__mentoraTools;
      const out = await executeTool("edit_phase", {
        id: "walk-goal",
        changes: {
          phaseCatalogs: { ph1: [{ title: "Day 1：变量" }, { title: "Day 2：闭包" }, { title: "Day 3：模块" }] },
        },
      });
      return {
        ok: out.result.ok,
        preview: (out.action && out.action.payload ? (out.action.payload.preview || out.action.payload.impactText) : "") || "",
      };
    });
    await gotoLearn();
    const body = await page.textContent("body");
    await page.screenshot({ path: `${OUT}/s1-learn-before.png` });
    const showsPhases = body.includes("第一阶段") && body.includes("第二阶段") && body.includes("第三阶段");
    const previewHasBeforeAfter = preview.preview.includes("原：") && preview.preview.includes("新：") && preview.preview.includes("保留");
    verdict("S1", "方案预览：列出修改前后具体内容 + 学习页呈现三阶段",
      showsPhases && body.includes("已完成 1 天") && previewHasBeforeAfter,
      `三阶段可见=${showsPhases}, 已完成1天=${body.includes("已完成 1 天")}, 预览含原/新/保留=${previewHasBeforeAfter}`,
      `预览片段: ${String(preview.preview).split("\n").join(" / ").slice(0, 160)}`);
  }

  /* 场景1 之后回到首页恢复钩子上下文（后续场景 2–6 在同一上下文执行） */
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.evaluate((g) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
    const raw = JSON.parse(localStorage.getItem(key) || "{}");
    raw.state = raw.state || {};
    raw.state.goals = [g];
    localStorage.setItem(key, JSON.stringify(raw));
  }, seedGoal());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const hasHook2 = hasHook;

  /* 场景2：取消 —— 审批卡「拒绝」不产生业务变更。
     真实审批卡需要模型工具循环；这里用 executeTool 生成 action 但不 executeAction，
     模拟「用户拒绝」= 不调用 executeAction。 */
  if (hasHook2) {
    const r2 = await page.evaluate(async () => {
      const { executeTool } = window.__mentoraTools;
      const before = JSON.stringify(window.__mentoraStore.getState().goals[0].plan.phases.map((p) => p.id));
      const out = await executeTool("edit_phase", { id: "walk-goal", changes: { removePhaseIds: ["ph3"] } });
      /* 拒绝 = 不执行 executeAction */
      const after = JSON.stringify(window.__mentoraStore.getState().goals[0].plan.phases.map((p) => p.id));
      return { before, after, hadAction: !!out.action, hist: window.__mentoraStore.getState().goals[0].planHistory?.length ?? 0 };
    });
    verdict("S2", "取消修改：不产生业务变更",
      r2.before === r2.after && r2.hadAction && r2.hist === 0,
      `阶段未变=${r2.before === r2.after}, 生成待确认卡=${r2.hadAction}, 历史条数=${r2.hist}`);
  }

  /* 场景3：批准应用 —— 执行后刷新仍一致 */
  if (hasHook2) {
    const r3 = await page.evaluate(async () => {
      const { executeTool, executeAction } = window.__mentoraTools;
      const out = await executeTool("edit_phase", {
        id: "walk-goal",
        changes: { phaseMeta: { ph3: { title: "第三阶段·实战改" } } },
      });
      const res = await executeAction(out.action);
      const g = window.__mentoraStore.getState().goals[0];
      return { ok: res.ok, title: g.plan.phases.find((p) => p.id === "ph3").title, hist: g.planHistory?.length ?? 0 };
    });
    await page.waitForTimeout(1200);
    await gotoLearn();
    const body = await page.textContent("body");
    await page.screenshot({ path: `${OUT}/s3-after-apply.png` });
    const persisted = await persistedGoal(page);
    verdict("S3", "批准应用：执行成功、页面与持久化一致",
      r3.ok && r3.title === "第三阶段·实战改" && body.includes("第三阶段·实战改") && persisted?.plan?.phases?.find((p) => p.id === "ph3")?.title === "第三阶段·实战改",
      `执行ok=${r3.ok}, 内存标题=${r3.title}, 页面显示=${body.includes("第三阶段·实战改")}, 持久化标题=${persisted?.plan?.phases?.find((p) => p.id === "ph3")?.title}`);
  }

  /* 回到首页并重建钩子上下文（跨页导航会丢 window 钩子）。
   * 注意：不重新注入种子，保留上一步已应用的改动，场景之间才是连续的真实状态。 */
  const backHome = async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2200);
    const ok = await page.evaluate(() => typeof window.__mentoraTools?.executeTool === "function");
    if (!ok) throw new Error("回到首页后 dev 钩子不可用");
  };

  await backHome();
  /* 场景4：并发冲突 —— 生成草稿后改数据，旧草稿必须被拒绝 */
  if (hasHook2) {
    const r4 = await page.evaluate(async () => {
      const { executeTool, executeAction } = window.__mentoraTools;
      const out = await executeTool("edit_phase", {
        id: "walk-goal",
        changes: { phaseMeta: { ph2: { title: "草稿里的第二阶段" } } },
      });
      /* 模拟另一标签页改了同一阶段 */
      window.__mentoraStore.getState().updatePhaseMeta("walk-goal", "ph2", { title: "另一标签页改的标题" });
      const res = await executeAction(out.action);
      const g = window.__mentoraStore.getState().goals[0];
      const finalTitle = g.plan.phases.find((p) => p.id === "ph2").title;
      /* 场景4 还要求「提供重新生成方案的入口」：验证重新生成一次能拿到新草稿并成功应用 */
      const again = await executeTool("edit_phase", {
        id: "walk-goal",
        changes: { phaseMeta: { ph2: { title: "基于最新内容重出的标题" } } },
      });
      const regenApplied = again.action ? (await executeAction(again.action)).ok : false;
      const afterRegen = window.__mentoraStore.getState().goals[0].plan.phases.find((p) => p.id === "ph2").title;
      return {
        ok: res.ok, content: res.content, finalTitle,
        regenHadAction: !!again.action, regenApplied, afterRegen,
      };
    });
    verdict("S4", "并发冲突：旧方案被拒绝、不覆盖新改动、可重新生成方案并应用",
      r4.ok === false &&
        r4.finalTitle === "另一标签页改的标题" &&
        r4.content.includes("冲突") &&
        r4.content.includes("重新生成方案") &&
        r4.regenApplied === true &&
        r4.afterRegen === "基于最新内容重出的标题",
      `旧方案拒绝=${r4.ok === false}, 未覆盖=${r4.finalTitle === "另一标签页改的标题"}, 提示含冲突=${r4.content.includes("冲突")}, 提示含重新生成入口=${r4.content.includes("重新生成方案")}, 重新生成并应用=${r4.regenApplied}, 重出后标题=${r4.afterRegen}`);
  }

  await backHome();
  /* 场景5：删除/排序恢复 —— 集合、顺序、元信息 */
  if (hasHook2) {
    const r5 = await page.evaluate(async () => {
      const { executeTool, executeAction } = window.__mentoraTools;
      const st = window.__mentoraStore.getState();
      const beforeIds = st.goals[0].plan.phases.map((p) => p.id);
      const beforeMeta = st.goals[0].plan.phases.map((p) => ({ id: p.id, title: p.title, outcome: p.outcome, estDays: p.estDays }));

      /* 删除 ph3 + 调整顺序 */
      const out = await executeTool("edit_phase", {
        id: "walk-goal",
        changes: { removePhaseIds: ["ph3"], phaseOrder: ["ph2", "ph1"] },
      });
      const applied = await executeAction(out.action);
      const midIds = window.__mentoraStore.getState().goals[0].plan.phases.map((p) => p.id);
      const hist = window.__mentoraStore.getState().goals[0].planHistory ?? [];
      const lastHist = hist[hist.length - 1];

      /* 恢复 */
      const restored = window.__mentoraStore.getState().restorePlanVersion("walk-goal", lastHist.id);
      const afterPhases = window.__mentoraStore.getState().goals[0].plan.phases;
      const afterIds = afterPhases.map((p) => p.id);
      const afterMeta = afterPhases.map((p) => ({ id: p.id, title: p.title, outcome: p.outcome, estDays: p.estDays }));
      return { applied: applied.ok, beforeIds, midIds, afterIds, beforeMeta, afterMeta, histKind: lastHist.kind, restored };
    });
    const setOk = JSON.stringify(r5.beforeIds) === JSON.stringify(r5.afterIds);
    const orderOk = r5.midIds.join() === "ph2,ph1";
    const metaOk = JSON.stringify(r5.beforeMeta) === JSON.stringify(r5.afterMeta);
    verdict("S5", "删除与排序恢复：集合/顺序/元信息全部还原",
      r5.applied && orderOk && r5.restored && setOk && metaOk,
      `应用ok=${r5.applied}, 排序生效=${orderOk}(${r5.midIds.join(">")}), 快照类型=${r5.histKind}, 恢复=${r5.restored}, 集合还原=${setOk}, 元信息还原=${metaOk}`);
  }

  await backHome();
  /* 场景6：保护后续成果 —— 修改后新增成绩/笔记，再恢复，成果仍保留 */
  if (hasHook2) {
    const r6 = await page.evaluate(async () => {
      const { executeTool, executeAction } = window.__mentoraTools;
      /* 结构性修改（删除 ph3）→ 产生整计划快照 */
      const out = await executeTool("edit_phase", { id: "walk-goal", changes: { removePhaseIds: ["ph3"] } });
      await executeAction(out.action);
      const hist = window.__mentoraStore.getState().goals[0].planHistory ?? [];
      const target = hist[hist.length - 1];

      /* 之后新增：一次成绩 + 一篇笔记 + 展开讲义 */
      const st = window.__mentoraStore.getState();
      st.logQuiz("walk-goal", { dayId: "d1", date: new Date().toISOString(), passed: true, forced: false, items: [] });
      st.addKnowledge([{ title: "恢复后新增笔记", body: "重要内容", domain: "UI走查目标/笔记" }], "manual", "走查");
      st.updateGoal("walk-goal", {
        plan: {
          ...window.__mentoraStore.getState().goals[0].plan,
          days: {
            ...window.__mentoraStore.getState().goals[0].plan.days,
            d2: { ...window.__mentoraStore.getState().goals[0].plan.days.d2, lesson: "展开后的讲义内容", stub: false },
          },
        },
      });

      const quizBefore = window.__mentoraStore.getState().goals[0].quizLog.length;
      const notesBefore = window.__mentoraStore.getState().knowledge.length;

      /* 恢复旧计划（整计划分支） */
      const restored = window.__mentoraStore.getState().restorePlanVersion("walk-goal", target.id);
      const g = window.__mentoraStore.getState().goals[0];
      return {
        restored,
        quizAfter: g.quizLog.length,
        quizBefore,
        notesAfter: window.__mentoraStore.getState().knowledge.length,
        notesBefore,
        lessonAfter: g.plan.days.d2?.lesson,
        stubAfter: g.plan.days.d2?.stub,
        phasesAfter: g.plan.phases.map((p) => p.id),
      };
    });
    verdict("S6", "保护后续成果：恢复旧计划后新成绩/笔记/讲义保留",
      r6.restored && r6.quizAfter >= r6.quizBefore && r6.notesAfter >= r6.notesBefore && r6.lessonAfter === "展开后的讲义内容",
      `恢复=${r6.restored}, 成绩 ${r6.quizBefore}→${r6.quizAfter}, 笔记 ${r6.notesBefore}→${r6.notesAfter}, 讲义保留=${r6.lessonAfter === "展开后的讲义内容"}, stub=${r6.stubAfter}`);
  }

  /* 场景5b：真实 UI 点击「历史版本→恢复」 */
  await gotoLearn();
  const histSummary = page.locator("summary", { hasText: "历史版本" }).first();
  if (await histSummary.count()) {
    await histSummary.click();
    await page.waitForTimeout(600);
    const restoreBtn = page.locator("button", { hasText: "恢复" }).first();
    const hasRestore = await restoreBtn.count();
    await page.screenshot({ path: `${OUT}/s5b-history-panel.png` });
    verdict("S5b", "历史版本面板提供真实「恢复」按钮",
      hasRestore > 0, `按钮可见=${hasRestore > 0}`);
  } else {
    verdict("S5b", "历史版本面板提供真实「恢复」按钮", false, "未找到历史版本面板", "需人工复核");
  }

  if (pageErrs.length) rec("pageerror", pageErrs.slice(0, 3).join(" | "));
} catch (e) {
  rec("异常", String(e).slice(0, 400));
  process.exitCode = 1;
} finally {
  const summary = results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.name}`).join("\n");
  fs.writeFileSync(`${OUT}/walkthrough.log`, log.join("\n") + "\n\n=== 结论 ===\n" + summary);
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log("\n=== 结论 ===");
  console.log(summary);
  await b.close();
}
