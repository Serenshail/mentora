#!/usr/bin/env node
/* ============================================================
 * RDS schema 初始化（T-050，HW-S-01）
 *
 * 在华为云 RDS PostgreSQL 上创建 Mentora 存储三表（与 src/lib/server/db.ts
 * 运行期 DDL 完全一致，语义等价 D1 现有表，见 design §2.3.2）：
 *   kv       — 密文 KV 真源（users/ data/ versions/ 及 rl/ code/ 等）
 *   feedback — 用户反馈
 *   events   — 漏斗埋点 / chat-usage 用量（/api/admin/stats 聚合源）
 * 全部 CREATE TABLE IF NOT EXISTS：幂等可重复执行，重复跑无副作用。
 *
 * 用法（凭据仅经环境变量，绝不入仓）：
 *   DATABASE_URL="postgresql://user:pass@rds-host:5432/mentora" \
 *     node scripts/init-rds-schema.mjs
 * ============================================================ */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("缺少 DATABASE_URL 环境变量（华为云 RDS PostgreSQL 连接串）");
  process.exit(1);
}

/* 与 db.ts 运行期 DDL 逐字一致（含 created_at 默认值的 to_char 格式），
 * 应用侧启动建表与本脚本幂等共存，先后执行均无冲突 */
const STATEMENTS = [
  ["kv", "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"],
  [
    "feedback",
    "CREATE TABLE IF NOT EXISTS feedback (number BIGINT PRIMARY KEY, type TEXT, content TEXT, contact TEXT, page TEXT, created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')))",
  ],
  [
    "events",
    "CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, name TEXT, account TEXT, path TEXT, props TEXT, created_at TEXT NOT NULL DEFAULT (to_char(now(), 'YYYY-MM-DD HH24:MI:SS')))",
  ],
];

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  for (const [table, ddl] of STATEMENTS) {
    await client.query(ddl);
    const r = await client.query("SELECT COUNT(*)::int AS n FROM " + table);
    console.log(`表 ${table}: 就绪（现有 ${r.rows[0].n} 行）`);
  }
  console.log("RDS schema 初始化完成（幂等，可重复执行）");
} finally {
  await client.end();
}