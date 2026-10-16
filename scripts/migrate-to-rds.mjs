#!/usr/bin/env node
/* ============================================================
 * 一次性迁移：GitHub DB 仓 → 华为云 RDS（T-051，HW-T-04/S-04/05）
 *
 * 用法（凭据仅经环境变量/.env.local，脚本无任何密钥占位）：
 *   GITHUB_DB_REPO=<owner/repo> GITHUB_DB_TOKEN=<pat> \
 *   DATABASE_URL=<rds-url> AUTH_SECRET=<same-as-prod> \
 *     node scripts/migrate-to-rds.mjs
 *
 * 设计（对齐 migrate-github-db-to-d1.mjs / migrate-to-redis.mjs 惯例）：
 *  1) 前置校验：源抽样密文用当前 AUTH_SECRET 可解（密钥体系一致才继续）；
 *  2) 经 GitHub 四原语读 users/ data/ versions/ → 密文透传 UPSERT 到 kv 表
 *     （不解析不改写；AUTH_SECRET 不变时线上加解密完全兼容）；
 *  3) 对账：逐目录键数量比对 + 随机抽样（默认 5 条）逐字节比对 + 解密结构校验；
 *  4) 任何校验失败 → 非 0 退出。脚本不改任何通道配置：主通道保持旧通道，
 *     切换由部署环境 DB_CHANNEL=huawei 独立执行（HW-S-05 失败不切主通道）；
 *  5) 幂等：UPSERT 语义，重跑覆盖同 key 相同内容，不重复写入；
 *  6) 只读源：不删除/不改写 GitHub 上任何数据（回退通道保留）。
 *
 * 已知边界：GitHub Contents API 单目录列表上限 1000 条，存量规模（个人产品）
 * 远低于此；超过时请分批或改用 git clone 方式读取。
 * ============================================================ */

import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import zlib from "node:zlib";
import pg from "pg";

/* ---- 简易加载 .env.local（不覆盖已有环境变量） ---- */
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* 没有 .env.local 就全靠命令行环境变量 */ }

const REPO = process.env.GITHUB_DB_REPO || "";
const GH_TOKEN = process.env.GITHUB_DB_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const AUTH_SECRET = process.env.AUTH_SECRET || "";
const SAMPLE_N = Number(process.env.MIGRATE_SAMPLE_N || 5);

for (const [k, v] of Object.entries({
  GITHUB_DB_REPO: REPO, GITHUB_DB_TOKEN: GH_TOKEN,
  DATABASE_URL: DATABASE_URL, AUTH_SECRET: AUTH_SECRET,
})) {
  if (!v) { console.error(`缺少环境变量: ${k}`); process.exit(1); }
}
if (!AUTH_SECRET || AUTH_SECRET === "change-me-32bytes-random") {
  console.error("AUTH_SECRET 未配置或为占位值：迁移校验需要与生产一致的密钥");
  process.exit(1);
}

const DIRS = ["users", "data", "versions"];

/* ---- GitHub 四原语（只读） ---- */
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

/* ---- 解密结构校验（与 db.ts encrypt/decrypt 同构，只读不改写） ---- */
function tryDecrypt(payload) {
  const gzipped = payload.startsWith("GZ1.");
  const body = gzipped ? payload.slice(4) : payload;
  const raw = Buffer.from(body, "base64");
  const key = crypto.scryptSync(AUTH_SECRET, "mentora-db-v1", 32);
  const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  const plain = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
  const json = gzipped ? zlib.gunzipSync(plain) : plain;
  return JSON.parse(json.toString("utf8"));
}

