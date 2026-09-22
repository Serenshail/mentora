#!/usr/bin/env node
/**
 * 一次性迁移：GitHub 数据库仓库（haow9508-ctrl/mentora-db）→ Cloudflare D1
 *
 * 用法（在 mentora 目录下）：
 *   node scripts/migrate-github-db-to-d1.mjs
 *
 * 需要的环境变量（.env.local 或命令行）：
 *   GITHUB_DB_REPO            例 haow9508-ctrl/mentora-db
 *   GITHUB_DB_TOKEN           GitHub PAT（需 repo 读权限）
 *   CLOUDFLARE_ACCOUNT_ID     Cloudflare 账户 ID（dashboard 右侧）
 *   CLOUDFLARE_D1_DATABASE_ID D1 数据库 ID
 *   CLOUDFLARE_D1_API_TOKEN   Cloudflare API Token（需 D1 Edit 权限）
 *
 * 说明：
 * - GitHub 上的文件内容（JSON 或 AES-GCM 密文）原样拷贝进 D1 的 kv 表，
 *   不解密不重组——AUTH_SECRET 不变时，线上加解密逻辑完全兼容。
 * - 幂等：重复跑只是覆盖同 key 的相同内容。
 * - 只读 GitHub、只写 D1，不会删除 GitHub 上的任何东西（回退通道保留）。
 */

import { readFileSync } from "node:fs";

/* ---- 简易加载 .env.local（不覆盖已有环境变量） ---- */
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* 没有 .env.local 就全靠命令行环境变量 */ }

const REPO = process.env.GITHUB_DB_REPO || "";
const GH_TOKEN = process.env.GITHUB_DB_TOKEN || "";
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_DB_ID = process.env.CLOUDFLARE_D1_DATABASE_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_D1_API_TOKEN || "";

for (const [k, v] of Object.entries({ GITHUB_DB_REPO: REPO, GITHUB_DB_TOKEN: GH_TOKEN, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, CLOUDFLARE_D1_DATABASE_ID: CF_DB_ID, CLOUDFLARE_D1_API_TOKEN: CF_TOKEN })) {
  if (!v) { console.error(`缺少环境变量: ${k}`); process.exit(1); }
}

/* ---- GitHub Contents API ---- */
async function ghList(dir) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${dir}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "mentora-migrate" },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub 列目录失败 ${dir}: ${res.status}`);
  return res.json();
}

async function ghGet(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "mentora-migrate" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 读取失败 ${path}: ${res.status}`);
  const j = await res.json();
  return Buffer.from(j.content ?? "", "base64").toString("utf8");
}

/* ---- D1 HTTP API ---- */
async function d1(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${CF_DB_ID}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.success) {
    throw new Error(`D1 执行失败: ${res.status} ${JSON.stringify(j?.errors ?? j)?.slice(0, 300)}`);
  }
  return j.result?.[0]?.results ?? [];
}

async function migrateDir(dir) {
  const files = await ghList(dir);
  const jsonFiles = files.filter((f) => f.type === "file" && f.name.endsWith(".json"));
  let ok = 0, fail = 0;
  for (const f of jsonFiles) {
    const path = `${dir}/${f.name}`;
    try {
      const content = await ghGet(path);
      if (content == null) continue;
      await d1("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [path, content]);
      ok++;
      console.log(`  ✓ ${path} (${(f.size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      fail++;
      console.error(`  ✗ ${path}: ${e.message}`);
    }
  }
  return { total: jsonFiles.length, ok, fail };
}

console.log(`迁移 ${REPO} → D1(${CF_DB_ID})\n`);
await d1("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)", []);
console.log("kv 表已就绪\n");

for (const dir of ["users", "data"]) {
  console.log(`[${dir}]`);
  const r = await migrateDir(dir);
  console.log(`  小计: ${r.ok}/${r.total} 成功, ${r.fail} 失败\n`);
}

const [{ n: kvCount } = { n: 0 }] = await d1("SELECT COUNT(*) AS n FROM kv");
const [{ n: userCount } = { n: 0 }] = await d1("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'users/%'");
const [{ n: dataCount } = { n: 0 }] = await d1("SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'data/%'");
console.log(`D1 校验: kv 总数=${kvCount}, users=${userCount}, data=${dataCount}`);
console.log("完成。下一步：把三个 CLOUDFLARE_* 变量配到 Vercel 生产环境并重新部署。");
