/* 逐条复现 archivePrevious 用到的 SQL 形态，定位 400（探针用完即删行） */
import fs from "node:fs";
const envTxt = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const get = (k) => {
  const m = new RegExp(`^${k}=\\s*"?([^"\\n]+)"?`, "m").exec(envTxt);
  return m?.[1]?.trim();
};
const ACC = get("CLOUDFLARE_ACCOUNT_ID"), DB = get("CLOUDFLARE_D1_DATABASE_ID"), TOK = get("CLOUDFLARE_D1_API_TOKEN");
async function q(label, sql, params) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACC}/d1/database/${DB}/query`,
    { method: "POST", headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" }, body: JSON.stringify({ sql, params }), signal: AbortSignal.timeout(8000) }
  );
  const j = await r.json().catch(() => null);
  const bad = j?.errors?.length ? j.errors : j?.result?.some?.((x) => x.success === false && x.error) ? [j.result[0].error] : null;
  console.log(`${label}: HTTP ${r.status} ${bad ? "ERR " + JSON.stringify(bad).slice(0, 240) : "ok"}`);
}
const uid = "probe-v17-aaaa";
await q("list", "SELECT k FROM kv WHERE k LIKE ?", [`versions/${uid}/%`]);
await q("delete-small", "DELETE FROM kv WHERE k LIKE ?", [`versions/${uid}/1760000000000.json#p%`]);
await q("insert", "INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [`versions/${uid}/1760000000000.json`, "GZ1.dGVz"]);
await q("list2", "SELECT k FROM kv WHERE k LIKE ?", [`versions/${uid}/%`]);
await q("cleanup", "DELETE FROM kv WHERE k = ?", [`versions/${uid}/1760000000000.json`]);
