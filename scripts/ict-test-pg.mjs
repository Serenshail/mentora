#!/usr/bin/env node
/* ============================================================
 * T-ICT-002 临时 PostgreSQL 验证基座（本地等价环境，非华为云 RDS）
 *
 * 子命令：start | stop | status | schema | url
 * 镜像：默认 pgvector/pgvector:pg16（本机已有，含 PostgreSQL 16），
 *       可用环境变量 ICT_PG_IMAGE 覆盖；一律 --pull=never，绝不联网拉取。
 * 端口：127.0.0.1:55432（仅本机回环）
 * 凭据：每次 start 生成随机密码，写入系统临时目录；不写仓库、不写证据、不进日志。
 *
 * 退出码：0 成功 / 1 失败 / 3 不可用（BLOCKED）
 * ============================================================ */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IMAGE = process.env.ICT_PG_IMAGE || "pgvector/pgvector:pg16";
const NAME = process.env.ICT_PG_NAME || "ict-pg-verify";
const PORT = Number(process.env.ICT_PG_PORT || 55432);
const DB = "postgres";
const USER = "postgres";
const STATE_FILE = path.join(os.tmpdir(), `mentora-${NAME}.json`);
const EVIDENCE_FILE = path.join("docs", "evidence", "ict-track1-2026-11-20", "pg-local", "T-ICT-002-container-pgvector.json");

const OUT = (m) => process.stdout.write(`${m}\n`);
const ERR = (m) => process.stderr.write(`${m}\n`);

function docker(args, opts = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 180000, ...opts });
  return { status: r.status ?? -1, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), error: r.error };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    /* absent */
  }
}

function connectionUrl(password) {
  return `postgresql://${USER}:${encodeURIComponent(password)}@127.0.0.1:${PORT}/${DB}`;
}

function readEvidence() {
  try {
    return JSON.parse(fs.readFileSync(EVIDENCE_FILE, "utf8"));
  } catch {
    return {
      task: "T-ICT-002",
      title: "临时 PostgreSQL 验证基座（本地等价）",
      environment: "local-equivalent",
      notEqualTo: "huawei-cloud-rds",
      originalAttemptsRetainedIn: "pg-local/T-ICT-002-container.json",
      image: IMAGE,
      container: NAME,
      port: PORT,
      steps: {},
    };
  }
}

function saveEvidence(mutator) {
  const e = readEvidence();
  mutator(e);
  e.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(e, null, 2));
}

function isRunning() {
  const r = docker(["inspect", "-f", "{{.State.Running}}", NAME]);
  return { running: r.status === 0 && r.stdout === "true", status: r.status };
}

function cmdStart() {
  const rm = docker(["rm", "-f", NAME]);
  const password = crypto.randomBytes(18).toString("hex");
  const args = [
    "run", "-d", "--pull=never", "--name", NAME,
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", `POSTGRES_DB=${DB}`,
    "-p", `127.0.0.1:${PORT}:5432`,
    IMAGE,
  ];
  const run = docker(args);
  if (run.status !== 0) {
    ERR(`BLOCKED: 容器启动失败 ${run.stderr.slice(0, 200)}`);
    saveEvidence((e) => {
      e.steps.start = { status: "BLOCKED", exitCode: 3, error: run.stderr.slice(0, 400), at: new Date().toISOString() };
    });
    process.exit(3);
  }
  const startedAt = Date.now();
  let readyMs = null;
  for (let i = 0; i < 60; i++) {
    const ping = docker(["exec", NAME, "pg_isready", "-U", USER, "-d", DB]);
    if (ping.status === 0) {
      readyMs = Date.now() - startedAt;
      break;
    }
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
  }
  if (readyMs === null) {
    const logs = docker(["logs", "--tail", "50", NAME]);
    ERR("BLOCKED: postgres container not ready");
    saveEvidence((e) => {
      e.steps.start = { status: "BLOCKED", exitCode: 3, error: "not ready in 60s", dockerLogTail: logs.stdout.slice(-1500) };
    });
    process.exit(3);
  }
  const inspect = docker(["inspect", "-f", "{{.Id}}|{{.Image}}", NAME]);
  const [containerId = "", imageRef = ""] = inspect.stdout.split("|");
  writeState({ password, port: PORT, image: IMAGE, containerId, startedAt: new Date().toISOString(), readyMs });
  saveEvidence((e) => {
    e.image = IMAGE;
    e.imageId = imageRef.replace(/^sha256:/, "").slice(0, 12);
    e.containerId = containerId.replace(/^sha256:/, "").slice(0, 12);
    e.readyMs = readyMs;
    e.steps.start = { status: "PASS", exitCode: 0, at: new Date().toISOString(), priorContainerRemoved: rm.status === 0 };
  });
  OUT(`PASS: ${NAME} 就绪（${readyMs}ms，镜像 ${IMAGE}）`);
  process.exit(0);
}

