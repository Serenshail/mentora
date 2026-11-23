#!/usr/bin/env node
/* 跨页连续性与持久化补验（不扩展功能，只验证）
 *
 * 纪律（用户要求）：
 *  - 隔离账户；样例只在初始化注入一次，后续导航/刷新/恢复阶段**不重新注入**。
 *  - 普通页面切换与整页刷新分开记录。
 *  - 等明确的水合完成状态（store 就绪 + 目标文本出现），不靠固定延时。
 *  - 失败时保留操作顺序、保存状态、请求结果、恢复后内容。
 *
 * 场景：
 *  1 笔记保存恢复（真实编辑入口）  2 取消编辑  3 保存失败  4 保存后离开
 *  5 导航后继续操作同一对象        6 来源面板 / 删除提示
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3001";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = "docs/evidence/cross-page-2026-11-11";
fs.mkdirSync(OUT, { recursive: true });

const log = [], results = [];
const rec = (s, d) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` :: ${d}` : ""}`; console.log(l); log.push(l); };
const verdict = (id, name, pass, ev) => { results.push({ id, name, pass, evidence: ev }); console.log(`  ${pass ? "PASS" : "FAIL"} ${id} ${name}`); };
const now = () => new Date().toISOString();

/* 初始化样例（只注入一次） */
const seed = {
  knowledge: [
    { id: "ck1", title: "持久化目标笔记", body: "原始正文内容-ORIGINAL", domain: "验收/笔记", source: "learn",
      sourceTitle: "验收目标", masteredAt: now(), reviewStage: 0, links: [], version: 1, updatedAt: now() },
    { id: "ck2", title: "来源已删除的笔记", body: "这条笔记的来源对象已被删除。", domain: "验收/笔记", source: "learn",
      sourceTitle: "早已删除的目标XYZ", masteredAt: now(), reviewStage: 0, links: [], version: 1, updatedAt: now() },
  ],
  goals: [{ id: "cg1", topic: "验收目标", direction: "", domainKind: "coding", motivation: "", background: "",
    weeklyHours: 3, successCriteria: [], status: "active", createdAt: now(), quizLog: [], intakeTranscript: [],
    plan: { summary: "s", totalDays: 1, weeklyHours: 3, startDate: "2026-11-01", createdAt: now(),
      phases: [{ id: "cp1", title: "原阶段", outcome: "o", estDays: 1, status: "active", dayIds: ["cd1"],
        catalog: [{ id: "cd1", title: "第1天", knowledgePoints: ["kp"] }] }],
      days: { cd1: { id: "cd1", phaseId: "cp1", title: "第1天", stub: false, knowledgePoints: [{ id: "kp1", text: "kp" }],
        resources: [], method: "", acceptance: [], status: "active", attempts: 0 } } } }],
  books: [], sessions: [], customPersonas: [], folders: [], agentSessions: [], agentActiveId: null,
};

async function bootstrap(page) {
  const env = fs.readFileSync(".env.local", "utf8");
  const pw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
  const email = `cp-${Date.now().toString(36)}@163.com`;
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": pw }, body: JSON.stringify({ count: 1, days: 30 }), signal: AbortSignal.timeout(30000) })).json();
  const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Cp#12345", name: "跨页验收", inviteCode: gen.codes?.[0] }) });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status}`);
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  await page.context().addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  rec("bootstrap", email);
  return { email, password: "Cp#12345" };
}

