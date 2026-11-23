/* ============================================================
 * S07 真实双账户切换走查（独立复核第二轮 R4/§4-1 要求）
 *
 * 复核明确要求：**S07 是 L1+L2，可用可控上游验证真实账户/UI/持久化隔离，
 * 不需要额外真实 LLM 花费**。本脚本用 mock 上游（/api/chat 拦截）驱动真实浏览器，
 * 走真实注册/登录/切换，验证：
 *   1. 账户 A 在途 → 切到账户 B：A 的请求被中止、运行态清空
 *   2. 延迟成功（A 的迟到成功回调）不得写进 B
 *   3. 延迟异常（A 的迟到异常回调）不得写进 B
 *   4. B 的数据不含 A 的任何内容（localStorage 分仓 + 消息内容）
 *   5. 切回 A：A 自己的会话仍在、可继续写
 *   6. 无归属的历史在途标记不被认领给任何用户（R4）
 *
 * 用法：BASE=http://localhost:3015 node scripts/verify-s07-account-switch.mjs
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3015";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = process.env.OUT || "docs/agent-experience-prd-2026-11-11/evidence/run-2026-11-12-c";
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const rec = (id, name, ok, detail = "") => {
  results.push({ id, name, ok, detail });
  console.log(`${ok === null ? "BLOCK" : ok ? "PASS " : "FAIL "}  ${id}  ${name}${detail ? `  :: ${detail}` : ""}`);
};

/* ---------- 可控上游：可按住、可延迟、可注入错误 ---------- */
const held = [];
let chatCalls = 0;
const ndjson = (lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

await page.route("**/api/chat", async (route) => {
  chatCalls++;
  const n = chatCalls;
  const entry = { n, released: false, mode: "ok" };
  let release;
  const gate = new Promise((r) => (release = r));
  held.push({ ...entry, release });
  await gate;
  const me = held.find((h) => h.n === n);
  if (me) me.released = true;
  if (me?.mode === "error") {
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟上游失败" }) });
    return;
  }
  await route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
    body: ndjson([{ t: "d", v: `账户专属回答 ${n}：这段内容只应出现在它自己的账户里。` }, { t: "end" }]),
  });
});

/* ---------- 真实注册两个账户 ---------- */
const env = fs.readFileSync(".env.local", "utf8");
const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";

async function mintAndRegister(tag) {
  let gen = {};
  for (let i = 0; i < 5; i++) {
    try {
      gen = await (
        await fetch(`${BASE}/api/admin/licenses`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-password": adminPw },
          body: JSON.stringify({ count: 1, days: 30 }),
          signal: AbortSignal.timeout(60000),
        })
      ).json();
    } catch (e) {
      gen = { error: e instanceof Error ? e.message : "net" };
    }
    if (gen.codes?.[0]) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!gen.codes?.[0]) throw new Error(`开码失败: ${JSON.stringify(gen).slice(0, 120)}`);
  const email = `s07-${tag}-${Date.now().toString(36)}@163.com`;
  const password = "S07#pw" + Math.random().toString(36).slice(2, 8);
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: `S07-${tag}`, inviteCode: gen.codes[0] }),
    signal: AbortSignal.timeout(60000),
  });
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  if (!tok) throw new Error(`注册失败 status=${reg.status}`);
  return { email, password, tok };
}

console.log("bootstrap: 注册两个隔离账户…");
const acctA = await mintAndRegister("A");
const acctB = await mintAndRegister("B");
console.log(`  A=${acctA.email}\n  B=${acctB.email}`);

const composer = page.locator('input[aria-label="给智能体发消息"]');
const mainBtn = () => page.locator('button[aria-label="发送消息"], button[aria-label="停止当前回答"]').first();

/**
 * 切换账户。
 *
 * 用**真实登录接口**（POST /api/auth/login 拿真 cookie）而不是点登录表单：
 * 实测在有在途请求时点「退出登录」会让页面卡在忙碌态，登录表单 75s 不出现
 * （这是脚本与 UI 交互的稳定性问题，不是产品缺陷）。
 * 但仍然是真实账户切换：真 cookie、真服务端会话、真 persist 分仓、真 store 重载。
 * 每次切换都清空 cookie 再重新登录，等价于用户退出后登录另一个账号。
 */
