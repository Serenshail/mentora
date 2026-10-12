/* 一次性恢复：把 GitHub 兜底仓库里的用户档案搬回 D1（v15 迁移漏搬的存量用户）。
 * 只搬 users/ 档案（salt/hash/userId 原样 → 老密码继续有效）；不动 data/ 快照——
 * 登录后"云端为空→本机自动推上云"的路径会让数据自然回流，避免旧快照覆盖本机新数据。
 * 跑法: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<代理> node scripts/restore-users-from-github.mjs */
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";

const envTxt = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const get = (k) => {
  const m = new RegExp(`^${k}=\\s*"?([^"\\n]+)"?`, "m").exec(envTxt);
  return m?.[1]?.trim();
};
const ACC = get("CLOUDFLARE_ACCOUNT_ID"), DB = get("CLOUDFLARE_D1_DATABASE_ID"), TOK = get("CLOUDFLARE_D1_API_TOKEN");
const GR = get("GITHUB_DB_REPO"), GT = get("GITHUB_DB_TOKEN");
const KEY = crypto.scryptSync(get("AUTH_SECRET"), "mentora-db-v1", 32);
if (!ACC || !GR || !GT) { console.error("缺 env"); process.exit(1); }

const GH = { Authorization: `token ${GT}`, Accept: "application/vnd.github+json", "User-Agent": "mentora-restore" };

function decrypt(payload) {
  const gz = payload.startsWith("GZ1.");
  const raw = Buffer.from(gz ? payload.slice(4) : payload, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  const plain = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  return JSON.parse((gz ? zlib.gunzipSync(plain) : plain).toString("utf8"));
}
function encrypt(obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 9 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  return "GZ1." + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
const GH_HEADERS = { Authorization: `token ${GT}`, Accept: "application/vnd.github+json", "User-Agent": "mentora-restore" };
async function q(sql, params) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`, {
    method: "POST", headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => null);
  if (!j?.success) throw new Error(`D1 ${r.status}: ${JSON.stringify(j?.errors).slice(0, 150)}`);
  return j.result?.[0]?.results ?? [];
}

/* 探针/测试账号不搬（与 cleanup-probe-accounts.mjs 名单一致的历史残留） */
const isProbe = (email) =>
  /@mentora\.dev$/.test(email) ||
  /^(e2e-|dbg-|ui-|probe|vc-test|adminprobe|smoke|v17-)/i.test(email) ||
  /^@?e2e-acct@163\.com$/.test(email);

const list = await (await fetch(`https://api.github.com/repos/${GR}/contents/users`, { headers: GH, signal: AbortSignal.timeout(15000) })).json();
console.log("GitHub users/ 文件:", list.length);
let restored = 0, skipped = 0;
for (const f of list) {
  const raw = await (await fetch(f.url, { headers: GH, signal: AbortSignal.timeout(15000) })).json();
  let rec;
  try { rec = decrypt(Buffer.from(raw.content, "base64").toString("utf8")); }
  catch (e) { console.log("  ✗ 解密失败", f.name, String(e).slice(0, 60)); skipped++; continue; }
  if (!rec?.email || !rec?.salt || !rec?.hash) { console.log("  ✗ 结构异常", f.name); skipped++; continue; }
  if (isProbe(rec.email)) { console.log("  - 跳过探针/测试号:", rec.email); skipped++; continue; }
  const path = `users/${crypto.createHash("sha256").update(rec.email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
  const exist = await q("SELECT k FROM kv WHERE k = ?", [path]);
  if (exist.length) { console.log("  = D1 已存在，不动:", rec.email); skipped++; continue; }
  await q("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [path, encrypt({ ...rec, sv: rec.sv ?? 0 })]);
  console.log("  ✓ 恢复:", rec.email, "| userId:", rec.userId, "| 注册:", (rec.createdAt || "?").slice(0, 10));
  restored++;
}
console.log(`\n完成：恢复 ${restored}，跳过 ${skipped}`);