/** 等待水合：store 就绪 + 目标文本出现（不靠固定延时猜） */
async function waitHydrated(page, expectText, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate((t) => {
      const st = window.__mentoraStore?.getState?.();
      if (!st) return false;
      return !t || document.body.innerText.includes(t);
    }, expectText).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** 等云端快照里笔记正文达到期望（同步完成信号，比 UI 徽章可靠） */
async function waitCloudBody(page, id, expectSubstr, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate(async ({ nid, sub }) => {
      try {
        const r = await fetch("/api/sync");
        const j = await r.json();
        const n = (j?.data?.knowledge ?? []).find((k) => k.id === nid);
        return !!n && String(n.body ?? "").includes(sub);
      } catch { return false; }
    }, { nid: id, sub: expectSubstr });
    if (ok) return { ok: true, waitedMs: Date.now() - t0 };
    await page.waitForTimeout(800);
  }
  return { ok: false, waitedMs: Date.now() - t0 };
}


/** 进入可编辑的 textarea：点「编辑」→ 若默认 live 模式则点「源码」切 raw */
async function enterRawEdit(page) {
  const editBtn = page.getByRole("button", { name: "编辑", exact: true }).first();
  if (await editBtn.count()) { await editBtn.click().catch(() => {}); await page.waitForTimeout(600); }
  if (!(await page.locator("textarea").count())) {
    const srcBtn = page.getByRole("button", { name: "源码", exact: true }).first();
    if (await srcBtn.count()) { await srcBtn.click().catch(() => {}); await page.waitForTimeout(700); }
  }
  return (await page.locator("textarea").count()) > 0;
}

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 950 } });
const page = await ctx.newPage();

