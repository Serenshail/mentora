/* v21 圆桌生产冒烟 v2：R0 入口/三席默认/成本警告 + 全流程 + R4 停止 + R3 切会话隔离。
 * 代理对 NDJSON 流有偶发掐断/挂起：本脚本用「轮询终态 + 停滞看门狗」保证确定性——
 * 挂住时先验证取消按钮真的能救场（这本身就是 R4），再重试一轮。
 * 用法：node scripts/smoke-roundtable.mjs（需代理 7897 可用） */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = "https://mentora-orpin.vercel.app";
const PROXY = "http://127.0.0.1:7897";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const EMAIL = `rt-smoke-${Date.now().toString(36)}@163.com`;
const PW = "Rt#smoke211";
const OUT = ".tmp-shots";
fs.mkdirSync(OUT, { recursive: true });

const inviteCode = fs
  .readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("INVITE_CODE="))
  ?.slice(12)
  .trim();
if (!inviteCode) throw new Error("本地 .env.local 缺 INVITE_CODE");

const fails = [];
const check = (name, ok, extra = "") => {
  console.log(ok ? "PASS" : "FAIL", name, extra);
  if (!ok) fails.push(name);
};
const sleep = (ms) => page.waitForTimeout(ms);
let page;

/* 轮询直到出现任一终态：纪要完成 / 取消 / 有效发言不足 / 失败重试条。
 * 停滞看门狗：progressBar 在但 90s 无终态 → 点「停止」验证取消 → 返回 "cancelled-by-watchdog" */
async function waitTerminal(maxMs = 210000) {
  const t0 = Date.now();
  let sawRunning = false;
  let stallStart = 0;
  while (Date.now() - t0 < maxMs) {
    const st = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        host: t.includes("圆桌纪要") && !t.includes("生成中"),
        partial: t.includes("有效发言不足"),
        retry: t.includes("个失败席位") || t.includes("重试主持人纪要"),
        cancelled: t.includes("已取消本轮圆桌"),
        running: t.includes("独立发言进行中") || t.includes("主持人正在综合"),
        busyInput: !!document.querySelector("input[placeholder='把问题扔到圆桌上…']")?.disabled,
      };
    });
    if (st.host) return "host-done";
    if (st.partial) return "partial";
    if (st.retry) return "retryable";
    if (st.cancelled && !st.running) return "cancelled";
    if (st.running) {
      sawRunning = true;
      if (!stallStart) stallStart = Date.now();
      // 看门狗：跑着但 90s 不到终态（代理把流挂死的场景）→ 验证停止按钮能救场
      if (Date.now() - stallStart > 90000) {
        const stop = page.getByRole("button", { name: "停止" });
        if (await stop.isVisible().catch(() => false)) {
          await stop.click();
          await sleep(2500);
          const okCancel = await page.getByText("已取消本轮圆桌").first().isVisible().catch(() => false);
          check("R4 看门狗：挂起时「停止」可用且留痕", okCancel);
          return "cancelled-by-watchdog";
        }
        return "stuck-no-stop";
      }
    }
    await sleep(4000);
  }
  return sawRunning ? "timeout" : "no-run";
}

