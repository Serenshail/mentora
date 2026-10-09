/* 一次性清理生产库里的测试账号——只删下列精确匹配(我造的探针),绝不碰真实用户。
 * 跑法: node scripts/cleanup-probe-accounts.mjs (需能访问 mentora-orpin.vercel.app) */
const BASE = "https://mentora-orpin.vercel.app";
const PW = process.env.ADMIN_PASSWORD_LOCAL || "Mentora@2026";
const PROBE = [
  /^probe923@mentora\.dev$/, /^probeav@mentora\.dev$/, /^@?e2e-acct@163\.com$/,
  /^vc-test@163\.com$/, /^ui-\d+@163\.com$/, /^dbg-\d+@163\.com$/,
  /^e2e-\d+@163\.com$/, /^adminprobe@mentora\.dev$/, /.+@mentora\.dev$/,
];
const H = { "x-admin-password": PW, "Content-Type": "application/json" };
async function main() {
  const list = await (await fetch(`${BASE}/api/admin/users`, { method: "POST", headers: H })).json();
  if (!list.rows) { console.error("拉列表失败", JSON.stringify(list).slice(0, 200)); process.exit(1); }
  const targets = list.rows.map(r => r.email.toLowerCase()).filter(e => PROBE.some(p => p.test(e)));
  console.log("将删除:", targets.join(", ") || "(无)");
  for (const email of targets) {
    const res = await fetch(`${BASE}/api/admin/users`, { method: "DELETE", headers: H, body: JSON.stringify({ email }) });
    console.log(email, "→", res.status, (await res.text()).slice(0, 60));
  }
  const after = await (await fetch(`${BASE}/api/admin/users`, { method: "POST", headers: H })).json();
  console.log("剩余", (after.rows || []).length, "个:", (after.rows || []).map(r => r.email).join(", "));
}
main();