function cmdSchema() {
  const s = readState();
  if (!s) {
    ERR("BLOCKED: 未找到运行中容器状态，请先执行 start");
    process.exit(3);
  }
  const url = connectionUrl(s.password);
  const init = spawnSync(process.execPath, ["scripts/init-rds-schema.mjs"], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, DATABASE_URL: url },
  });
  if (init.status !== 0) {
    ERR(`FAIL: schema 初始化失败 ${(init.stderr || init.stdout).slice(0, 300)}`);
    saveEvidence((e) => {
      e.steps.schema = { status: "FAIL", exitCode: 1, error: (init.stderr || init.stdout).slice(0, 400) };
    });
    process.exit(1);
  }
  const check = spawnSync(
    process.execPath,
    [
      "-e",
      "const pg=require('pg');(async()=>{const c=new pg.Client({connectionString:process.env.U});await c.connect();const t=await c.query(\"SELECT to_regclass('public.kv') AS t\");const n=await c.query('SELECT COUNT(*)::int AS n FROM kv');console.log(JSON.stringify({kv:t.rows[0].t,rows:n.rows[0].n}));await c.end();})().catch(e=>{console.error(e.message);process.exit(1)});",
    ],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, U: url } }
  );
  if (check.status !== 0) {
    ERR(`FAIL: kv 校验失败 ${check.stderr.slice(0, 200)}`);
    saveEvidence((e) => {
      e.steps.schema = { status: "FAIL", exitCode: 1, error: check.stderr.slice(0, 400) };
    });
    process.exit(1);
  }
  const parsed = JSON.parse(check.stdout.trim().split("\n").pop());
  if (!parsed.kv) {
    ERR("FAIL: kv 表不存在");
    saveEvidence((e) => {
      e.steps.schema = { status: "FAIL", exitCode: 1, error: "kv table missing" };
    });
    process.exit(1);
  }
  saveEvidence((e) => {
    e.steps.schema = { status: "PASS", exitCode: 0, kvTable: parsed.kv, kvRows: parsed.rows, at: new Date().toISOString() };
  });
  OUT(`PASS: schema 就绪（kv=${parsed.kv}，行数 ${parsed.rows}）`);
  process.exit(0);
}

function cmdUrl() {
  const s = readState();
  if (!s) {
    ERR("BLOCKED: 无运行中容器");
    process.exit(3);
  }
  process.stdout.write(connectionUrl(s.password));
  process.exit(0);
}

function cmdStatus() {
  const { running } = isRunning();
  OUT(running ? "running" : "absent");
  process.exit(running ? 0 : 3);
}

function cmdStop() {
  const rm = docker(["rm", "-f", NAME]);
  clearState();
  const after = isRunning();
  saveEvidence((e) => {
    e.steps.cleanup = {
      status: after.running ? "FAIL" : "PASS",
      exitCode: after.running ? 1 : 0,
      containerRemoved: !after.running,
      rmExitCode: rm.status,
      at: new Date().toISOString(),
    };
  });
  if (after.running) {
    ERR("FAIL: 容器未移除");
    process.exit(1);
  }
  OUT("PASS: 容器与临时凭据已清理");
  process.exit(0);
}

const cmd = process.argv[2];
switch (cmd) {
  case "start":
    cmdStart();
    break;
  case "schema":
    cmdSchema();
    break;
  case "url":
    cmdUrl();
    break;
  case "status":
    cmdStatus();
    break;
  case "stop":
    cmdStop();
    break;
  default:
    ERR("用法: node scripts/ict-test-pg.mjs <start|stop|status|schema|url>");
    process.exit(1);
}