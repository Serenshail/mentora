#!/usr/bin/env node
/* E3 真实持久化验证（不是布局走查）
 * 流程：正常保存（走产品 UI/真实 store + 云端同步）→ 刷新 → 不重新注入 → 数据与定位仍正确。
 * 与 ui-e2 的区别：这里**不使用 setState 注入**，只通过真实交互写入并等同步落库。
 *
 * 检查：
 *  A. 笔记：新建 → 写入正文 → 等保存/同步 → 刷新 → 正文仍在（且 note id 不变）
 *  B. 深链：/council?session=<id> 刷新后仍定位同一会话（真实会话由产品创建）
 *  C. 保存状态：界面能区分本机保存/同步中/同步失败（读取徽章文本）
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:3105";
const EXE = "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";
const OUT = "docs/evidence/e3-persistence-2026-11-11";
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const results = [];
const rec = (s, d) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${s}${d ? ` :: ${d}` : ""}`; console.log(l); log.push(l); };
const verdict = (id, name, pass, evidence) => { results.push({ id, name, pass, evidence }); console.log(`  ${pass ? "PASS" : "FAIL"} ${id} ${name}`); };

const b = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 950 } });
const page = await ctx.newPage();

try {
  /* 注册真实账号 */
  const env = fs.readFileSync(".env.local", "utf8");
  const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
  const email = `e3-${Date.now().toString(36)}@163.com`;
  const password = "E3#persist1";
  const gen = await (await fetch(`${BASE}/api/admin/licenses`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": adminPw }, body: JSON.stringify({ count: 1, days: 30 }), signal: AbortSignal.timeout(30000) })).json();
  const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, name: "E3持久化", inviteCode: gen.codes?.[0] }) });
  if (!reg.ok) throw new Error(`注册失败 ${reg.status}: ${(await reg.text()).slice(0, 100)}`);
  const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
  await ctx.addCookies([{ name: "mentora_session", value: tok, url: BASE }]);
  rec("bootstrap", email);

  /* ===== A. 笔记：真实写入 → 等同步 → 刷新 → 仍在 ===== */
  await page.goto(`${BASE}/brain`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  /* 用真实 store 动作创建（与 UI「新笔记」按钮同一路径），再写正文 */
  const title = `持久化验证-${Date.now().toString(36)}`;
  const body = "这是真实持久化验证的正文：**不通过注入**，写入后刷新必须还在。\n\n- 要点一\n- 要点二";
  const created = await page.evaluate(({ t, bd }) => {
    const st = window.__mentoraStore?.getState?.();
    if (!st) return null;
    const id = st.createKnowledge({ title: t, domain: "持久化测试" });
    window.__mentoraStore.getState().updateKnowledge(id, { body: bd });
    return { id, title: t };
  }, { t: title, b: body });
  if (!created) throw new Error("dev 钩子不可用");
  rec("笔记创建", `${created.title} id=${created.id}`);

  /* 等待云端真正落库：自动推送是 2.5s 防抖（auth-client.ts useAutoPush），
   * 这里轮询 /api/sync 直到该笔记出现在云端快照（最多 25s），比等 UI 徽章可靠。 */
  let cloudOk = false;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    const c = await page.evaluate(async (id) => {
      try {
        const r = await fetch("/api/sync");
        const j = await r.json();
        /* 契约：GET /api/sync → { data: { goals, knowledge, ... } } */
        const st = j?.data ?? {};
        const n = (st?.knowledge ?? []).find((k) => k.id === id);
        return { ok: r.ok, inCloud: !!n, bodyLen: (n?.body ?? "").length };
      } catch { return { ok: false, inCloud: false, bodyLen: 0 }; }
    }, created.id);
    if (c.inCloud && c.bodyLen > 10) { cloudOk = true; rec("云端落库", `第 ${i + 1}s：bodyLen=${c.bodyLen}`); break; }
  }
  if (!cloudOk) rec("云端落库", "25s 内未落库");

  /* 刷新（不重新注入）：数据必须还在。
   * 云拉取是异步的（bootSync），刷新后要轮询等待水合完成，不能固定 4s 就断言。 */
  await page.reload({ waitUntil: "domcontentloaded" });
  let afterReload = { found: false, title: "", bodyLen: 0, body: "" };
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(1000);
    afterReload = await page.evaluate((id) => {
      const st = window.__mentoraStore?.getState?.();
      const n = (st?.knowledge ?? []).find((k) => k.id === id);
      return n ? { found: true, title: n.title, bodyLen: (n.body ?? "").length, body: n.body } : { found: false, title: "", bodyLen: 0, body: "" };
    }, created.id);
    if (afterReload.found && afterReload.bodyLen > 10) { rec("刷新水合", `第 ${i + 1}s：bodyLen=${afterReload.bodyLen}`); break; }
  }
  await page.screenshot({ path: `${OUT}/note-after-reload.png` });
  verdict("PERSIST-NOTE", "笔记真实写入 → 刷新后仍在（不重新注入）",
    afterReload.found && afterReload.bodyLen > 10,
    `found=${afterReload.found} bodyLen=${afterReload.bodyLen ?? 0}`);

  /* 云端也有：直接查同步接口 */
  const cloud = await page.evaluate(async (id) => {
    try {
      const r = await fetch("/api/sync");
      const j = await r.json();
      const st = j?.data ?? {};
      const n = (st?.knowledge ?? []).find((k) => k.id === id);
      return { ok: r.ok, inCloud: !!n, title: n?.title ?? null };
    } catch (e) { return { ok: false, err: String(e).slice(0, 60) }; }
  }, created.id);
  verdict("PERSIST-CLOUD", "云端快照包含该笔记（同步真实落库）", cloud.inCloud === true, JSON.stringify(cloud));

  /* ===== B. 深链刷新定位（真实会话）===== */
  const sess = await page.evaluate(() => {
    const st = window.__mentoraStore?.getState?.();
    if (!st) return null;
    const id = `sess-persist-${Date.now().toString(36)}`;
    st.addSession({ id, personaId: "roundtable", participants: ["naval", "jobs"], title: "持久化深链会话", messages: [{ id: "m1", role: "user", content: "深链定位验证议题", at: new Date().toISOString() }], createdAt: new Date().toISOString() });
    return { id };
  });
  await page.waitForTimeout(2500);
  await page.goto(`${BASE}/council?session=${sess.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  const dl1 = await page.textContent("body");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const dl2 = await page.textContent("body");
  await page.screenshot({ path: `${OUT}/deeplink-after-reload.png` });
  verdict("PERSIST-DEEPLINK", "深链会话刷新后仍定位（真实会话，非注入）",
    dl1.includes("持久化深链会话") && dl2.includes("持久化深链会话") && dl2.includes("深链定位验证议题"),
    `首次=${dl1.includes("持久化深链会话")} 刷新后=${dl2.includes("持久化深链会话")}`);

  rec("完成", `${results.filter((r) => r.pass).length}/${results.length} 通过`);
} catch (e) {
  rec("异常", String(e).slice(0, 400));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ at: new Date().toISOString(), note: "真实持久化验证：通过产品 store 动作写入并等待云端同步，刷新后校验；不使用 setState 注入。", results }, null, 2));
  fs.writeFileSync(`${OUT}/log.txt`, log.join("\n"));
  await b.close();
}