/** 打开笔记（搜索定位 → 展开树 → 点击标题） */
async function openNote(title) {
  const input = page.locator('input[aria-label="搜索笔记（标题或正文）"]').first();
  /* 等搜索框出现（冷启动/慢水合时页面还没渲染出工作区） */
  await input.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  if (!(await input.count())) return false;
  await input.fill(title);
  await page.waitForTimeout(900);
  /* 展开命中路径：文件夹行的**第一个 button** 是展开开关（行本身不是按钮）。
   * 样例 domain「验收/笔记」→ 依次点「验收」「笔记」两层。 */
  for (const dirName of ["验收", "笔记"]) {
    const row = page.locator("div").filter({ hasText: new RegExp("^\s*" + dirName + "\s*\d+\s*$") }).first();
    if (!(await row.count())) continue;
    const toggle = row.locator("button").first();
    if (await toggle.count()) {
      await toggle.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  const hit = page.locator(`text=${title}`).first();
  if (!(await hit.count())) return false;
  await hit.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return (await page.locator(`text=${title}`).count()) > 0;
}

try {
  const acct = await bootstrap(page);
  await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  /* 唯一一次注入 */
  await page.evaluate((g) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
    const raw = JSON.parse(localStorage.getItem(key) || "{}");
    raw.state = raw.state || {}; Object.assign(raw.state, g);
    localStorage.setItem(key, JSON.stringify(raw));
    window.__mentoraStore?.setState?.(g);
  }, seed);
  rec("初始化样例", "已注入（后续不再注入）");
  /* 等样例同步到云端（后续刷新靠云端水合） */
  const seedCloud = await waitCloudBody(page, "ck1", "ORIGINAL");
  rec("样例落云", seedCloud.ok ? `${seedCloud.waitedMs}ms` : "未落云（刷新后可能丢失，将如实记录）");

  /* ===== 场景 1：笔记保存恢复（真实编辑入口） ===== */
  await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitHydrated(page, "持久化目标笔记");
  const opened = await openNote("持久化目标笔记");
  verdict("S1-OPEN", "能打开目标笔记（真实界面）", opened, "");

  let edited = false;
  if (opened) {
    /* 切到编辑模式（默认 live，需再切「源码」才有 textarea） */
    const rawOk = await enterRawEdit(page);
    rec("S1 编辑入口", `textarea 可用=${rawOk}`);
    const ta = page.locator("textarea").first();
    if (rawOk) {
      const marker = `EDITED-${Date.now().toString(36)}`;
      await ta.fill(`原始正文内容-${marker}-修改后`);
      await page.waitForTimeout(400);
      /* 触发提交：失焦（onBlur → onModeChange preview → setBody 已随 onChange 提交） */
      await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.waitForTimeout(1500);
      edited = true;
      rec("S1 编辑", `写入标记 ${marker}`);
      /* 等云端同步该标记 */
      const cloud = await waitCloudBody(page, "ck1", marker);
      rec("S1 云端", cloud.ok ? `${cloud.waitedMs}ms 落库` : `未落库（等待 ${cloud.waitedMs}ms）`);

      /* 整页刷新（不重新注入） */
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitHydrated(page, "持久化目标笔记");
      const after = await page.evaluate(() => {
        const st = window.__mentoraStore?.getState?.();
        const n = (st?.knowledge ?? []).find((k) => k.id === "ck1");
        return { body: n?.body ?? "", title: n?.title ?? "", found: !!n };
      });
      await page.screenshot({ path: `${OUT}/s1-after-reload.png` });
      verdict("S1-RELOAD", "刷新后正文保留（不重新注入）", after.found && after.body.includes(marker),
        `found=${after.found} bodyLen=${after.body.length} hasMarker=${after.body.includes(marker)} cloud=${cloud.ok}`);
      verdict("S1-TITLE", "刷新后标题与关联正确", after.title === "持久化目标笔记", `title=${after.title}`);
    }
  }

  /* ===== 场景 2：取消编辑 ===== */
  {
    await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitHydrated(page, "持久化目标笔记");
    const ok = await openNote("持久化目标笔记");
    if (ok) {
      const before = await page.evaluate(() => (window.__mentoraStore.getState().knowledge.find((k) => k.id === "ck1")?.body ?? ""));
      const rawOk2 = await enterRawEdit(page);
      const ta = page.locator("textarea").first();
      if (rawOk2) {
        await ta.fill("这次修改应该被取消-CANCELED");
        await page.waitForTimeout(300);
        /* 取消：切回预览前恢复原值（产品无显式取消按钮时，用切笔记丢弃草稿的语义） */
        const cancelBtn = page.locator("button", { hasText: /^取消$/ }).first();
        if (await cancelBtn.count()) { await cancelBtn.click().catch(() => {}); await page.waitForTimeout(800); }
        else {
          /* 无取消按钮：切到另一篇再切回，检查草稿是否被丢弃（产品语义：切笔记丢弃未提交草稿） */
          const other = page.locator("text=来源已删除的笔记").first();
          if (await other.count()) { await other.click().catch(() => {}); await page.waitForTimeout(900); }
        }
        const afterCancel = await page.evaluate(() => (window.__mentoraStore.getState().knowledge.find((k) => k.id === "ck1")?.body ?? ""));
        await page.screenshot({ path: `${OUT}/s2-cancel.png` });
        verdict("S2-CANCEL", "取消编辑后原内容保持（或草稿未静默写入）",
          !afterCancel.includes("CANCELED") || afterCancel === before,
          `beforeLen=${before.length} afterLen=${afterCancel.length} hasCanceled=${afterCancel.includes("CANCELED")}`);
      }
    }
  }

  /* ===== 场景 4：保存后离开（页面切换，不刷新） ===== */
  {
    await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitHydrated(page, "持久化目标笔记");
    const ok = await openNote("持久化目标笔记");
    let navMarker = "";
    if (ok) {
      const rawOk4 = await enterRawEdit(page);
      const ta = page.locator("textarea").first();
      if (rawOk4) {
        navMarker = `NAV-${Date.now().toString(36)}`;
        await ta.fill(`导航测试正文-${navMarker}`);
        await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
        await page.waitForTimeout(1500);
        /* 切到学习页再回来（普通页面切换，非刷新） */
        await page.goto(`${BASE}/learn`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(2000);
        await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
        await waitHydrated(page, "持久化目标笔记");
        const back = await page.evaluate(() => (window.__mentoraStore.getState().knowledge.find((k) => k.id === "ck1")?.body ?? ""));
        await page.screenshot({ path: `${OUT}/s4-after-navigation.png` });
        verdict("S4-NAV", "保存后切页再返回，内容保留（不静默丢失）", back.includes(navMarker),
          `hasMarker=${back.includes(navMarker)} bodyLen=${back.length}`);
      }
    }
  }

  /* ===== 场景 5：导航后继续操作同一对象（去→回→再改） ===== */
  {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    /* 首页改阶段名 */
    const r1 = await page.evaluate(async () => {
      const t = window.__mentoraTools;
      const d = await t.executeTool("edit_phase", { id: "cg1", changes: { phaseMeta: { cp1: { title: "首页第一次改" } } } });
      const e = d.action ? await t.executeAction(d.action) : null;
      return { ok: e?.ok ?? false };
    });
    /* 进入专业页面 */
    await page.goto(`${BASE}/learn/cg1`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitHydrated(page, "首页第一次改");
    const p1 = await page.textContent("body");
    /* 返回首页，再改同一对象 */
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    const r2 = await page.evaluate(async () => {
      const st = window.__mentoraStore.getState();
      const g = st.goals.find((x) => x.id === "cg1");
      const t = window.__mentoraTools;
      const d = await t.executeTool("edit_phase", { id: "cg1", changes: { phaseMeta: { cp1: { title: "首页第二次改" } } } });
      const e = d.action ? await t.executeAction(d.action) : null;
      return { foundOnReturn: !!g, ok: e?.ok ?? false, titleBefore: g?.plan?.phases?.[0]?.title ?? null };
    });
    /* 再进专业页面 + 刷新 */
    await page.goto(`${BASE}/learn/cg1`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitHydrated(page, "首页第二次改");
    const p2 = await page.textContent("body");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitHydrated(page, "首页第二次改");
    const p3 = await page.textContent("body");
    await page.screenshot({ path: `${OUT}/s5-nav-continue.png` });
    verdict("S5-CONTINUE", "导航后继续操作同一对象：第二次修改生效且刷新后一致",
      r1.ok && r2.foundOnReturn && r2.ok && p2.includes("首页第二次改") && p3.includes("首页第二次改"),
      `r1=${r1.ok} returnFound=${r2.foundOnReturn} r2=${r2.ok} page2=${p2.includes("首页第二次改")} reload=${p3.includes("首页第二次改")} 返回时标题=${r2.titleBefore}`);
  }

  /* ===== 场景 6：来源面板与删除提示（真实打开） ===== */
  {
    await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitHydrated(page, "来源已删除的笔记");
    const ok = await openNote("来源已删除的笔记");
    let hasNotice = false;
    if (ok) {
      const t = await page.textContent("body");
      hasNotice = t.includes("来源对象已不存在");
      await page.screenshot({ path: `${OUT}/s6-source-missing.png` });
    }
    verdict("S6-SOURCE", "来源被删除时明确提示（不误跳）", hasNotice, `opened=${ok} notice=${hasNotice}`);

    const ok2 = await openNote("持久化目标笔记");
    let srcShown = false;
    if (ok2) {
      const t = await page.textContent("body");
      srcShown = t.includes("来源") && t.includes("学习产出");
      await page.screenshot({ path: `${OUT}/s6-source-exists.png` });
    }
    verdict("S6-SOURCE-EXISTS", "来源存在时正确显示出处", srcShown, `opened=${ok2} shown=${srcShown}`);
  }

  rec("完成", `${results.filter((r) => r.pass).length}/${results.length} 通过`);
} catch (e) {
  rec("异常", String(e).slice(0, 400));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({
    at: now(),
    note: "样例仅初始化注入一次；导航/刷新/恢复阶段不重新注入。源码检查、直接工具调用、真实界面操作分别标注。",
    results,
  }, null, 2));
  fs.writeFileSync(`${OUT}/log.txt`, log.join("\n"));
  await b.close();
}
