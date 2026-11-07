/* ============================================================
 * V26.1 PRD §12 场景 A-H 自动化冒烟（playwright 驱动真实 UI）
 *
 *   A 跨对话隔离   B 后台生成     C 视频约束     D 不存在的书
 *   E 重排入口     F 学习人生结果层 G 自动滚动    H 工具预算
 *
 * 登录复用遗留探针账号（避免每次注册烧激活码，配额独立计）：
 *   SMOKE_PROBE_EMAIL / SMOKE_PROBE_PW 可覆盖，默认 probe-x2@163.com。
 * 八场景各一个 async 函数，单场景 try/catch，失败不阻断后续；
 * 每个断言独立输出 PASS/FAIL + 原因。
 * 种子注入沿用 smoke-reading-v25 的模式：先任意页水合建仓 → evaluate 写
 * mentora-store-* → 导航刷新生效。重复跑先用固定 id 清掉上一轮种子。
 *
 * 用法：node scripts/smoke-v26.mjs（dev server 已在 BASE 上运行）
 * ============================================================ */
import { chromium } from "playwright-core";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const EXE = process.env.SMOKE_CHROME ?? "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const PROBE_EMAIL = process.env.SMOKE_PROBE_EMAIL || "probe-x2@163.com";
const PROBE_PW = process.env.SMOKE_PROBE_PW || "Pr#obe123";

const fails = [];
const check = (name, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) fails.push(`${name}${extra ? `（${extra}）` : ""}`);
};
const note = (msg) => console.log("  ·", msg);
const countOf = (s, sub) => s.split(sub).length - 1;

/* ---- 登录遗留探针：POST /api/auth/login 拿 mentora_session cookie ---- */
console.log("login probe:", PROBE_EMAIL);
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PW }),
  signal: AbortSignal.timeout(30000),
});
const token = /mentora_session=([^;]+)/.exec(loginRes.headers.get("set-cookie") || "")?.[1];
if (!token) {
  throw new Error(`探针登录失败 ${loginRes.status}: ${JSON.stringify(await loginRes.json().catch(() => ({}))).slice(0, 140)}`);
}
console.log("probe logged in");

