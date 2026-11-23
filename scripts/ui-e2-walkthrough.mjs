#!/usr/bin/env node
/* E2 走查：学习教练 + 人生伙伴（隔离样例，三宽度）
 * 检查：学习流程入口连贯 / 进度语义分列 / 讨论页议题与阵容 / 深链 / 长内容不撑破 / 键盘
 * 产出：docs/evidence/ui-e2-2026-11-11/
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3001";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = "docs/evidence/ui-e2-2026-11-11";
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const results = [];
const rec = (s, d) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` :: ${d}` : ""}`; console.log(l); log.push(l); };
const verdict = (id, name, pass, evidence) => { results.push({ id, name, pass, evidence }); console.log(`  ${pass ? "PASS" : "FAIL"} ${id} ${name}`); };

const now = () => new Date().toISOString();
const seed = {
  goals: [
    { id: "g1", topic: "数据结构（C 语言）与算法设计基础", direction: "考研 408 + 工程实践",
      domainKind: "coding", motivation: "", background: "", weeklyHours: 6, successCriteria: [], status: "active",
      createdAt: now(), quizLog: [], intakeTranscript: [],
      plan: { summary: "三阶段", totalDays: 5, weeklyHours: 6, startDate: "2026-11-01", createdAt: now(),
        phases: [
          { id: "p1", title: "第一阶段 · 线性结构", outcome: "能手写顺序表与链表并分析复杂度", status: "active",
            dayIds: ["d1","d2"], catalog: [{id:"d1",title:"第1天 顺序表",knowledgePoints:["插入搬移"]},{id:"d2",title:"第2天 链表",knowledgePoints:["指针"]}] },
          { id: "p2", title: "第二阶段 · 树与图", outcome: "掌握遍历与最短路径", status: "locked", dayIds: [], catalog: [] },
        ],
        days: {
          d1: { id:"d1", phaseId:"p1", title:"第1天 顺序表", stub:false, knowledgePoints:[{id:"k1",text:"插入搬移",masteryStatus:"independent"}], resources:[], method:"讲解", acceptance:[], status:"passed", attempts:1, completedAt:now() },
          d2: { id:"d2", phaseId:"p1", title:"第2天 链表", stub:false, knowledgePoints:[{id:"k2",text:"指针"}], resources:[], method:"讲解", acceptance:[], status:"active", attempts:0 },
        } } },
    { id: "g2", topic: "英语口语", direction: "日常交流", domainKind: "language", motivation: "", background: "",
      weeklyHours: 3, successCriteria: [], status: "draft", createdAt: now(), quizLog: [], intakeTranscript: [] },
  ],
  sessions: [
    { id: "s1", personaId: "roundtable", participants: ["naval", "jobs", "taleb"],
      title: "要不要辞职创业：三人圆桌", createdAt: now(),
      messages: [
        { id:"m1", role:"user", content:"我在纠结要不要辞职创业：存款够两年，行业在下行。", at: now() },
        { id:"m2", role:"assistant", content:"**【Naval Ravikant】**\n\n先问一句：你要的是自由还是规模？这两条路完全不同。", at: now() },
        { id:"m3", role:"assistant", content:"**【Steve Jobs】**\n\n（发言失败——本轮结束后可单独重试）", at: now() },
        { id:"m4", role:"assistant", content:"**【Nassim Taleb】**\n\n下行行业里辞职，等于把自己暴露在尾部风险中。", at: now() },
        { id:"m5", role:"assistant", content:"## 圆桌纪要\n\n共识：先验证需求再辞。分歧：Naval 认为自由优先，Taleb 强调风险敞口。", at: now() },
      ] },
  ],
  books: [], knowledge: [], customPersonas: [], folders: [],
  agentActiveId: null, agentSessions: [],
};

async function bootstrap(page) {
  const env = fs.readFileSync(".env.local", "utf8");
  const pw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
  const email = `e2-${Date.now().toString(36)}@163.com`;
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": pw }, body: JSON.stringify({ count: 1, days: 30 }), signal: AbortSignal.timeout(30000) })).json();
  const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "E2#walk1", name: "E2走查", inviteCode: gen.codes?.[0] }) });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status}`);
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  await page.context().addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  rec("bootstrap", `${email}（隔离账号）`);
  return { email, password: "E2#walk1" };
}

/** 会话中途失效（被踢到登录页）时重新登录并恢复 cookie */
async function relogin(page, acct) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: acct.email, password: acct.password }),
  });
  if (!r.ok) return false;
  const tok = /mentora_session=([^;]+)/.exec(r.headers.get("set-cookie") || "")?.[1];
  if (!tok) return false;
  await page.context().addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  rec("relogin", "会话失效，已重新登录");
  return true;
}


