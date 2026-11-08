/* P3.1 验收清理：恢复插件 data.json（serverBase 置空回默认/账号清空）、删队列文件、探针自删 */
import fs from "node:fs";

const V = "C:/Users/haozhe/Documents/Obsidian Vault/.obsidian/plugins/vault-home/data.json";
const Q = "C:/Users/haozhe/Documents/Obsidian Vault/_home/mentora-sync-queue.json";

const j = JSON.parse(fs.readFileSync(V, "utf8"));
j.mentora.serverBase = "";
j.mentora.account = null;
fs.writeFileSync(V, JSON.stringify(j, null, 2));
console.log("data.json 已恢复：serverBase=空(默认腾讯云), account=null");

if (fs.existsSync(Q)) { fs.rmSync(Q); console.log("队列文件已删"); } else console.log("队列文件不存在");

try {
  const r = await fetch("http://192.144.181.171/api/auth/account", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "m3probe@163.com", password: "M3#probe2027" }),
  });
  console.log("探针自删:", r.status);
} catch (e) { console.log("探针自删失败:", e.message); }