const browser = await chromium.launch({ executablePath: EXE, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await ctx.addCookies([{ name: "mentora_session", value: token, url: BASE }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  /* ---------- 种子构造（Goal/Plan/Phase/DayPlan 按 src/lib/types.ts） ---------- */
  const stubDay = (id, phaseId, title, kps) => ({
    id, phaseId, title, stub: true,
    knowledgePoints: kps.map((t, i) => ({ id: `${id}-kp${i + 1}`, text: t })),
    resources: [], method: "", acceptance: [], status: "locked", attempts: 0,
  });
  const today = new Date().toISOString().slice(0, 10);
  const seedGoalC = () => ({
    id: "goal-v26c-smoke", topic: "数据结构",
    direction: "（冒烟）系统过一遍常用数据结构并能手写实现",
    domainKind: "coding", motivation: "（冒烟）校招需要", background: "（冒烟）会 Python 基础",
    weeklyHours: 8,
    successCriteria: ["能讲清并实现数组/链表/栈/队列", "能分析常见操作的复杂度"],
    status: "active", createdAt: new Date().toISOString(), quizLog: [], intakeTranscript: [],
    plan: {
      summary: "（冒烟）三阶段：线性表 → 哈希与树 → 图与堆。",
      totalDays: 6, weeklyHours: 8, startDate: today, createdAt: new Date().toISOString(),
      phases: [
        {
          id: "ph-v26c-1", title: "第一阶段：线性表入门", outcome: "能实现并讲清数组、链表、栈、队列",
          dayIds: ["day-v26c-1", "day-v26c-2", "day-v26c-3"], status: "active", planned: false,
          catalog: [
            { id: "day-v26c-1", title: "Day 1：数组与动态数组", knowledgePoints: ["数组寻址与扩容"] },
            { id: "day-v26c-2", title: "Day 2：链表", knowledgePoints: ["单链表反转"] },
            { id: "day-v26c-3", title: "Day 3：栈与队列", knowledgePoints: ["循环队列"] },
          ],
        },
        { id: "ph-v26c-2", title: "第二阶段：哈希与树", outcome: "（冒烟）占位", dayIds: [], status: "locked" },
      ],
      days: {
        "day-v26c-1": stubDay("day-v26c-1", "ph-v26c-1", "Day 1：数组与动态数组", ["数组寻址与扩容"]),
        "day-v26c-2": stubDay("day-v26c-2", "ph-v26c-1", "Day 2：链表", ["单链表反转"]),
        "day-v26c-3": stubDay("day-v26c-3", "ph-v26c-1", "Day 3：栈与队列", ["循环队列"]),
      },
    },
  });
  const seedGoalE = () => ({
    id: "goal-v26e-smoke", topic: "冒烟重排学科",
    direction: "（冒烟）验证阶段重排入口",
    domainKind: "coding", motivation: "（冒烟）", background: "（冒烟）",
    weeklyHours: 8, successCriteria: ["（冒烟）完成一次重排"],
    status: "active", createdAt: new Date().toISOString(), quizLog: [], intakeTranscript: [],
    plan: {
      summary: "（冒烟）单阶段三天的最小计划。",
      totalDays: 3, weeklyHours: 8, startDate: today, createdAt: new Date().toISOString(),
      phases: [
        {
          id: "ph-v26e-1", title: "第一阶段：重排冒烟", outcome: "（冒烟）能完成阶段重排",
          dayIds: ["day-v26e-1", "day-v26e-2", "day-v26e-3"], status: "active", planned: false,
          catalog: [
            { id: "day-v26e-1", title: "Day 1：理论先行的一天的骨架", knowledgePoints: ["冒烟知识点甲"] },
            { id: "day-v26e-2", title: "Day 2：概念辨析的一天的骨架", knowledgePoints: ["冒烟知识点乙"] },
            { id: "day-v26e-3", title: "Day 3：综合练习的一天的骨架", knowledgePoints: ["冒烟知识点丙"] },
          ],
        },
      ],
      days: {
        "day-v26e-1": stubDay("day-v26e-1", "ph-v26e-1", "Day 1：理论先行的一天的骨架", ["冒烟知识点甲"]),
        "day-v26e-2": stubDay("day-v26e-2", "ph-v26e-1", "Day 2：概念辨析的一天的骨架", ["冒烟知识点乙"]),
        "day-v26e-3": stubDay("day-v26e-3", "ph-v26e-1", "Day 3：综合练习的一天的骨架", ["冒烟知识点丙"]),
      },
    },
  });
  const seedKnowledgeF = () => [
    {
      id: "kn-v26f-smoke-1", title: "顺序表的插入删除",
      body: "（冒烟）顺序表按位插入与删除的移位代价分析。",
      domain: "数据结构", source: "learn", sourceTitle: "冒烟种子",
      masteryStatus: "mastered", masteredAt: new Date().toISOString(), reviewStage: 1, links: [],
    },
    {
      id: "kn-v26f-smoke-2", title: "顺序表 · 目录",
      body: "（冒烟）目录骨架条目——按结果层语义不应进学习人生足迹。",
      domain: "数据结构", source: "learn", sourceTitle: "冒烟种子",
      masteryStatus: "mastered", masteredAt: new Date().toISOString(), reviewStage: 1, links: [],
    },
  ];
  const seedSessionG = () => {
    const long = (t) => `${t}——快速排序通过分治把数组分成独立的两段再分别处理，划分函数选定基准元素后线性扫描一遍完成分区，递归边界是子段长度小于等于一，平均复杂度 O(n log n)，最坏退化为 O(n^2)。`;
    const msgs = [];
    for (let i = 0; i < 3; i++) {
      msgs.push({ id: `m-g26-${i}u`, role: "user", content: long(`第${i + 1}轮问题：请展开讲讲排序算法里划分与递归的第 ${i + 1} 个细节`), at: new Date(Date.now() - (6 - i * 2) * 60000).toISOString() });
      msgs.push({ id: `m-g26-${i}a`, role: "assistant", content: long(`第${i + 1}轮回答：分治、划分、递归边界与复杂度分析展开如下`), at: new Date(Date.now() - (6 - i * 2 - 1) * 60000).toISOString() });
    }
    return { id: "sess-v26g-smoke", title: "滚动冒烟历史会话", messages: msgs, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  };

  /* ---------- localStorage 仓操作（沿用 smoke-reading-v25 模式） ---------- */
  const waitStoreReady = (timeout = 45000) =>
    page.waitForFunction(
      () => Object.keys(localStorage).some((k) => k.startsWith("mentora-store-") && !k.includes("anon")),
      null,
      { timeout },
    ).then(() => true).catch(() => false);
  const ensureStore = async () => {
    if (!(await waitStoreReady())) throw new Error("store 仓未建立（探针登录/水合失败）");
  };
  /** 遍历全部非 anon 用户仓执行一次变更。op: reset | goal | knowledge | sessions */
  const storeMutate = (op, payload = null) =>
    page.evaluate(({ op, payload }) => {
      const hits = [];
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith("mentora-store-") || k.includes("anon")) continue;
        try {
          const st = JSON.parse(localStorage.getItem(k) || "{}");
          if (!st?.state) continue;
          if (op === "reset") {
            /* 探针基线清场：主对话会话清空 + 本脚本历史种子移除（重复跑不累积脏数据） */
            st.state.agentSessions = [];
            st.state.agentChat = [];
            st.state.agentActiveId = null;
            st.state.goals = (st.state.goals ?? []).filter(
              (g) => !/^goal-v26[ce]-smoke$/.test(g.id) && g.topic !== "测试学科99",
            );
            st.state.knowledge = (st.state.knowledge ?? []).filter((x) => !/^kn-v26f-smoke/.test(x.id));
          } else if (op === "goal") {
            st.state.goals = [payload, ...(st.state.goals ?? []).filter((x) => x.id !== payload.id)];
          } else if (op === "knowledge") {
            const ids = new Set(payload.map((i) => i.id));
            st.state.knowledge = [...payload, ...(st.state.knowledge ?? []).filter((x) => !ids.has(x.id))];
          } else if (op === "sessions") {
            st.state.agentSessions = [payload];
            st.state.agentActiveId = payload.id;
            st.state.agentChat = [];
          }
          localStorage.setItem(k, JSON.stringify(st));
          hits.push(k);
        } catch {}
      }
      return hits;
    }, { op, payload });
  const resetProbeBaseline = () => storeMutate("reset");
  const upsertGoal = (goal) => storeMutate("goal", goal);
  const upsertKnowledge = (items) => storeMutate("knowledge", items);
  const replaceSessions = (sess) => storeMutate("sessions", sess);

  /* ---------- 首页对话驱动（沿用 eval-intent-ui 模式） ---------- */
  const gotoHome = async () => {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2500);
  };
  const ensureIdle = async () => {
    const stop = page.getByRole("button", { name: "停止" });
    if (await stop.isVisible().catch(() => false)) {
      await stop.click().catch(() => {});
      await stop.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
    }
  };
  const newChat = async () => {
    const btn = page.getByRole("button", { name: /新对话/ }).first();
    try {
      await btn.click({ timeout: 8000 });
    } catch {
      await gotoHome();
      await page.getByRole("button", { name: /新对话/ }).first().click({ timeout: 15000 });
    }
    await page.waitForTimeout(600);
  };
  /** 发送一条消息并等一轮完成（停止按钮 visible→hidden），期间自动批准审批卡；返回正文快照 */
  const sendAndWait = async (text, maxMs = 300000) => {
    await page.getByPlaceholder(/提问、搜索/).fill(text);
    await page.getByRole("button", { name: "发送" }).click();
    let done = false;
    const stopped = (async () => {
      await page.getByRole("button", { name: "停止" }).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
      await page.getByRole("button", { name: "停止" }).waitFor({ state: "hidden", timeout: maxMs }).catch(() => {});
      done = true;
    })();
    const approver = (async () => {
      while (!done) {
        const ok = page.getByRole("button", { name: "批准执行" }).first();
        if (await ok.isVisible().catch(() => false)) {
          await ok.click().catch(() => {});
          await page.waitForTimeout(500);
        } else {
          await page.waitForTimeout(500);
        }
      }
    })();
    void approver;
    await stopped;
    await page.waitForTimeout(2500);
    return page.evaluate(() => {
      const mds = [...document.querySelectorAll(".prose-mentora")];
      const body = document.body.innerText;
      return { body, lastProse: mds[mds.length - 1]?.innerText || "" };
    });
  };
  const quotaHit = (r) => /已达上限|配额/.test(r?.body ?? "");

  /* ---------- 引导页（/learn/new）小工具 ---------- */
  const waitSkipEnabled = (timeout = 90000) =>
    page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("不想再答了"));
      return !!b && !b.disabled;
    }, null, { timeout }).then(() => true).catch(() => false);

  /* ============================================================
   * A 跨对话隔离（V26.1 B1/B3）：会话 A 生成中切到 B，B 的回答不串台、A 照常落库
   * ============================================================ */
  const scenarioA = async () => {
    await ensureIdle();
    await newChat();
    await page.getByPlaceholder(/提问、搜索/).fill("详细讲解快速排序，包括每一步");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "停止" }).waitFor({ state: "visible", timeout: 30000 });
    /* 停止按钮出现 = A 在生成中 → 立刻点「新对话」切会话 B */
    let switchedMidRun = true;
    try {
      await page.getByRole("button", { name: /新对话/ }).first().click({ timeout: 8000 });
    } catch {
      switchedMidRun = false;
      note("A: 「新对话」在生成期间被禁用（busy disabled）——退化为等 A 完成后再切，隔离断言照常执行");
      await page.getByRole("button", { name: "停止" }).waitFor({ state: "hidden", timeout: 300000 });
      await page.getByRole("button", { name: /新对话/ }).first().click({ timeout: 15000 });
    }
    await page.waitForTimeout(600);
    const b = await sendAndWait("什么是数组？");
    const dense = countOf(b.lastProse, "快速排序");
    check("A1 B 会话回答讲数组、无快速排序密集段", b.lastProse.includes("数组") && dense <= 2, `快速排序×${dense}${quotaHit(b) ? " [配额]" : ""}`);
    /* 切回 A 的会话 tab（title=首问前 24 字，tabs 与右栏会话列表都可切） */
    await page.getByRole("button", { name: /详细讲解快速排序/ }).first().click({ timeout: 15000 });
    await page.getByRole("button", { name: "停止" }).waitFor({ state: "hidden", timeout: 300000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const aProse = await page.evaluate(() => {
      const mds = [...document.querySelectorAll(".prose-mentora")];
      return mds[mds.length - 1]?.innerText || "";
    });
    check("A2 切回 A 会话，回答含快速排序", aProse.includes("快速排序"), `len=${aProse.length}`);
    note(`A: 切换时点=${switchedMidRun ? "生成中（符合 PRD 期望）" : "生成结束后（退化，见 note）"}`);
  };

  /* ============================================================
   * B 后台生成（V26.1 B2）：确认总纲要后立刻切页，回页见后台徽标/自动跳转其一
   * ============================================================ */
  const scenarioB = async () => {
    await page.goto(`${BASE}/learn/new?topic=${encodeURIComponent("测试学科99")}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const skipReady = await waitSkipEnabled();
    if (!skipReady) {
      check("B 后台生成", false, "90s 内「不想再答了」未就绪（引导开场流式未完成或失败）");
      return;
    }
    await page.getByRole("button", { name: /不想再答了/ }).first().click();
    const confirmShown = await page.getByRole("button", { name: /确认，生成总纲要/ }).first()
      .waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
    if (!confirmShown) {
      check("B 后台生成", false, "120s 内确认卡（确认，生成总纲要）未出现");
      return;
    }
    /* goalId：state.goals[0].id（本脚本已清掉同 topic 旧草稿，新草稿必在首位） */
    const goalId = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith("mentora-store-") || k.includes("anon")) continue;
        try {
          const st = JSON.parse(localStorage.getItem(k) || "{}");
          const goals = st?.state?.goals ?? [];
          const g = goals.find((x) => x.topic === "测试学科99") ?? goals[0];
          if (g?.id) return g.id;
        } catch {}
      }
      return "";
    });
    if (!goalId) {
      check("B 后台生成", false, "goalId 读取失败（store 仓无 goals）");
      return;
    }
    await page.getByRole("button", { name: /确认，生成总纲要/ }).first().click();
    await page.goto(`${BASE}/life`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.goto(`${BASE}/learn/new?goal=${goalId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    /* 三者其一即 PASS：后台生成中徽标 / 目录已就绪或计划生成中 / 最终跳到 /learn/<goalId> */
    const ok = await page.waitForFunction(
      (gid) => location.pathname === `/learn/${gid}` || /后台生成中|目录已就绪|计划生成中/.test(document.body.innerText),
      goalId,
      { timeout: 60000 },
    ).then(() => true).catch(() => false);
    check("B 后台生成：徽标/就绪文案/自动跳转其一", ok,
      ok ? `goal=${goalId}` : `60s 内未见三类信号（goal=${goalId}，见上方页面态）`);
    if (!ok) {
      const tail = await page.evaluate(() => document.body.innerText.slice(0, 220).replace(/\s+/g, " "));
      note(`B: 回页后实际状态：${tail}`);
    }
  };

  /* ============================================================
   * C 视频约束：种子 goal + 主对话「重出资源」→ 审批卡自动批准 → 断言回答与工具卡
   * ============================================================ */
  const scenarioC = async () => {
    await gotoHome();
    await ensureStore();
    await upsertGoal(seedGoalC());
    await gotoHome();
    await ensureIdle();
    await newChat();
    const r = await sendAndWait("帮我重出 数据结构 第一阶段的学习资源，只要中文视频，B站，大陆能访问，不要文档", 420000);
    const ok = r.lastProse.includes("已为") || r.lastProse.includes("没有找到");
    check("C1 回答含「已为」或「没有找到」", ok, r.lastProse.slice(0, 60).replace(/\s+/g, " ") || "(空回答)");
    check("C2 工具卡含「重出阶段资源」", r.body.includes("重出阶段资源"), "");
    if (quotaHit(r)) note("C: 命中配额提示，结果可能失真");
  };

  /* ============================================================
   * D 不存在的书：核查弹窗出现 → 弹窗外粘贴仍空 → 确认生成被拦截并提示
   * ============================================================ */
  const scenarioD = async () => {
    await page.goto(`${BASE}/learn?tab=read`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.getByText("读书伙伴").first().waitFor({ timeout: 45000 });
    await page.getByRole("button", { name: /添加书籍/ }).first().click({ timeout: 15000 });
    const bookName = `XXZYQ 幻之书 ${Math.floor(Math.random() * 90 + 10)}x${Math.floor(Math.random() * 90 + 10)}`;
    await page.getByPlaceholder("书名（必填）").fill(bookName);
    /* 粘贴框留空 → 点生成 → 应先核查并暂停 */
    await page.getByRole("button", { name: "生成阅读计划" }).first().click({ timeout: 15000 });
    const modalShown = await page.getByText("暂时无法核实这本书").first()
      .waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
    check("D1 查无此书 → 核查弹窗出现", modalShown,
      modalShown ? bookName : `${bookName}（90s 未出弹窗：/api/search 失败会直通生成，属已知旁路）`);
    if (!modalShown) return;
    await page.getByRole("button", { name: "确认，基于我的材料生成" }).first().click({ timeout: 10000 });
    const blocked = await page.waitForFunction(
      () => document.body.innerText.includes("请先在表单里粘贴"),
      null,
      { timeout: 12000 },
    ).then(() => true).catch(() => false);
    check("D2 弹窗外粘贴仍空 → 确认被拦截并提示", blocked, "");
    /* 收尾：关掉弹窗不留半开状态 */
    await page.getByRole("button", { name: "换个书名" }).first().click({ timeout: 8000 }).catch(() => {});
  };

  /* ============================================================
   * E 重排入口：种子 goal（catalog 3 天、无 active 日）→ 重排按钮 → prompt 自动应答 → 8s 无报错
   * ============================================================ */
  const scenarioE = async () => {
    await gotoHome();
    await ensureStore();
    await upsertGoal(seedGoalE());
    await page.goto(`${BASE}/learn/goal-v26e-smoke`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const panel = await page.getByText("下一程").first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
    if (!panel) {
      check("E1 重排本阶段入口存在", false, "45s 内阶段卡（下一程）未出现——目标页未按种子渲染");
      return;
    }
    const btn = page.getByRole("button", { name: /重排本阶段/ }).first();
    const entry = await btn.isVisible().catch(() => false);
    check("E1 重排本阶段入口存在", entry, "");
    if (!entry) return;
    page.once("dialog", (d) => d.accept("想要更实践向的内容").catch(() => {}));
    await btn.click();
    await page.waitForTimeout(8000); /* PRD 场景 E：点击后观察 8s */
    const errToast = await page.locator('[data-sonner-toast][data-type="error"]').count();
    const still = await btn.isVisible().catch(() => false);
    const normal = (await page.getByText("下一程").count()) > 0;
    check("E2 重排点击 8s：无报错 toast、页面正常", still && normal && errToast === 0, `errorToast=${errToast}`);
  };

  /* ============================================================
   * F 学习人生结果层：两条 masteredAt 种子——真实条目进足迹、目录骨架被过滤
   * ============================================================ */
  const scenarioF = async () => {
    await gotoHome();
    await ensureStore();
    await upsertKnowledge(seedKnowledgeF());
    await page.goto(`${BASE}/learn?tab=life`, { waitUntil: "domcontentloaded", timeout: 60000 });
    /* ?tab=life 只认 ?tab=read 直达，life 需点一下 tab */
    await page.getByRole("button", { name: "学习人生" }).click({ timeout: 20000 });
    const showed = await page.waitForFunction(
      () => document.body.innerText.includes("掌握了「顺序表的插入删除」"),
      null,
      { timeout: 25000 },
    ).then(() => true).catch(() => false);
    check("F1 真实掌握条目进足迹", showed, "");
    const hidden = await page.evaluate(() => !document.body.innerText.includes("顺序表 · 目录"));
    check("F2 目录骨架条目不进足迹", hidden, "");
  };

  /* ============================================================
   * G 自动滚动：注入 6 条长消息历史 → 发新消息 → 2s 后滚动容器贴底（底部差距<300px）
   * ============================================================ */
  const scenarioG = async () => {
    await gotoHome();
    await ensureStore();
    await replaceSessions(seedSessionG());
    await gotoHome();
    await page.getByPlaceholder(/提问、搜索/).fill("用三句话总结上面讨论的要点");
    await page.getByRole("button", { name: "发送" }).click();
    await page.waitForTimeout(2000); /* PRD 场景 G：发送后 2s 观察 */
    const atBottom = await page.waitForFunction(() => {
      const el = [...document.querySelectorAll("div.min-h-0.flex-1.overflow-y-auto")]
        .find((d) => d.scrollHeight > d.clientHeight + 50);
      if (!el) return false;
      return el.scrollHeight - el.scrollTop - el.clientHeight < 300;
    }, null, { timeout: 10000 }).then(() => true).catch(() => false);
    check("G 发新消息后滚动容器贴底（<300px）", atBottom, "");
    await ensureIdle(); /* 清场：别把在途生成带进场景 H */
  };

  /* ============================================================
   * H 工具预算：重对比大题 → 最终回答不含旧上限文案（预算耗尽语义=保留结果收尾）
   * ============================================================ */
  const scenarioH = async () => {
    await ensureIdle();
    await newChat();
    const r = await sendAndWait(
      "帮我全面分析快速排序、归并排序、堆排序的原理并互相比较，给出每种的实现代码和复杂度对比",
      480000,
    );
    const capped = r.lastProse.includes("已达到单轮工具调用上限 5 次");
    check("H 最终回答不含「已达到单轮工具调用上限 5 次」", !capped,
      capped
        ? "出现旧上限文案（预算收尾未改干净或 5 轮用尽）"
        : `len=${r.lastProse.length}${r.lastProse.includes("先停在这里") ? "，含先停在这里（预算收尾）" : ""}`);
    if (quotaHit(r)) note("H: 命中每日配额提示，结果可能失真");
  };

  /* ---------- 探针基线 + 八场景顺序执行 ---------- */
  console.log("goto 首页（建仓/水合）…");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await ensureStore();
  const touched = await resetProbeBaseline();
  console.log("probe baseline reset:", touched.join(",") || "(none!)");
  await gotoHome();

  const scenarios = [
    ["A 跨对话隔离", scenarioA],
    ["B 后台生成", scenarioB],
    ["C 视频约束", scenarioC],
    ["D 不存在的书", scenarioD],
    ["E 重排入口", scenarioE],
    ["F 学习人生结果层", scenarioF],
    ["G 自动滚动", scenarioG],
    ["H 工具预算", scenarioH],
  ];
  for (const [name, fn] of scenarios) {
    console.log(`\n=== 场景 ${name} ===`);
    try {
      await fn();
    } catch (e) {
      check(name, false, `异常中断: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }

  console.log(fails.length ? `\nRESULT: ${fails.length} FAIL → ${fails.join(" / ")}` : "\nRESULT: ALL PASS");
} finally {
  await browser.close().catch(() => {});
}
process.exit(fails.length ? 1 : 0);
