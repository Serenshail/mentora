#!/usr/bin/env node
/* 清理一次性验收账号（T-ICT-041 遗留）
 * 用法：node scripts/ict-cleanup-account.mjs --email ict-demo-xxx@163.com [--base http://localhost:3100]
 * 仅用于本验收脚本创建的 ict-demo-* 账号；密码按命名规则推导，不写入证据。
 */
import fs from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg("--base", "http://localhost:3100");
const email = arg("--email", "");
const stamp = /^ict-demo-(.+)@163\.com$/.exec(email)?.[1];
if (!stamp) {
  console.error("只支持清理 ict-demo-<stamp>@163.com 一次性账号");
  process.exit(1);
}
const password = `ict-demo-pw-${stamp}`;

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const cookie = /mentora_session=([^;]+)/.exec(login.headers.get("set-cookie") || "")?.[1];
if (!login.ok || !cookie) {
  console.log(`login ${login.status}（账号可能已不存在）`);
  process.exit(login.status === 401 ? 0 : 1);
}
const del = await fetch(`${BASE}/api/auth/account`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json", Cookie: `mentora_session=${cookie}` },
  body: JSON.stringify({ password }),
});
const body = await del.text();
console.log(`cleanup ${del.status} ${body.slice(0, 200)}`);
process.exit(del.ok ? 0 : 1);