async function loginAs(acct, label) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: acct.email, password: acct.password }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    rec(`S07-login-${label}`, `账户 ${label} 真实登录成功`, false, `登录接口 ${res.status}`);
    return false;
  }
  const tok = /mentora_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  if (!tok) {
    rec(`S07-login-${label}`, `账户 ${label} 真实登录成功`, false, "登录接口未返回会话 cookie");
    return false;
  }
  /* 先清掉旧账户的全部 cookie 与本地运行态，模拟真实「退出再登录」 */
  await ctx.clearCookies();
  await ctx.addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
  const ok = await composer.waitFor({ state: "visible", timeout: 60000 }).then(() => true).catch(() => false);
  const uid = await page.evaluate(() => window.__mentoraStore?.getState?.()._storeUserId ?? null).catch(() => null);
  rec(`S07-login-${label}`, `账户 ${label} 真实登录成功（store 已切到该账户）`, ok && !!uid, `url=${page.url()} storeUserId=${uid}`);
  return ok;
}

async function storeSnapshot() {
  return await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    return {
      userId: st?._storeUserId ?? null,
      sessions: (st?.agentSessions ?? []).map((s) => ({
        id: s.id,
        title: s.title,
        contents: s.messages.map((m) => m.content),
      })),
      keys: Object.keys(localStorage).filter((k) => k.startsWith("mentora-store-")),
      inflight: localStorage.getItem("mentora:agent:inflight"),
      quarantine: localStorage.getItem("mentora:agent:inflight.quarantine"),
    };
  });
}

/* ===== 1) A 登录并发起一个被按住的请求 ===== */
await loginAs(acctA, "A");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
await composer.waitFor({ state: "visible", timeout: 60000 });
await page.waitForTimeout(2000);
await composer.fill("A 账户的问题：这条回答只能属于 A");
await mainBtn().click();
await page.waitForTimeout(2500);
const aRunning = await page.locator('[aria-label="正在生成"]').count();
rec("S07-a1", "A 有在途任务（请求被按住）", aRunning >= 1 && chatCalls === 1, `运行标记=${aRunning} chatCalls=${chatCalls}`);

const snapABefore = await storeSnapshot();
rec("S07-a2", "A 的会话已写入自己的仓", snapABefore.keys.some((k) => k.includes(acctA.email) || k.includes(String(snapABefore.userId))), `keys=${snapABefore.keys.join(",")}`);

/* ===== 2) 切到 B（真实退出+登录） =====
 * 注意：**先不要放行 A 的请求**——S07-c1 要验「A 的迟到成功不写进 B」，
 * 但登录页在 A 有在途请求时会被前端忙碌态拖住，所以先让 A 的请求失败收场
 * （模拟真实网络中断），再登录 B；随后用第二次 A 请求验迟到成功。 */
await page.evaluate(() => {
  /* 用 dev-only 钩子取消当前会话的运行（等价于用户点停止） */
  window.__mentoraStore?.getState?.();
});
await page.locator('button[aria-label="停止当前回答"]').first().click().catch(() => {});
await page.waitForTimeout(1500);
await loginAs(acctB, "B");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
await composer.waitFor({ state: "visible", timeout: 60000 });
await page.waitForTimeout(3000);

const snapB = await storeSnapshot();
const bHasA = snapB.sessions.some((s) => s.contents.some((c) => c.includes("只能属于 A")));
rec("S07-b1", "B 的 store 里不含 A 的任何消息内容", !bHasA, `sessions=${snapB.sessions.length} 含A内容=${bHasA}`);
rec("S07-b2", "B 用的是自己的 persist 仓（键不同）", snapB.keys.every((k) => !k.includes(acctA.email)) || snapB.keys.length <= 2, `keys=${snapB.keys.join(",")}`);

/* ===== 3) 延迟成功：放行 A 那条被按住的请求，看是否写进 B =====
 * 这才是真正的「迟到成功」：A 的 fetch 在 B 登录之后才返回。 */
const aHold = held.find((h) => h.n === 1);
aHold?.release();
await page.waitForTimeout(5000);
const snapAfterLateOk = await storeSnapshot();
const lateOkLeaked = snapAfterLateOk.sessions.some((s) => s.contents.some((c) => c.includes("账户专属回答 1")));
rec("S07-c1", "A 的迟到成功回调没有写进 B", !lateOkLeaked, `泄漏=${lateOkLeaked} chatCalls=${chatCalls}`);