/* ---- 主流程 ---- */
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  console.log("== 前置校验：源/目标密钥体系一致性 ==");
  {
    const sample = await ghGet("versions/.gitkeep").catch(() => null) ?? await ghList("users");
    const probePath = Array.isArray(sample) && sample.length > 0
      ? `users/${sample.find((f) => f.name.endsWith(".json"))?.name ?? sample[0].name}`
      : null;
    if (probePath) {
      const payload = await ghGet(probePath);
      try { tryDecrypt(payload); console.log(`抽样 ${probePath} 用当前 AUTH_SECRET 解密成功：密钥体系一致`); }
      catch { console.error(`抽样 ${probePath} 解密失败：AUTH_SECRET 与源数据不一致，中止（密文透传后应用将无法解密）`); process.exit(1); }
    } else {
      console.log("源无可抽样数据（空库），跳过密钥预检");
    }
  }

  console.log("\n== 读取源目录并 UPSERT（密文透传）==");
  /** @type {Record<string, string[]>} 源键清单 */
  const sourceKeys = {};
  let migrated = 0;
  for (const dir of DIRS) {
    const files = (await ghList(dir)).filter((f) => f.type === "file");
    sourceKeys[dir] = files.map((f) => `${dir}/${f.name}`);
    for (const f of files) {
      const key = `${dir}/${f.name}`;
      const content = await ghGet(key);
      if (content == null) continue;
      await client.query(
        "INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
        [key, content]
      );
      migrated++;
    }
    console.log(`  ${dir}/: ${files.length} 个键`);
  }
  console.log(`共 UPSERT ${migrated} 条（幂等，重跑覆盖同 key）`);

  console.log("\n== 对账校验 ==");
  let failures = 0;
  for (const dir of DIRS) {
    const r = await client.query("SELECT k FROM kv WHERE k LIKE $1", [`${dir}/%`]);
    const targetKeys = r.rows.map((x) => x.k).sort();
    const src = [...sourceKeys[dir]].sort();
    const ok = targetKeys.length === src.length && targetKeys.every((k, i) => k === src[i]);
    console.log(`  ${dir}/: 源 ${src.length} / 目标 ${targetKeys.length} ${ok ? "一致" : "不一致 ✗"}`);
    if (!ok) {
      failures++;
      const missing = src.filter((k) => !targetKeys.includes(k));
      const extra = targetKeys.filter((k) => !src.includes(k));
      if (missing.length) console.error(`    目标缺失: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}`);
      if (extra.length) console.error(`    目标多余: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? " ..." : ""}`);
    }
  }

  console.log(`\n== 随机抽样校验（逐字节 + 解密结构，n=${SAMPLE_N}）==`);
  const allKeys = DIRS.flatMap((d) => sourceKeys[d]);
  const picks = [...allKeys].sort(() => Math.random() - 0.5).slice(0, Math.min(SAMPLE_N, allKeys.length));
  for (const key of picks) {
    const srcContent = await ghGet(key);
    const r = await client.query("SELECT v FROM kv WHERE k = $1", [key]);
    const dstContent = r.rows[0]?.v ?? null;
    if (srcContent !== dstContent) {
      console.error(`  ${key}: 逐字节不一致 ✗`);
      failures++;
      continue;
    }
    try { tryDecrypt(dstContent); console.log(`  ${key}: 一致且可解密 ✓`); }
    catch (e) { console.error(`  ${key}: 内容一致但解密失败（${e.message}）✗`); failures++; }
  }

  console.log("\n== 校验报告 ==");
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    source: REPO,
    counts: Object.fromEntries(DIRS.map((d) => [d, sourceKeys[d].length])),
    migrated,
    sampled: picks.length,
    failures,
  }, null, 2));

  if (failures > 0) {
    console.error(`校验失败 ${failures} 项：主通道保持旧通道不变（切换须在校验全绿后另行执行 DB_CHANNEL=huawei）`);
    process.exit(1);
  }
  console.log("迁移校验全部通过。主通道切换属独立步骤：部署环境设 DB_CHANNEL=huawei（env 变更，无代码变更）。");
  console.log("源通道数据保留未删（回退场地保持）。");
} finally {
  await client.end();
}