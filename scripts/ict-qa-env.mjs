#!/usr/bin/env node
/* 本地隔离 QA 环境（P0 复测专用）
 * - PostgreSQL 16（pgvector 镜像）+ Valkey 8，独立端口 55433/55434
 * - 随机密码与独立 AUTH_SECRET，只写 .env.qa（.gitignore 已覆盖 .env*）
 * - 不读取、不写入生产 D1 / 生产库
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const PG_PORT = 55433;
const REDIS_PORT = 55434;
const PG_NAME = "ict-qa-pg";
const REDIS_NAME = "ict-qa-redis";

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 180000, ...opts });

function readLocal() {
  const s = fs.readFileSync(".env.local", "utf8");
  return Object.fromEntries(
    s.split(/\r?\n/).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    })
  );
}

const local = readLocal();
const pgPassword = crypto.randomBytes(18).toString("hex");
const authSecret = crypto.randomBytes(32).toString("hex");

sh("docker", ["rm", "-f", PG_NAME]);
sh("docker", ["rm", "-f", REDIS_NAME]);

let r = sh("docker", ["run", "-d", "--pull=never", "--name", PG_NAME, "-e", `POSTGRES_PASSWORD=${pgPassword}`, "-p", `127.0.0.1:${PG_PORT}:5432`, "pgvector/pgvector:pg16"]);
if (r.status !== 0) {
  console.error("PG 启动失败:", r.stderr.slice(0, 200));
  process.exit(3);
}
r = sh("docker", ["run", "-d", "--pull=never", "--name", REDIS_NAME, "-p", `127.0.0.1:${REDIS_PORT}:6379`, "valkey/valkey:8.1.6-alpine"]);
if (r.status !== 0) {
  console.error("Redis 启动失败:", r.stderr.slice(0, 200));
  process.exit(3);
}

let ready = false;
for (let i = 0; i < 60; i++) {
  if (sh("docker", ["exec", PG_NAME, "pg_isready", "-U", "postgres"]).status === 0) {
    ready = true;
    break;
  }
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
}
if (!ready) {
  console.error("PG 未就绪");
  process.exit(3);
}

const dbUrl = `postgresql://postgres:${encodeURIComponent(pgPassword)}@127.0.0.1:${PG_PORT}/postgres`;
/* pg_isready 在 initdb 的临时实例阶段也会返回成功，必须等到能真正执行查询 */
let pingOk = false;
for (let i = 0; i < 30; i++) {
  const ping = sh(process.execPath, [
    "-e",
    "const pg=require('pg');(async()=>{const c=new pg.Client({connectionString:process.env.U});await c.connect();await c.query('SELECT 1');await c.end();})().catch(()=>process.exit(1));",
  ], { env: { ...process.env, U: dbUrl }, timeout: 30000 });
  if (ping.status === 0) {
    pingOk = true;
    break;
  }
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
}
if (!pingOk) {
  console.error("PG 可连接性检查失败");
  process.exit(3);
}

const init = sh(process.execPath, ["scripts/init-rds-schema.mjs"], { env: { ...process.env, DATABASE_URL: dbUrl } });
if (init.status !== 0) {
  console.error("schema 失败:", (init.stderr || init.stdout).slice(0, 300));
  process.exit(1);
}

const env = {
  DB_CHANNEL: "huawei",
  DATABASE_URL: dbUrl,
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}/0`,
  AUTH_SECRET: authSecret,
  AI_PROVIDER: local.AI_PROVIDER || "custom",
  AI_BASE_URL: local.AI_BASE_URL || "",
  AI_MODEL: local.AI_MODEL || "",
  CUSTOM_API_KEY: local.CUSTOM_API_KEY || "",
  ADMIN_PASSWORD: local.ADMIN_PASSWORD || "",
  MENTORA_OPEN_TOKEN: local.MENTORA_OPEN_TOKEN || "",
  INVITE_CODE: local.INVITE_CODE || "",
};
fs.writeFileSync(
  ".env.qa",
  Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  { mode: 0o600 }
);

console.log(`PASS: QA env ready (pg:${PG_PORT}, redis:${REDIS_PORT}, ai:${env.AI_PROVIDER}, model:${env.AI_MODEL})`);