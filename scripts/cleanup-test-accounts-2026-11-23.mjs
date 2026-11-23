/* 清理历次自动化测试残留账号（一次性）
 *
 * 规则（三条任一命中即删）：
 *   1. 邮箱 @example.invalid 或 @mentora.dev
 *   2. 邮箱前缀命中测试命名：e1-/e2-/e3-/p-/p2-/p3-/p4-/p5-/up-/dbg/probe/smoke/qa-/l2-/l3-/act-/s07-/intent-/mentora-web-qa-/mentora-lifecycle-qa-/l3-/l2b-
 *   3. 名字含 走查/验收/测试/持久化
 *
 * 保留：任何不命中上述规则的账号（含真实用户）。
 * 先 dry-run 打印将删清单，加 APPLY=1 才真正删。
 */
import fs from "node:fs";

const BASE = process.env.BASE || "https://mentora-orpin.vercel.app";
const PW = process.env.ADMIN_PASSWORD || "";
const APPLY = process.env.APPLY === "1";
if (!PW) {
  console.error("缺 ADMIN_PASSWORD");
  process.exit(1);
}

const H = { "x-admin-password": PW, "Content-Type": "application/json" };

const EMAIL_DOMAIN = /@(example\.invalid|mentora\.dev)$/i;
/* 邮箱前缀：历次自动化/冒烟/诊断脚本造的号。
 * 模式统一特征 = 「<标签>-<时间戳base36>@163.com」，标签是小写字母+数字。
 * 显式列出已知标签，避免误伤真实邮箱。 */
const EMAIL_PREFIX =
  /^(e1-|e2-|e3-|e3w-|p-|p2-|p3-|p4-|p5-|pe-|pe2-|up-|dbg|dbg2-|dbgi-|of-|probe|smoke|qa-|l2-|l2b-|l3-|act-|s07-|intent-|eval-|in13-|in13b-|rt-fault-|v18-|v23-|v232-|v233-|v25|deep-|mentora-web-qa-|mentora-lifecycle-qa-)/i;
const NAME_BAD = /走查|验收|测试|持久化|冒烟|故障注入|probe/i;

function shouldDelete(u) {
  const email = (u.email || "").toLowerCase();
  const name = u.name || "";
  if (EMAIL_DOMAIN.test(email)) return "domain";
  if (EMAIL_PREFIX.test(email)) return "prefix";
  if (NAME_BAD.test(name)) return "name";
  return null;
}

console.log(`拉取用户列表（${BASE}）…`);
const t0 = Date.now();
const res = await fetch(`${BASE}/api/admin/overview`, { headers: H, signal: AbortSignal.timeout(120000) });
if (!res.ok) {
  console.error(`拉取失败 ${res.status}`);
  process.exit(1);
}
const ov = await res.json();
const users = ov.users || [];
console.log(`共 ${users.length} 个账号，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const targets = [];
const keep = [];
for (const u of users) {
  const why = shouldDelete(u);
  if (why) targets.push({ ...u, why });
  else keep.push(u);
}

console.log(`=== 将删除 ${targets.length} 个 ===`);
const byWhy = {};
for (const t of targets) byWhy[t.why] = (byWhy[t.why] || 0) + 1;
console.log("命中原因分布:", JSON.stringify(byWhy));
for (const t of targets.slice(0, 20)) console.log(`  [${t.why}] ${t.email} | ${t.name}`);
if (targets.length > 20) console.log(`  …共 ${targets.length} 个`);

console.log(`\n=== 将保留 ${keep.length} 个 ===`);
for (const k of keep) console.log(`  ${k.email} | ${k.name} | ${k.createdAt?.slice(0, 10)}`);

if (!APPLY) {
  console.log("\n（dry-run，未删除。加 APPLY=1 执行）");
  fs.writeFileSync(".tmp-cleanup-plan.json", JSON.stringify({ targets: targets.map((t) => ({ email: t.email, why: t.why })), keep: keep.map((k) => k.email) }, null, 2));
  console.log("清单已存 .tmp-cleanup-plan.json");
  process.exit(0);
}

console.log(`\n=== 开始删除 ${targets.length} 个 ===`);
let ok = 0;
let fail = 0;
const failures = [];
/* 限流是 20/min 量级：每次删之间留足间隔，429 时退避重试（最多 5 次） */
async function delOne(email) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(`${BASE}/api/admin/users`, {
        method: "DELETE",
        headers: H,
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(60000),
      });
      if (r.ok) return { ok: true };
      if (r.status === 429) {
        const wait = 8000 * attempt;
        console.log(`    429 退避 ${wait / 1000}s（第 ${attempt} 次）…`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      const txt = await r.text().catch(() => "");
      if (r.status === 404) return { ok: true }; // 已不存在 = 目标达成
      return { ok: false, status: r.status, msg: txt.slice(0, 100) };
    } catch (e) {
      if (attempt === 5) return { ok: false, error: e instanceof Error ? e.message : "unknown" };
      await new Promise((res) => setTimeout(res, 5000 * attempt));
    }
  }
  return { ok: false, error: "重试耗尽" };
}

for (const t of targets) {
  const r = await delOne(t.email);
  if (r.ok) {
    ok++;
    if (ok % 20 === 0) console.log(`  已删 ${ok}/${targets.length}…`);
  } else {
    fail++;
    failures.push({ email: t.email, ...r });
  }
  await new Promise((r2) => setTimeout(r2, 3500)); // 20/min ≈ 3s/次
}
console.log(`\n删除完成：成功 ${ok}，失败 ${fail}`);
if (failures.length) {
  console.log("失败明细（前 10）:");
  for (const f of failures.slice(0, 10)) console.log("  ", JSON.stringify(f));
  fs.writeFileSync(".tmp-cleanup-failures.json", JSON.stringify(failures, null, 2));
}

/* 复核：重新拉一次 */
console.log("\n=== 复核 ===");
const t1 = Date.now();
const res2 = await fetch(`${BASE}/api/admin/overview`, { headers: H, signal: AbortSignal.timeout(120000) });
const ov2 = await res2.json();
console.log(`剩余账号: ${(ov2.users || []).length}，拉取耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
