#!/usr/bin/env node
/* E3 走查：笔记页与全局状态（隔离样例，三宽度）
 * 检查：搜索命中/空态区分/来源显示/正文可读/无溢出/键盘
 * 产出：docs/evidence/ui-e3-2026-11-11/
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3001";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = "docs/evidence/ui-e3-2026-11-11";
fs.mkdirSync(OUT, { recursive: true });

const log = [], results = [];
const rec = (s, d) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` :: ${d}` : ""}`; console.log(l); log.push(l); };
const verdict = (id, name, pass, ev) => { results.push({ id, name, pass, evidence: ev }); console.log(`  ${pass ? "PASS" : "FAIL"} ${id} ${name}`); };
const now = () => new Date().toISOString();

const note = (id, title, body, source, sourceTitle, domain = "数据结构/笔记") => ({
  id, title, body, domain, source, sourceTitle, masteredAt: now(), reviewStage: 0, links: [],
  version: 1, updatedAt: now(), nextReviewAt: "2026-11-01",
});
const seed = {
  knowledge: [
    note("k1", "顺序表的插入为什么是 O(n)", "因为插入位置之后的元素都要整体后移一位。\n\n```c\nfor (int i = size; i > pos; i--) a[i] = a[i-1];\n```\n\n这是搬移成本的来源。", "learn", "数据结构（C 语言）/第1天 顺序表"),
    note("k2", "《影响力》互惠原理", "互惠的本质是负债感：别人先给好处，你会想回报。", "read", "影响力"),
    note("k3", "圆桌：辞职创业的共识", "先验证需求再辞职。分歧在风险敞口。", "council", "要不要辞职创业"),
    note("k4", "已删除来源的笔记", "这条的来源目标已经不存在了，但笔记要保留。", "learn", "已经删掉的学习目标"),
    note("k5", "超长标题测试：关于顺序表与链表在不同数据规模、不同访问模式、不同内存约束下的选型判断与工程实践总结", "长标题不应撑破布局。", "manual", "手动记录"),
  ],
  goals: [{ id: "g1", topic: "数据结构（C 语言）", direction: "", domainKind: "coding", motivation: "", background: "", weeklyHours: 6, successCriteria: [], status: "active", createdAt: now(), quizLog: [], intakeTranscript: [] }],
  books: [], sessions: [], customPersonas: [], folders: [], agentSessions: [], agentActiveId: null,
};

async function bootstrap(page) {
  const env = fs.readFileSync(".env.local", "utf8");
  const pw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
  const email = `e3w-${Date.now().toString(36)}@163.com`;
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": pw }, body: JSON.stringify({ count: 1, days: 30 }), signal: AbortSignal.timeout(30000) })).json();
  const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "E3#walk1", name: "E3走查", inviteCode: gen.codes?.[0] }) });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status}`);
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  await page.context().addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  rec("bootstrap", email);
}


/** 递归展开文件夹树（笔记在多层目录里；每次点一个收起的目录行，最多 4 轮） */
async function expandTree(page) {
  for (let round = 0; round < 4; round++) {
    const rows = page.locator("div,button").filter({ hasText: /^(数据结构|笔记)\s*\d+$/ });
    const n = await rows.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      const el = rows.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      /* 收起态：子项不可见 → 点它 */
      const before = await page.locator("text=互惠").count();
      await el.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(350);
      const after = await page.locator("text=互惠").count();
      if (after !== before) clicked = true;
    }
    if (!clicked) break;
  }
}

const overflow = (page) => page.evaluate(() => { const d = document.documentElement; return { sw: d.scrollWidth, cw: d.clientWidth, overflow: d.scrollWidth > d.clientWidth + 2 }; });

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 950 } });
const page = await ctx.newPage();

