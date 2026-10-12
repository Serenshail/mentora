/* 只读诊断：确认生产 D1 里用户档案到底有哪些 */
import fs from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
const envTxt = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const get = (k) => { const m = new RegExp(`^${k}=\\s*"?([^"\\n]+)"?`, "m").exec(envTxt); return m?.[1]?.trim(); };
const ACC = get("CLOUDFLARE_ACCOUNT_ID"), DB = get("CLOUDFLARE_D1_DATABASE_ID"), TOK = get("CLOUDFLARE_D1_API_TOKEN");
const KEY = crypto.scryptSync(get("AUTH_SECRET"), "mentora-db-v1", 32);
function decrypt(payload) {
  const gzipped = payload.startsWith("GZ1.");
  const body = gzipped ? payload.slice(4) : payload;
  const raw = Buffer.from(body, "base64");
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]);
  return JSON.parse((gzipped ? zlib.gunzipSync(plain) : plain).toString("utf8"));
}
async function q(sql, params = []) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`, {
    method: "POST", headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => null);
  if (!r.status || !j?.success) { console.log("ERR", r.status, JSON.stringify(j?.errors || j).slice(0, 200)); return []; }
  return j.result?.[0]?.results ?? [];
}
const rows = await q("SELECT k FROM kv WHERE substr(k, 1, ?) = ?", [6, "users/"]);
console.log("users/ 行数:", rows.length);
const emailHash = (e) => crypto.createHash("sha256").update(e.trim().toLowerCase()).digest("hex").slice(0, 24);
for (const f of rows) {
  const r2 = await q("SELECT v FROM kv WHERE k = ?", [f.k]);
  const v = r2[0]?.v;
  if (!v) { console.log(" -", f.k, "(读值失败)"); continue; }
  try {
    const rec = decrypt(v);
    console.log(" -", rec.email, "| name:", rec.name, "| createdAt:", (rec.createdAt || "?").slice(0, 10), "| sv:", rec.sv ?? "(无)");
  } catch (e) {
    console.log(" -", f.k, "(解密失败:", String(e).slice(0, 60), ")");
  }
}
const target = `users/${emailHash("haow9508@gmail.com")}.json`;
const t = await q("SELECT k FROM kv WHERE k = ?", [target]);
console.log("haow9508@gmail.com 档案行存在:", t.length === 1, `(${target})`);
const dataRows = await q("SELECT k FROM kv WHERE substr(k, 1, ?) = ?", [5, "data/"]);
console.log("data/ 快照行数:", dataRows.length);

// data/ 快照归属与 GitHub 兜底仓库检查
const d0 = await q("SELECT k FROM kv WHERE substr(k, 1, ?) = ?", [5, "data/"]);
for (const f of d0) {
  const r2 = await q("SELECT v FROM kv WHERE k = ?", [f.k]);
  try { const rec = decrypt(r2[0].v); console.log("data:", f.k, "| userId:", rec.userId, "| updatedAt:", rec.updatedAt, "| goals:", rec.data?.goals?.length ?? 0, "knowledge:", rec.data?.knowledge?.length ?? 0); }
  catch (e) { console.log("data:", f.k, "解密失败", String(e).slice(0, 50)); }
}
const GR = get("GITHUB_DB_REPO"), GT = get("GITHUB_DB_TOKEN");
if (GR && GT) {
  const res = await fetch(`https://api.github.com/repos/${GR}/contents/users`, {
    headers: { Authorization: `token ${GT}`, Accept: "application/vnd.github+json", "User-Agent": "diag" },
    signal: AbortSignal.timeout(10000),
  });
  console.log("GitHub users/ 目录 HTTP", res.status);
  if (res.ok) { const list = await res.json(); console.log("GitHub users/ 文件数:", list.length, list.map((f) => f.name).slice(0, 20)); }
  const res2 = await fetch(`https://api.github.com/repos/${GR}/contents/data`, {
    headers: { Authorization: `token ${GT}`, Accept: "application/vnd.github+json", "User-Agent": "diag" },
    signal: AbortSignal.timeout(10000),
  });
  console.log("GitHub data/ 目录 HTTP", res2.status, res2.ok ? "文件数 " + (await res2.json()).length : "");
} else console.log("无 GitHub 兜底配置");
