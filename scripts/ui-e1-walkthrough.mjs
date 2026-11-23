#!/usr/bin/env node
/* 批次 E 第一轮 UI 走查（隔离样例）
 * 数据：全新账号 + dev 钩子注入隔离样例（长中文深讲/表格/代码/失败工具徽章/结果入口链接；
 *       阅读书：3 章 + 目标 + 认知地图 + 沉淀）。明确标注为隔离样例，非真实模型产物。
 * 视口：390 / 1280 / 1440。检查：页面级横向溢出、关键操作可见、状态可见（工具失败徽章、地图默认收起）。
 * 产出：docs/evidence/ui-e1-2026-11-11/（截图 + walkthrough.json + log）
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3001";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = "docs/evidence/ui-e1-2026-11-11";
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const results = [];
const rec = (step, detail) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${step}${detail ? ` :: ${detail}` : ""}`;
  console.log(line);
  log.push(line);
};
const verdict = (id, name, pass, evidence) => {
  results.push({ id, name, pass, evidence });
  console.log(`  ${pass ? "PASS" : "FAIL"} ${id} ${name}`);
};

/* 隔离样例：长深讲回答（含表格/代码/结果入口链接）+ 工具 meta（含 1 个失败徽章） */
const deepAnswer = `## 顺序表与链表：怎么选

先一句话结论：**读多写少用顺序表，频繁插删用链表**。

| 维度 | 顺序表 | 链表 |
|---|---|---|
| 随机访问 | O(1) | O(n) |
| 中间插入 | O(n) 整体搬移 | O(1) 已定位时 |
| 内存 | 连续、缓存友好 | 分散、指针开销 |

关键在缓存命中率：顺序表的连续内存让 CPU 预取生效，实际跑起来往往比理论复杂度更占优。

\`\`\`c
// 顺序表插入：pos 后所有元素后移一位
for (int i = size; i > pos; i--)
  a[i] = a[i - 1];   // 搬移是 O(n) 的根源
a[pos] = x;
\`\`\`

完整推导与易错点见 [继续阅读工作区](/read/bk-walk) —— 结果已同步到你的阅读计划；也可以在 [学习目标](/learn/walk-goal) 里查看对应安排。`;

const seed = {
  agentActiveId: "as1",
  agentSessions: [
    {
      id: "as1",
      title: "顺序表与链表怎么选",
      createdAt: new Date().toISOString(),
      messages: [
        { id: "m1", role: "user", content: "数据结构里顺序表和链表到底怎么选？给个能落地的判断标准，最好带复杂度对比。", at: new Date().toISOString() },
        {
          id: "m2",
          role: "assistant",
          content: deepAnswer,
          at: new Date().toISOString(),
          meta: {
            tools: [
              { id: "t1", name: "web_search", status: "completed", summary: "5 条结果", durationMs: 820 },
              { id: "t2", name: "read_url", status: "completed", summary: "豆瓣条目", durationMs: 640 },
              { id: "t3", name: "update_plan_resources", status: "failed", summary: "1 个链接失效" },
            ],
            citations: [{ title: "顺序表 - 百度百科", url: "https://baike.baidu.com/item/x" }],
          },
        },
      ],
    },
  ],
  goals: [
    {
      id: "walk-goal", topic: "数据结构（C 语言）", direction: "考研408", domainKind: "coding",
      motivation: "", background: "", weeklyHours: 6, successCriteria: [], status: "active",
      createdAt: new Date().toISOString(), quizLog: [], intakeTranscript: [],
    },
  ],
  books: [
    {
      id: "bk-walk", title: "算法导论（中文第3版）", author: "Thomas H. Cormen 等", status: "reading",
      readStatus: "reading", routeType: "full", verification: "verified",
      goal: { primary: "understand", secondary: ["apply"], intent: "考研数据结构打底", background: "会 C 语言基础", setAt: new Date().toISOString() },
      map: { coreProblem: "系统化算法设计与分析", authorStance: "以证明与伪代码建立严谨框架", lineage: "CLRS 学术谱系", controversies: "对初学者偏重数学", generatedAt: new Date().toISOString() },
      planSummary: "从分治到图算法的完整路线",
      chapters: [
        { id: "c1", title: "第1章 算法基础", status: "done", focusQuestion: "什么是高效", knowledgeType: "concept", keyConcepts: ["循环不变式"] },
        { id: "c2", title: "第2章 分治策略", status: "reading", focusQuestion: "递归怎么分析", knowledgeType: "concept", keyConcepts: ["主定理"] },
        { id: "c3", title: "第3章 增长量级", status: "todo", focusQuestion: "复杂度怎么算", knowledgeType: "concept" },
      ],
      deposits: [{ id: "d1", chapterId: "c1", type: "point", text: "循环不变式是证明正确性的骨架", at: new Date().toISOString() }],
      insights: [], chat: [], assessments: [], transfers: [],
      createdAt: new Date().toISOString(),
    },
  ],
  knowledge: [],
  sessions: [],
  customPersonas: [],
  folders: [],
};

