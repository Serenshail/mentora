// verify custom model channel: reads .env.local (key never echoed)
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
}
const base = env.AI_BASE_URL;
const key = env.CUSTOM_API_KEY;
const model = env.AI_MODEL;
if (!base || !key || !model) {
  console.error(`MISSING: base=${!!base} key=${!!key} model=${!!model}`);
  process.exit(1);
}
const t0 = Date.now();
const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "只回复两个字：收到" }], max_tokens: 200 }),
});
const dt = ((Date.now() - t0) / 1000).toFixed(1);
if (!res.ok) {
  console.error(`HTTP ${res.status} in ${dt}s`);
  console.error((await res.text()).slice(0, 300));
  process.exit(1);
}
const data = await res.json();
const msg = data.choices?.[0]?.message || {};
const content = (msg.content || "").trim();
console.log(`OK model=${data.model || model} http=${res.status} ${dt}s`);
console.log(`reasoning=${!!msg.reasoning_content} content="${content.slice(0, 60)}"`);
console.log(`usage=${JSON.stringify(data.usage || {})}`);