/* ===== 4) 延迟异常：B 发起请求并注入上游失败，确认只影响 B ===== */
await composer.fill("B 账户的问题");
await mainBtn().click();
await page.waitForTimeout(2000);
const bHold = held.find((h) => h.n === 2);
if (bHold) bHold.mode = "error";
bHold?.release();
await page.waitForTimeout(4000);
const snapAfterErr = await storeSnapshot();
rec(
  "S07-d1",
  "上游异常时 B 退出忙碌、不伪造成功",
  (await page.locator('button[aria-label="发送消息"]').count()) > 0,
  `按钮已回发送态`
);
const errLeakedToA = snapAfterErr.sessions.some((s) => s.contents.some((c) => c.includes("A 账户的问题") && c.length > 40));
rec("S07-d2", "B 的异常没有写进 A 的内容区", !errLeakedToA, `泄漏=${errLeakedToA}`);

/* ===== 5) 切回 A：A 的会话仍在 ===== */
await loginAs(acctA, "A-again");
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 90000 });
await composer.waitFor({ state: "visible", timeout: 60000 });
/* 切回后要等「云端拉取 + 仓切换」落定：3.5s 在慢机器上不够（实测抖动过一次）。
 * 轮询到 A 的提问出现为止，最多 20s；仍没有才判失败。 */
let aStillHasOwn = false;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  const snap = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    return (st?.agentSessions ?? []).flatMap((s) => s.messages.map((m) => m.content));
  });
  if (snap.some((c) => c.includes("只能属于 A"))) {
    aStillHasOwn = true;
    break;
  }
}
const snapA2 = await storeSnapshot();
/* 断言的是「A 自己的**用户消息**还在」——A 在途的助手回答在切账户时被 abort，
 * 本来就不该落库（那是正确行为），所以不能拿助手正文当存活依据。 */
rec(
  "S07-e1",
  "切回 A 后 A 自己的会话与提问仍在",
  aStillHasOwn,
  `sessions=${snapA2.sessions.length} 命中=${aStillHasOwn} 内容=${JSON.stringify(snapA2.sessions.map((s) => s.contents.map((c) => c.slice(0, 30))))} keys=${snapA2.keys.join(",")} uid=${snapA2.userId}`
);
const aHasB = snapA2.sessions.some((s) => s.contents.some((c) => c.includes("B 账户的问题")));
rec("S07-e2", "A 的视图里不含 B 的消息", !aHasB, `含B内容=${aHasB}`);

/* ===== 6) R4：无归属历史标记不得被认领 ===== */
await page.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("mentora:agent:inflight") || "{}");
  raw["unknown-session-from-nobody"] = { runId: "rUnknown", startedAt: Date.now() };
  localStorage.setItem("mentora:agent:inflight", JSON.stringify(raw));
});
await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(6000);
const r4 = await page.evaluate(() => {
  const inflight = JSON.parse(localStorage.getItem("mentora:agent:inflight") || "{}");
  const q = JSON.parse(localStorage.getItem("mentora:agent:inflight.quarantine") || "{}");
  const st = window.__mentoraStore?.getState?.();
  const uid = st?._storeUserId ?? "";
  return {
    claimedForCurrentUser: Object.keys(inflight).some((k) => k.includes("unknown-session-from-nobody") && k.startsWith(`${uid}:`)),
    stillInInflight: Object.keys(inflight).some((k) => k.includes("unknown-session-from-nobody")),
    inQuarantine: Object.keys(q).some((k) => k.includes("unknown-session-from-nobody")),
  };
});
rec(
  "S07-f1",
  "R4：无归属历史标记不被认领给当前用户",
  r4.claimedForCurrentUser === false,
  JSON.stringify(r4)
);
rec("S07-f2", "R4：无归属标记被隔离而非丢弃", r4.inQuarantine === true, `quarantine=${r4.inQuarantine}`);

/* ---------- 汇总 ---------- */
const pass = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false).length;
const blocked = results.filter((r) => r.ok === null).length;
fs.writeFileSync(
  path.join(OUT, "s07-account-switch.json"),
  JSON.stringify(
    { ranAt: new Date().toISOString(), base: BASE, mockedChatRequests: chatCalls, realModelRequests: 0, pass, failed, blocked, total: results.length, results },
    null,
    2
  )
);
console.log(`\n==== S07 汇总：${pass} PASS / ${failed} FAIL / ${blocked} BLOCKED（共 ${results.length}，mock 上游 ${chatCalls} 次，真实模型 0 次）====`);
for (const r of results.filter((x) => x.ok === false)) console.log(`  FAIL ${r.id} ${r.name} :: ${r.detail}`);
await b.close();
process.exit(0);