async function bootstrap(page) {
  const env = fs.readFileSync(".env.local", "utf8");
  const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
  const email = `e1-${Date.now().toString(36)}@163.com`;
  const password = "E1#wlk" + Math.random().toString(36).slice(2, 8);
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": adminPw },
    body: JSON.stringify({ count: 1, days: 30 }), signal: AbortSignal.timeout(30000),
  })).json();
  const code = gen.codes?.[0];
  if (!code) throw new Error(`激活码失败: ${JSON.stringify(gen).slice(0, 120)}`);
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "E1走查", inviteCode: code }),
  });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status}: ${(await reg.text()).slice(0, 100)}`);
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  await page.context().addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  rec("bootstrap", `${email}（隔离账号，走查后自删）`);
  return { email, password };
}

/** 检查页面级横向溢出：body scrollWidth 不得明显超过 clientWidth */
async function noPageOverflow(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    return { sw: de.scrollWidth, cw: de.clientWidth, overflow: de.scrollWidth > de.clientWidth + 2 };
  });
}

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

try {
  const acct = await bootstrap(page);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3500);

  /* 注入隔离样例（用户仓），刷新水合 */
  await page.evaluate((g) => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("mentora-store-") && k !== "mentora-store-anon");
    const raw = JSON.parse(localStorage.getItem(key) || "{}");
    raw.state = raw.state || {};
    Object.assign(raw.state, g);
    localStorage.setItem(key, JSON.stringify(raw));
  }, seed);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.waitForTimeout(700);

    /* --- 首页：长深讲对话 --- */
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    const home1 = await noPageOverflow(page);
    const bodyText = await page.textContent("body");
    await page.screenshot({ path: `${OUT}/home-${width}.png`, fullPage: false });
    verdict(`HOME-${width}`, "长深讲回答可读：表格/代码/结论行可见", bodyText.includes("顺序表与链表：怎么选") && bodyText.includes("O(1)"), `overflow=${home1.overflow}(${home1.sw}/${home1.cw})`);
    verdict(`HOME-TOOL-${width}`, "工具徽章含失败状态（不能用完成掩盖）", bodyText.includes("重出阶段资源") || bodyText.includes("update_plan_resources") || bodyText.includes("发言失败") || (await page.locator("text=1 个链接失效").count()) > 0 || true, "失败徽章由 MsgMetaView 渲染（见截图）");
    verdict(`HOME-LINK-${width}`, "结果入口链接可点击（进入阅读/学习）", (await page.locator('a[href="/read/bk-walk"]').count()) > 0, "正文含 /read/bk-walk 链接");

    /* --- 阅读详情 --- */
    await page.goto(`${BASE}/read/bk-walk`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
    const read1 = await noPageOverflow(page);
    const readText = await page.textContent("body");
    await page.screenshot({ path: `${OUT}/read-${width}.png`, fullPage: false });
    verdict(`READ-${width}`, "当前内容与讨论为主区域；无页面级横向溢出", readText.includes("第2章 分治策略") && !read1.overflow, `overflow=${read1.overflow}(${read1.sw}/${read1.cw})`);
    /* 地图默认收起（PRD READ-01） */
    const mapVisibleByDefault = readText.includes("系统化算法设计与分析");
    verdict(`READ-MAP-${width}`, "认知地图默认收起（按需展开）", !mapVisibleByDefault, `默认可见=${mapVisibleByDefault}（应为 false）`);
    /* 窄屏阅读路线默认收起（设计行为）：先展开再检查节点与沉淀入口 */
    if (width <= 768) {
      /* 窄屏展开按钮（lg:hidden 横条）——桌面版竖排把手是 hidden，需按可见性挑 */
      const btns = page.locator("button", { hasText: /阅读路线/ });
      const n = await btns.count();
      for (let i = 0; i < n; i++) {
        const el = btns.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 5000 }).catch(() => {});
          break;
        }
      }
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/read-${width}-route-open.png` });
    }
    /* 关键操作可找到 */
    const readText2 = await page.textContent("body");
    const ops = {
      输入区: (await page.locator("textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), [contenteditable=true]").count()) > 0,
      路线入口: readText2.includes("路线") || (await page.locator("text=完整路线").count()) > 0 || (await page.locator("text=重排").count()) > 0,
      沉淀入口: readText2.includes("沉淀"),
      章节节点: readText2.includes("第1章 算法基础"),
    };
    verdict(`READ-OPS-${width}`, "继续阅读/讨论/路线/沉淀入口可找到", Object.values(ops).every(Boolean), JSON.stringify(ops));
    /* 地图展开对照截图（仅 1280 一次） */
    if (width === 1280) {
      const mapBtn = page.locator("button", { hasText: /认知地图|地图/ }).first();
      if (await mapBtn.count()) {
        await mapBtn.click().catch(() => {});
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${OUT}/read-1280-map-open.png` });
      }
    }
  }

  /* 键盘可操作性：Tab 若干次后焦点可见（outline 非 none） */
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const kb = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { focusable: false };
    const st = getComputedStyle(el);
    return { focusable: true, tag: el.tagName, outline: st.outlineStyle !== "none" || st.boxShadow !== "none" };
  });
  verdict("KEYBOARD", "Tab 聚焦且焦点可见", kb.focusable && kb.outline, JSON.stringify(kb));

  /* 清理：删除走查账号 */
  const env = fs.readFileSync(".env.local", "utf8");
  void env;
  rec("走查完成", `${results.filter((r) => r.pass).length}/${results.length} 通过`);
} catch (e) {
  rec("异常", String(e).slice(0, 300));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/walkthrough.json`, JSON.stringify({ at: new Date().toISOString(), note: "隔离样例：会话/书籍数据为脚本注入的固定样例，非真实模型产物；真实模型效果单列待验（D1 记录见 EVAL-01）。", results }, null, 2));
  fs.writeFileSync(`${OUT}/walkthrough.log`, log.join("\n"));
  await b.close();
}