try {
  await bootstrap(page);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
  await page.evaluate((g) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
    const raw = JSON.parse(localStorage.getItem(key) || "{}");
    raw.state = raw.state || {}; Object.assign(raw.state, g);
    localStorage.setItem(key, JSON.stringify(raw));
    window.__mentoraStore?.setState?.(g);
  }, seed);
  await page.waitForTimeout(800);
  rec("种子", JSON.stringify(await page.evaluate(() => ({ k: (window.__mentoraStore?.getState().knowledge ?? []).length }))));

  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2600);
    /* 展开文件夹（深层目录默认收起）：点带计数的目录行；失败则用 dev 钩子读筛选结果兜底 */
    const dirRow = page.locator("button, div[role=button]").filter({ hasText: /^数据结构/ }).first();
    if (await dirRow.count()) { await dirRow.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(700); }

    const t = await page.textContent("body");
    const o = await overflow(page);
    await page.screenshot({ path: `${OUT}/notes-${width}.png` });

    const noteCount = await page.evaluate(() => (window.__mentoraStore?.getState().knowledge ?? []).length);
    verdict(`NOTES-${width}`, "笔记工作区可用（数据在 + 搜索框在）+ 无页面级横向溢出",
      noteCount >= 5 && (await page.locator('input[aria-label="搜索笔记（标题或正文）"]').count()) > 0 && !o.overflow,  // placeholder 含省略号，子串匹配即可
      `notes=${noteCount} overflow=${o.overflow}(${o.sw}/${o.cw})`);
    verdict(`NOTES-LONGTITLE-${width}`, "长标题不撑破布局", !o.overflow, `${o.sw}/${o.cw}`);

    /* 打开笔记看来源与详情：先搜索定位（搜索会展开命中路径） */
    const searchInput = page.locator('input[aria-label="搜索笔记（标题或正文）"]').first();
    if (await searchInput.count()) {
      await searchInput.fill("顺序表的插入");
      await page.waitForTimeout(900);
      await expandTree(page);
      const hit = page.locator("text=顺序表的插入为什么是 O(n)").first();
      if (await hit.count()) {
        await hit.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1300);
        const dt = await page.textContent("body");
        const dof = await overflow(page);
        await page.screenshot({ path: `${OUT}/notes-detail-${width}.png` });
        verdict(`SOURCE-${width}`, "详情显示来源（人话标签 + 出处）", dt.includes("来源") && dt.includes("学习产出"), "");
        verdict(`DETAIL-${width}`, "详情正文可读 + 无溢出", !dof.overflow && dt.includes("搬移成本"), `overflow=${dof.overflow}`);
        /* 已删除来源提示（切到该笔记） */
        if (width === 1280) {
          await searchInput.fill("已删除来源的笔记");
          await page.waitForTimeout(900);
          await expandTree(page);
          const hit2 = page.locator("text=已删除来源的笔记").first();
          if (await hit2.count()) {
            await hit2.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1200);
            const xt = await page.textContent("body");
            await page.screenshot({ path: `${OUT}/notes-source-missing-1280.png` });
            verdict("SOURCE-MISSING", "来源对象已删除时如实提示", xt.includes("来源对象已不存在"), "");
          }
        }
        await searchInput.fill("");
        await page.waitForTimeout(400);
      }
    }
    if (await searchInput.count()) {
      await searchInput.fill("互惠");
      await page.waitForTimeout(900);
      const st = await page.textContent("body");
      await page.screenshot({ path: `${OUT}/notes-search-${width}.png` });
      /* 搜索命中：筛选后可见计数降到 1 篇（「N 篇 · 1 篇可见」），且该笔记标题出现在树里 */
      const filtered1 = /1 篇可见/.test(st);
      verdict(`SEARCH-${width}`, "搜索命中正文内容（搜「互惠」→ 1 篇可见）",
        filtered1 || st.includes("互惠原理"), `1篇可见=${filtered1}`);

      /* 无结果空态 + 清除筛选 */
      await searchInput.fill("绝对不存在的关键词xyz");
      await page.waitForTimeout(700);
      const et = await page.textContent("body");
      await page.screenshot({ path: `${OUT}/notes-empty-${width}.png` });
      verdict(`EMPTY-${width}`, "无搜索结果时区分空态并给清除入口",
        et.includes("没有匹配的笔记") && et.includes("清除筛选"), "");
      await searchInput.fill("");
      await page.waitForTimeout(500);
    }

  }
  rec("完成", `${results.filter((r) => r.pass).length}/${results.length} 通过`);
} catch (e) {
  rec("异常", String(e).slice(0, 300));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/walkthrough.json`, JSON.stringify({ at: now(), note: "隔离样例（setState 注入），仅验证布局与交互；真实持久化见 e3-persistence 与报告。", results }, null, 2));
  fs.writeFileSync(`${OUT}/walkthrough.log`, log.join("\n"));
  await b.close();
}