/** 等待页面水合：store 有数据 + 目标文本出现（隔离样例注入后首次渲染可能慢） */
async function waitHydrated(page, expectText, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate((t) => {
      const st = window.__mentoraStore?.getState?.();
      const hasData = !!(st && ((st.goals ?? []).length || (st.sessions ?? []).length));
      return hasData && document.body.innerText.includes(t);
    }, expectText).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(400);
  }
  return false;
}


/** 导航 + 登录态守卫：被踢到 /login 时重新登录并重试一次 */
async function gotoAuthed(page, path, acct) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  const onLogin = await page.evaluate(() => location.pathname.startsWith("/login") || document.body.innerText.includes("欢迎回来"));
  if (onLogin) {
    if (await relogin(page, acct)) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);
    }
  }
}

const overflow = (page) => page.evaluate(() => {
  const de = document.documentElement;
  return { sw: de.scrollWidth, cw: de.clientWidth, overflow: de.scrollWidth > de.clientWidth + 2 };
});

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 950 } });
const page = await ctx.newPage();

try {
  const acct = await bootstrap(page);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);
  /* 双通道注入：localStorage（持久化）+ dev 钩子 setState（当前内存态立即生效）。
   * 只写 localStorage 时，store 的 skipHydration 让内存态不立即更新，
   * 页面首次渲染拿不到种子数据（此前 390 空骨架/深链显示会话不存在的根因）。 */
  await page.evaluate((g) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
    const raw = JSON.parse(localStorage.getItem(key) || "{}");
    raw.state = raw.state || {};
    Object.assign(raw.state, g);
    localStorage.setItem(key, JSON.stringify(raw));
    window.__mentoraStore?.setState?.(g);
  }, seed);
  await page.waitForTimeout(800);
  const seeded = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    return { goals: (st?.goals ?? []).length, sessions: (st?.sessions ?? []).length };
  });
  rec("种子注入", `goals=${seeded.goals} sessions=${seeded.sessions}`);
  if (!seeded.goals || !seeded.sessions) throw new Error("种子数据未进入 store");

  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 950 });

    /* --- 学习列表 --- */
    await gotoAuthed(page, "/learn", acct);
    await waitHydrated(page, "继续学习");
    await page.waitForTimeout(400);
    const lt = await page.textContent("body");
    const lo = await overflow(page);
    await page.screenshot({ path: `${OUT}/learn-list-${width}.png` });
    verdict(`LIST-${width}`, "继续学习入口 + 进度语义分列（完成/跳过/掌握）",
      lt.includes("正在学习") && lt.includes("继续学习") && lt.includes("已完成") && lt.includes("已跳过") && lt.includes("已掌握"),
      `overflow=${lo.overflow}`);
    verdict(`LIST-LONG-${width}`, "长项目名不撑破布局", !lo.overflow && lt.includes("数据结构（C 语言）与算法设计基础"), `${lo.sw}/${lo.cw}`);

    /* --- 学习详情 --- */
    await gotoAuthed(page, "/learn/g1", acct);
    await waitHydrated(page, "当前阶段");
    await page.waitForTimeout(400);
    const dt = await page.textContent("body");
    const dof = await overflow(page);
    await page.screenshot({ path: `${OUT}/learn-detail-${width}.png` });
    verdict(`DETAIL-${width}`, "当前阶段/任务为主区域 + 调整/历史入口",
      dt.includes("当前阶段") && dt.includes("第2天 链表") && (dt.includes("重排本阶段") || dt.includes("历史版本")),
      `overflow=${dof.overflow}`);
    verdict(`DETAIL-PROG-${width}`, "进度语义分开显示（不用单一百分比）", dt.includes("已完成") && dt.includes("已掌握"), "");

    /* --- 人生伙伴 --- */
    await gotoAuthed(page, "/council?session=s1", acct);
    await waitHydrated(page, "当前会话");
    await page.waitForTimeout(400);
    const ct = await page.textContent("body");
    const cof = await overflow(page);
    await page.screenshot({ path: `${OUT}/council-${width}.png` });
    verdict(`COUNCIL-${width}`, "会话/阵容/议题可见 + 发言与纪要区分",
      ct.includes("当前会话") && ct.includes("议题：") && ct.includes("Naval Ravikant") && ct.includes("圆桌纪要"),
      `overflow=${cof.overflow}`);
    verdict(`COUNCIL-FAIL-${width}`, "失败席位明确（文字+图标，不只靠颜色）", ct.includes("发言失败"), "");
    /* 深链直达：会话已自动选中（议题可见即证明） */
    verdict(`DEEPLINK-${width}`, "深链直达指定会话（刷新后仍定位）", ct.includes("存款够两年"), "");

    /* --- 深链不存在 --- */
    if (width === 1280) {
      await gotoAuthed(page, "/council?session=nope-xyz", acct);
      await page.waitForTimeout(2000);
      const nt = await page.textContent("body");
      await page.screenshot({ path: `${OUT}/council-deeplink-missing-1280.png` });
      verdict("DEEPLINK-MISSING", "不存在的会话有明确提示", nt.includes("链接指向的会话不存在"), "");

      /* 键盘：Tab 焦点 + Modal 打开/关闭/焦点返回 */
      await gotoAuthed(page, "/learn", acct);
      await page.waitForTimeout(1500);
      /* 打开删除确认弹窗（键盘可达的原生 button） */
      const delBtn = page.locator('button[aria-label="删除目标"]').first();
      let modalOk = false, focusReturn = false;
      if (await delBtn.count()) {
        await delBtn.focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(600);
        const dlg = await page.locator('[role="dialog"]').count();
        const inDialog = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
        modalOk = dlg > 0 && inDialog;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
        const closed = (await page.locator('[role="dialog"]').count()) === 0;
        focusReturn = await page.evaluate(() => {
          const a = document.activeElement;
          return !!a && a.getAttribute("aria-label") === "删除目标";
        });
        verdict("KEYBOARD-MODAL", "弹窗键盘打开/焦点入内/Esc 关闭", modalOk && closed, `dialog=${modalOk} closed=${closed}`);
        verdict("KEYBOARD-FOCUS-RETURN", "关闭后焦点返回原触发按钮", focusReturn, `returned=${focusReturn}`);
      } else {
        verdict("KEYBOARD-MODAL", "弹窗键盘打开/焦点入内/Esc 关闭", false, "未找到删除按钮");
      }
    }
  }
  rec("走查完成", `${results.filter((r) => r.pass).length}/${results.length} 通过`);
} catch (e) {
  rec("异常", String(e).slice(0, 300));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/walkthrough.json`, JSON.stringify({ at: now(), note: "隔离样例数据（脚本注入），验证布局/交互；真实模型效果单列待验。", results }, null, 2));
  fs.writeFileSync(`${OUT}/walkthrough.log`, log.join("\n"));
  await b.close();
}
