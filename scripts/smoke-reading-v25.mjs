/* v25 阅读系统 UI 冒烟：激活码注册全新探针（云端为空不覆盖本地注入）→ 注入种子书 → 断言 → 清理 */
import { chromium } from "playwright-core";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:3000";
const EMAIL = `v25-read-${Date.now().toString(36)}@163.com`;
const PW = "v25-read-check";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";

/* 注册已改激活码制：用管理员密码现场生成一枚，跑完随探针自删 */
const ADMIN_PW = process.env.ADMIN_PASSWORD_LOCAL ?? "";
let inviteCode = process.env.SMOKE_INVITE_CODE ?? "";
if (!inviteCode) {
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": ADMIN_PW }, body: JSON.stringify({ count: 1, days: 30 }) })).json();
  inviteCode = gen.codes?.[0];
  if (!inviteCode) throw new Error(`生成激活码失败: ${JSON.stringify(gen).slice(0, 120)}`);
}
console.log("invite code ready");

const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW, name: "阅读冒烟", inviteCode }) });
const setCookie = reg.headers.get("set-cookie") || "";
const cookie = /mentora_session=([^;]+)/.exec(setCookie)?.[0];
if (!cookie) throw new Error(`激活码注册失败 ${reg.status}: ${(await reg.text()).slice(0, 120)}`);
console.log("registered", EMAIL);

const BOOK_ID = "book-v25-smoke";
const SEED_BOOK = {
  id: BOOK_ID,
  title: "影响力",
  author: "罗伯特·西奥迪尼",
  status: "reading",
  readStatus: "reading",
  map: {
    coreProblem: "（冒烟）为什么人会在不知不觉中顺从他人？西奥迪尼想解释顺从心理的触发机制。",
    authorStance: "（冒烟）顺从不是性格，是六类心理触发器被启动的结果。",
    lineage: "（冒烟）继承社会心理学实验传统，被行为经济学继承。",
    controversies: "（冒烟）争议：触发器是否可被道德使用；适用边界：强随机环境。",
    generatedAt: new Date().toISOString(),
  },
  planSummary: "（冒烟）按六大武器逐章拆解。",
  chapters: [
    { id: "ch-smoke-1", title: "互惠原理", focusQuestion: "谁在利用你的亏欠感？", knowledgeType: "concept", coreIdea: "先给再取：亏欠感驱动顺从", keyConcepts: ["互惠", "亏欠感"], prerequisites: [], expectedOutcome: "能识别一次互惠套路", assessFocus: "互惠的触发条件", perspectives: ["（冒烟）塔勒布：不对称互惠是掠夺。"], capture: ["互惠触发条件"], status: "todo" },
    { id: "ch-smoke-2", title: "承诺一致", focusQuestion: "为什么小承诺能套牢你？", knowledgeType: "concept", coreIdea: "公开承诺驱动自我塑形", keyConcepts: ["承诺"], prerequisites: ["互惠原理"], expectedOutcome: "能举一个自己被套牢的例子", assessFocus: "承诺的升级路径", perspectives: [], capture: [], status: "todo" },
  ],
  insights: [],
  chat: [],
  deposits: [],
  assessments: [],
  createdAt: new Date().toISOString(),
};

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addCookies([{ name: "mentora_session", value: cookie.split("=")[1], url: BASE }]);
const page = await ctx.newPage();
const fails = [];
const check = (name, ok, extra = "") => { console.log(ok ? "PASS" : "FAIL", name, extra); if (!ok) fails.push(name); };

