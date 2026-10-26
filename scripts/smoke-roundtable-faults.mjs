/* R2 故障注入验收：浏览器里真的制造失败，验证圆桌不会把残缺结果伪装成完成。
 * 本地 dev（3000，custom 真模型通道）+ Playwright route 拦截 /api/chat：
 *   A 单席失败（1/3）→ 有 2 席有效 → 主持人照常出纪要，并给出失败席位重试入口
 *   B 两席失败（2/3）→ 有效不足 2 席 → 拒绝综合 + 失败席位重试补齐后出纪要
 *   C 主持人失败 → 保留全部发言 + 「重试主持人纪要」→ 重试成功
 *   D 双击发送 → 只发起一轮（不重复写用户问题/席位）
 * 用法：node scripts/smoke-roundtable-faults.mjs */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = "http://localhost:3000";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const EMAIL = `rt-fault-${Date.now().toString(36)}@163.com`;
const PW = "Rt#fault211";
const OUT = ".tmp-shots";
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const pass = (name, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) fails.push(name);
};
let page;

const bodyText = () => page.evaluate(() => document.body.innerText);

/** 轮询直到满足谓词，超时返回 false */
async function until(fn, ms = 120000, step = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await page.waitForTimeout(step);
  }
  return false;
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });

/* ---- 故障注入控制：fault = { take: Set(personaId), host: bool } ---- */
const fault = { take: new Set(), host: false };
let chatCalls = 0;

/* 每个用例独立 context/page：用例间共享 page 会互相污染状态（A/B 之后 C 偶发卡在选择页） */
let sessionToken = "";
async function freshCase() {
  if (page) await page.context().close().catch(() => {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "mentora_session", value: sessionToken, url: BASE }]);
  page = await ctx.newPage();
  await page.route("**/api/chat", async (route) => {
  const req = route.request();
  let body = {};
  try { body = JSON.parse(req.postData() || "{}"); } catch {}
  const mode = body?.args?.mode;
  const pid = body?.args?.personaId;
  const isTake = body?.task === "council" && mode === "take";
  const isHost = body?.task === "council" && mode === "host";
  if (isTake || isHost) chatCalls++;
  if (isTake && fault.take.has(pid)) {
    // 500 = 确定性错误，服务端不重试，前端立刻拿到失败
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "注入故障" }) });
  }
  if (isHost && fault.host) {
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "注入故障" }) });
  }
  return route.continue();
  });
  return page;
}