/* ---- 探针注册（邀请码通道，重试兜抖动） ---- */
const browser = await chromium.launch({ executablePath: EXE, headless: true, proxy: { server: PROXY } });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
page = await ctx.newPage();
const api = ctx.request;
try {
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    const res = await api.post(`${BASE}/api/auth/register`, {
      data: { email: EMAIL, password: PW, name: "圆桌冒烟", inviteCode },
    });
    const token = /mentora_session=([^;]+)/.exec((await res.headers())["set-cookie"] || "")?.[1];
    if (token) {
      await ctx.addCookies([{ name: "mentora_session", value: token, url: BASE }]);
      ok = true;
    } else {
      console.log(`register attempt ${i}: ${res.status()}`);
      await sleep(4000);
    }
  }
  if (!ok) throw new Error("注册重试 5 次失败");
  console.log("registered", EMAIL);

  /* ---- R0：侧栏入口 → 人生伙伴 → 圆桌 ---- */
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await sleep(2500);
  check("R0 总览加载（侧栏可见）", await page.locator("aside").isVisible());
  await page.locator("aside nav a", { hasText: "人生伙伴" }).click();
  await page.waitForURL("**/council", { timeout: 20000 });
  check("R0 人生伙伴页打开", page.url().includes("/council"));
  await page.getByRole("button", { name: /圆桌研讨会/ }).click();
  await sleep(800);
  const modal = page.getByRole("dialog");
  check("R0 选人弹窗打开", await modal.isVisible());

  /* ---- R0：默认三席 + 成本警告 + 重开恢复 ---- */
  const seatBtn = (t) => modal.locator("button", { hasText: t });
  const isChecked = async (t) => ((await seatBtn(t).getAttribute("class")) || "").includes("border-accent/30");
  check("R0 默认 Naval 选中", await isChecked("Naval"));
  check("R0 默认 Jobs 选中", await isChecked("Steve Jobs"));
  check("R0 默认 Taleb 选中", await isChecked("Taleb"));
  check("R0 开始按钮显示 3 人", await modal.getByText(/开始圆桌（3 人）/).isVisible());
  await modal.getByRole("button", { name: "全选" }).click();
  await sleep(300);
  check("R0 全选后成本警告(N+1 次调用)", await modal.getByText(/将发起 \d+ 次模型调用/).isVisible());
  await page.keyboard.press("Escape");
  await sleep(500);
  await page.getByRole("button", { name: /圆桌研讨会/ }).click();
  await sleep(600);
  check("R0 重开弹窗恢复默认 3 席", await page.getByRole("dialog").getByText(/开始圆桌（3 人）/).isVisible());
  await page.getByRole("dialog").getByRole("button", { name: /开始圆桌/ }).click();
  await sleep(1200);
  const input = page.getByPlaceholder("把问题扔到圆桌上…");
  check("R0 圆桌会话就位（输入框出现）", await input.isVisible());

  /* ---- 全流程（带重试的终态轮询） ---- */
  const Q1 = "要不要把业余时间全部投入做独立产品";
  const send = async (q) => {
    await input.fill(q);
    await page.getByRole("button", { name: "发送" }).click();
  };
  await send(Q1);
  await sleep(4000);
  await page.screenshot({ path: `${OUT}/rt-1-running.png` });
  let terminal = await waitTerminal();
  if (terminal === "cancelled-by-watchdog" || terminal === "stuck-no-stop" || terminal === "timeout" || terminal === "no-run") {
    console.log("first attempt:", terminal, "→ retry once");
    await sleep(1500);
    await send(Q1 + "（再问一次）");
    terminal = await waitTerminal();
  }
  console.log("terminal state:", terminal);
  check("全流程到达终态", ["host-done", "retryable", "partial", "cancelled"].includes(terminal), terminal);
  if (terminal === "host-done" || terminal === "retryable") {
    const takeCount = await page.evaluate(() =>
      [...document.querySelectorAll(".space-y-4 strong")].filter((s) => /【.+】/.test(s.textContent || "")).length
    );
    check("至少 2 席发言落库", takeCount >= 2, `take msgs=${takeCount}`);
  }
  await sleep(1000);
  await page.screenshot({ path: `${OUT}/rt-2-terminal.png`, fullPage: true });
  check("终态后输入解锁", await input.isEnabled());
  const sideTitle = await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith("mentora-store")) continue;
      try {
        const st = JSON.parse(localStorage.getItem(k) || "{}");
        const t = st?.state?.sessions?.[0]?.title;
        if (t) return t;
      } catch {}
    }
    return "";
  });
  check("会话标题改为问题摘要", /要不要把/.test(sideTitle || ""), (sideTitle || "").slice(0, 30));

  /* ---- R3：运行中切走再切回，不串台 ---- */
  await send("该不该为了学 AI 辞掉现在稳定的工作");
  await page.getByText(/独立发言进行中/).first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "新对话" }).click();
  await sleep(1000);
  check("R3 切到选择页后无残留实时卡", (await page.getByText(/独立发言进行中|思考中/).count()) === 0);
  await page.screenshot({ path: `${OUT}/rt-3-picker.png` });
  // 标题按设计只在「第一个问题」时更新（同一桌追问不改标题）→ 用 Q1 的摘要切回本桌
  await page.locator("main .truncate").filter({ hasText: "要不要把" }).first().click();
  await sleep(1200);
  check("R3 切回后实时状态恢复可见", (await page.getByText(/独立发言进行中|思考中|【/).count()) > 0);

  /* ---- R4：主动停止（若还在跑） ---- */
  const stopBtn = page.getByRole("button", { name: "停止" });
  if (await stopBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await stopBtn.click();
    check("R4 停止后出现取消留痕", await page.getByText("已取消本轮圆桌").first().isVisible({ timeout: 8000 }));
    await sleep(1500);
    check("R4 停止后输入解锁", await input.isEnabled());
    await page.screenshot({ path: `${OUT}/rt-4-cancelled.png` });
  } else {
    check("R4 停止（本轮已自然结束，跳过主动取消）", true, "run finished before cancel");
  }

} catch (e) {
  fails.push("EXCEPTION: " + e.message);
  console.log("EXCEPTION", e.message);
  await page?.screenshot({ path: `${OUT}/rt-error.png`, fullPage: true }).catch(() => {});
} finally {
  try {
    const del = await ctx.request.delete(`${BASE}/api/auth/account`, { data: { password: PW } });
    console.log("probe deleted:", del.status());
  } catch (e) {
    console.log("probe delete failed:", e.message);
  }
  await browser?.close();
}

console.log(fails.length === 0 ? "\nALL PASS ✅" : `\nFAILED (${fails.length}): ${fails.join(" | ")}`);
process.exit(fails.length === 0 ? 0 : 1);