// 1) 注入种子书（persist shape）：先等书架页水合完成（用户仓已建立）再注入，注入后回读验证
await page.goto(`${BASE}/learn?tab=read`, { waitUntil: "domcontentloaded" });
await page.getByText("读书伙伴").first().waitFor({ timeout: 30_000 });
const injected = await page.evaluate((book) => {
  const hits = [];
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("mentora-store")) continue;
    try {
      const st = JSON.parse(localStorage.getItem(k) || "{}");
      if (!st?.state) continue;
      st.state.books = [book, ...(st.state.books ?? [])];
      localStorage.setItem(k, JSON.stringify(st));
      hits.push(k);
    } catch {}
  }
  return hits;
}, SEED_BOOK);
console.log("injected into:", injected.join(",") || "(none!)");
if (injected.length === 0) throw new Error("没有任何 store 仓可注入（水合未完成）");
await page.goto(`${BASE}/read/${BOOK_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const booksInStore = await page.evaluate(() => {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("mentora-store-") || k.includes("anon")) continue;
    try {
      const st = JSON.parse(localStorage.getItem(k) || "{}");
      return (st?.state?.books ?? []).map((b) => b.id);
    } catch {}
  }
  return [];
});
console.log("books in user store:", booksInStore.join(",") || "(none)");

// 2) 目标卡（PRD 4.1）——dev 首编译+水合慢，用终态轮询（固定 sleep 会假 FAIL）
const goalCard = await page.getByText("这次读这本书，你想得到什么？").waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
check("目标卡出现", goalCard);
await page.screenshot({ path: ".tmp-shots/v25-1-goal.png" });

// 3) 四目标 + 直接开始（PRD 验收 1：不填问卷直接进阅读）
const goalBtns = await page.getByRole("button", { name: /理解|思考|应用|沉淀/ }).count();
check("四个目标按钮", goalBtns >= 4, `count=${goalBtns}`);
await page.getByRole("button", { name: "直接开始" }).click();
await page.getByText("这本书在讲什么").waitFor({ timeout: 15_000 }).catch(() => {});

// 4) 认知地图四区域（PRD 4.2）
check("认知地图条", (await page.getByText("这本书在讲什么").count()) > 0);
check("地图含核心问题区", (await page.getByText("这本书在解决什么问题").count()) > 0);
check("地图含争议区", (await page.getByText("争议与局限").count()) > 0);
await page.screenshot({ path: ".tmp-shots/v25-2-map.png" });

// 5) 左栏路线 + 节点展开导读（PRD 4.3）
check("路线列存在", (await page.getByText("阅读路线").count()) > 0);
await page.getByText("互惠原理").first().click();
await page.waitForTimeout(900);
check("节点导读-核心论点", (await page.getByText("核心论点").count()) > 0);
check("节点导读-先读依赖", (await page.getByText("先读").count()) === 0); // 首节点无前置
check("节点导读-学完应该能", (await page.getByText("学完应该能").count()) > 0);
check("开始验收按钮", (await page.getByText(/开始验收/).count()) > 0);
check("沉淀输入区", (await page.getByText("沉淀一句话").count()) > 0);
check("排序按钮", (await page.locator('button[aria-label="下移节点"]').count()) > 0);
await page.screenshot({ path: ".tmp-shots/v25-3-node.png" });

// 6) 右栏学习状态面板（PRD 3.3）
check("右栏-阅读目标", (await page.getByText("阅读目标").count()) > 0);
check("右栏-理解状态", (await page.getByText("理解状态").count()) > 0);
check("右栏-验收进度", (await page.getByText("验收进度").count()) > 0);
check("右栏-整本书状态机", (await page.getByText("整本书").count()) > 0);
check("关键概念chip", (await page.getByText("互惠", { exact: true }).count()) > 0);
await page.screenshot({ path: ".tmp-shots/v25-4-panel.png" });

// 7) 五模式选择器存在（菜单打开行为不在此测——遮罩关闭层会拦截脚本后续点击，属正确产品行为）
check("模式按钮-苏格拉底", (await page.getByText("苏格拉底").count()) > 0);
check("模式按钮-提示语", (await page.getByText("未手动选择时，AI 会按节点与你的状态推荐").count()) === 0); // 菜单未开时不应出现

// 8) 节点状态机：标记已读完 → done；跳过 → skipped
await page.getByRole("button", { name: "标记已读完（不验收）" }).first().click();
await page.waitForTimeout(700);
check("手动读完节点打勾", (await page.locator(".text-ok").count()) > 0);
await page.getByRole("button", { name: "跳过" }).first().click();
await page.waitForTimeout(700);
check("跳过按钮变恢复", (await page.getByText("恢复此节点").count()) > 0);
await page.screenshot({ path: ".tmp-shots/v25-5-status.png" });

// 9) 书架徽标（已读完≠已掌握分离）——回到书架先等列表渲染
await page.goto(`${BASE}/learn?tab=read`, { waitUntil: "domcontentloaded" });
await page.getByText("影响力").waitFor({ timeout: 20_000 }).catch(() => {});
check("书架卡显示目标摘要", (await page.getByText(/目标/).count()) > 0);
await page.screenshot({ path: ".tmp-shots/v25-6-shelf.png" });

// 10) 清理：删除种子书 + 探针自删（激活码作废随账号）
await page.evaluate((bookId) => {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("mentora-store")) continue;
    try {
      const st = JSON.parse(localStorage.getItem(k) || "{}");
      if (!st?.state) continue;
      st.state.books = (st.state.books ?? []).filter((b) => b.id !== bookId);
      localStorage.setItem(k, JSON.stringify(st));
    } catch {}
  }
}, BOOK_ID);
const del = await fetch(`${BASE}/api/auth/account`, { method: "DELETE", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ password: PW }) });
console.log("probe cleanup:", del.status);

await browser.close();
console.log(fails.length ? `RESULT: ${fails.length} FAIL → ${fails.join(" / ")}` : "RESULT: ALL PASS");
process.exit(fails.length ? 1 : 0);