const bootCtx = await browser.newContext();
const api = bootCtx.request;
try {
  /* ---- 探针注册（本地 dev 走验证码 dev 模式自动回填） ---- */
  const send = await (await api.post(`${BASE}/api/auth/send-code`, { data: { email: EMAIL } })).json();
  const reg = await api.post(`${BASE}/api/auth/register`, {
    data: { email: EMAIL, password: PW, name: "故障注入", code: send.devCode },
  });
  sessionToken = /mentora_session=([^;]+)/.exec((await reg.headers())["set-cookie"] || "")?.[1];
  if (!sessionToken) throw new Error("注册失败 " + reg.status());
  console.log("registered", EMAIL);

  /* ---- 建一个三席圆桌 ---- */
  const newTable = async () => {
    await page.goto(BASE + "/council", { waitUntil: "domcontentloaded" });
    // 新 context 的 localStorage 为空：必须等 /api/auth/me 回来、hydrate 完成后页头才渲染。
    // 固定 sleep 会偶发抢跑（C 卡在选择页的根因）→ 以页头按钮为 hydrate 信号。
    const newChatBtn = page.getByRole("button", { name: "新对话" });
    await newChatBtn.waitFor({ state: "visible", timeout: 30000 });
    const card = page.getByRole("button", { name: /圆桌研讨会/ });
    if (!(await card.isVisible().catch(() => false))) {
      await newChatBtn.click(); // 落在某个旧会话：先唤起选择页
    }
    await card.waitFor({ state: "visible", timeout: 20000 });
    await card.click({ timeout: 15000 });
    const dlg = page.getByRole("dialog");
    try {
      await dlg.waitFor({ state: "visible", timeout: 20000 });
    } catch (e) {
      // 诊断：把失败瞬间的界面状态打出来（是否在选择页/是否有 toast/是否有 busy 提示）
      const diag = await page.evaluate(() => ({
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        hasPickerCard: !!document.querySelector("button")?.textContent,
        body: document.body.innerText.replace(/\s+/g, " ").slice(0, 420),
      }));
      console.log("[DIAG newTable]", JSON.stringify(diag));
      await page.screenshot({ path: ".tmp-shots/fault-newtable-fail.png", fullPage: true });
      throw e;
    }
    await page.waitForTimeout(800); // materialize 入场动画
    const startBtn = dlg.getByRole("button", { name: /开始圆桌/ });
    await startBtn.waitFor({ state: "visible", timeout: 15000 });
    await startBtn.click({ timeout: 20000 });
    // 建桌完成的确定性信号：圆桌输入框出现
    await page.getByPlaceholder("把问题扔到圆桌上…").waitFor({ state: "visible", timeout: 20000 });
  };
  const sendQ = async (q) => {
    await page.getByPlaceholder("把问题扔到圆桌上…").fill(q);
    await page.getByRole("button", { name: "发送" }).click();
  };

  /* ========== A：1/3 席失败 → 仍有 2 席 → 主持人出纪要 + 重试入口 ========== */
  await freshCase(); // A 开头建一次 context，A/B/C 共用（已验证稳定）
  fault.take = new Set(["naval"]);
  fault.host = false;
  await newTable();
  await sendQ("要不要把周末全部投入做一个独立产品");
  const aHasHost = await until(async () => {
    const t = await bodyText();
    return t.includes("圆桌纪要") && !t.includes("主持人纪要（生成中）");
  }, 180000);
  pass("A 单席失败仍出纪要（2 席有效）", aHasHost);
  const aText = await bodyText();
  pass("A 失败席位明确标红", /发言失败/.test(aText));
  pass("A 提供失败席位重试入口", /重试 1 个失败席位/.test(aText));
  await page.screenshot({ path: `${OUT}/fault-a.png`, fullPage: true });

  /* ---- A 续：点重试，Naval 补齐（此时不再注入故障） ---- */
  fault.take = new Set();
  await page.getByRole("button", { name: /重试 1 个失败席位/ }).click();
  const aFixed = await until(async () => /【Naval Ravikant】/.test(await bodyText()), 180000);
  pass("A 单席重试后补齐发言", aFixed);
  const aAfter = await bodyText();
  pass("A 补齐后再次出纪要", aAfter.includes("圆桌纪要"));

  /* ========== B：2/3 席失败 → 拒综合 ========== */
  fault.take = new Set(["naval", "jobs"]);
  await newTable();
  await sendQ("该不该辞掉稳定工作去做独立开发");
  const bRefused = await until(async () => (await bodyText()).includes("有效发言不足"), 180000);
  pass("B 有效席位不足时拒绝综合", bRefused);
  const bText = await bodyText();
  pass("B 不出现圆桌纪要", !bText.includes("圆桌纪要"));
  pass("B 提示可重试失败席位", /重试 2 个失败席位/.test(bText));
  pass("B 输入已解锁（不是卡死）", await page.getByPlaceholder("把问题扔到圆桌上…").isEnabled());
  await page.screenshot({ path: `${OUT}/fault-b.png`, fullPage: true });

  /* ---- B 续：重试 2 席 → 补齐后出纪要 ---- */
  fault.take = new Set();
  await page.getByRole("button", { name: /重试 2 个失败席位/ }).click();
  const bFixed = await until(async () => (await bodyText()).includes("圆桌纪要"), 240000);
  pass("B 补齐 2 席后出纪要", bFixed);
  pass("B 三个席位都落库", /【Naval Ravikant】/.test(await bodyText()) && /【Steve Jobs】/.test(await bodyText()));

  /* ========== C：主持人失败 → 保留发言 + 重试主持人 ========== */
  fault.take = new Set();
  fault.host = true;
  await newTable();
  await sendQ("现在该不该投入全部精力做 AI 方向");
  const cHostFail = await until(async () => (await bodyText()).includes("主持人纪要生成失败"), 240000);
  pass("C 主持人失败显式提示", cHostFail);
  const cText = await bodyText();
  pass("C 失败时保留三席发言", /【Naval Ravikant】/.test(cText) && /【Steve Jobs】/.test(cText) && /Nassim Taleb/.test(cText));
  pass("C 提供重试主持人入口", /重试主持人纪要/.test(cText));
  await page.screenshot({ path: `${OUT}/fault-c.png`, fullPage: true });

  fault.host = false;
  await page.getByRole("button", { name: "重试主持人纪要" }).click();
  const cFixed = await until(async () => (await bodyText()).includes("圆桌纪要"), 240000);
  pass("C 重试主持人成功出纪要", cFixed);

  /* ========== D：双击发送只跑一轮 ========== */
  await freshCase();
  fault.take = new Set();
  fault.host = false;
  await newTable();
  chatCalls = 0;
  await page.getByPlaceholder("把问题扔到圆桌上…").fill("要不要换一个城市生活");
  const sendBtn = page.getByRole("button", { name: "发送" });
  await sendBtn.click();
  await sendBtn.click({ force: true, timeout: 2000 }).catch(() => {}); // 运行中输入禁用，第二击应无效
  await until(async () => (await bodyText()).includes("圆桌纪要"), 240000);
  await page.waitForTimeout(2000);
  // 一轮 = 3 take + 1 host = 4 次；双击若漏过去会是 8 次
  pass("D 双击只发起一轮采购（calls<=4）", chatCalls <= 4, `calls=${chatCalls}`);
  // 只数「用户气泡」，不算会话标题（标题按设计会变成问题摘要）
  const userBubbles = await page.evaluate(() =>
    [...document.querySelectorAll(".space-y-4 > div.flex.justify-end")].filter((d) =>
      (d.textContent || "").includes("要不要换一个城市生活")
    ).length
  );
  pass("D 用户问题只落一条气泡", userBubbles === 1, `userBubbles=${userBubbles}`);
} catch (e) {
  fails.push("EXCEPTION: " + e.message);
  console.log("EXCEPTION", e.message);
  await page?.screenshot({ path: `${OUT}/fault-error.png`, fullPage: true }).catch(() => {});
} finally {
  try { await api.delete(`${BASE}/api/auth/account`, { data: { password: PW } }); console.log("probe deleted"); } catch {}
  await bootCtx.close().catch(() => {});
  await browser.close();
}

console.log(fails.length === 0 ? "\nALL PASS ✅" : `\nFAILED (${fails.length}): ${fails.join(" | ")}`);
process.exit(fails.length === 0 ? 0 : 1);
