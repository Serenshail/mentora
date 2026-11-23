#!/usr/bin/env node
/* ============================================================
 * T-ICT-033 参赛候选版本冻结清单（R01）
 *
 * 输入：git ls-files -co --exclude-standard（已跟踪 + 未跟踪、遵守 .gitignore）
 * 输出：manifest JSON（每文件 sha256、大小、排除原因、密钥扫描结果）
 * 原则：
 *  - 只生成清单，不复制依赖目录；仓库内容与清单一一对应即可重建
 *  - .env* / 日志 / 依赖 / 构建产物 / 大于 5MB 的文件一律排除并记录原因
 *  - 扫描到疑似密钥只记录「文件 + 规则名」，绝不输出密钥内容
 *
 * 用法：node scripts/freeze-ict-snapshot.mjs [--out <path>]
 * ============================================================ */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_OUT = path.join(ROOT, "docs", "evidence", "ict-track1-2026-11-20", "codearts", "snapshot-manifest.json");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 ? path.resolve(process.argv[outIdx + 1]) : DEFAULT_OUT;

const EXCLUDE_DIR_PREFIXES = [
  "node_modules/", ".next/", ".git/", "coverage/", "dist/", ".turbo/",
  ".codeartsdoer/cache/", "docs/evidence/logs/",
];
const EXCLUDE_FILE_PATTERNS = [
  /^\.env($|\.)/,
  /\.log$/i,
  /\.(png|jpg|jpeg|gif|webp|mp4|mov|zip|tar|gz|7z)$/i,
];
const SELF = path.relative(ROOT, OUT).replace(/\\/g, "/");
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SECRET_RULES = [
  { name: "openai-like-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "private-key-block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".env", ".sql", ".css", ".html", ".toml", ".txt", ".ps1", ".sh"]);

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const listed = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .map((p) => p.replace(/\\/g, "/"));

const entries = [];
const excluded = [];
const findings = [];
let includedBytes = 0;

for (const rel of listed) {
  const abs = path.join(ROOT, rel);
  const dirHit = EXCLUDE_DIR_PREFIXES.find((d) => rel.startsWith(d));
  if (dirHit) {
    excluded.push({ path: rel, reason: `dir:${dirHit.replace(/\/$/, "")}` });
    continue;
  }
  if (rel === SELF) {
    excluded.push({ path: rel, reason: "self:manifest" });
    continue;
  }
  const fileHit = EXCLUDE_FILE_PATTERNS.find((re) => re.test(rel));
  if (fileHit) {
    excluded.push({ path: rel, reason: `pattern:${fileHit}` });
    continue;
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    excluded.push({ path: rel, reason: "missing" });
    continue;
  }
  if (!stat.isFile()) {
    excluded.push({ path: rel, reason: "not-a-file" });
    continue;
  }
  if (stat.size > MAX_FILE_BYTES) {
    excluded.push({ path: rel, reason: `too-large:${stat.size}` });
    continue;
  }
  const buf = fs.readFileSync(abs);
  includedBytes += buf.length;
  entries.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });

  const ext = path.extname(rel).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    const text = buf.toString("utf8");
    for (const rule of SECRET_RULES) {
      if (rule.re.test(text)) findings.push({ path: rel, rule: rule.name });
    }
  }
}

const manifest = {
  task: "T-ICT-033",
  generatedAt: new Date().toISOString(),
  base: {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    branch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    statusEntryCount: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean).length,
  },
  summary: {
    listed: listed.length,
    included: entries.length,
    excluded: excluded.length,
    includedBytes,
    secretFindings: findings.length,
  },
  entries,
  excluded,
  secretFindings: findings,
  rebuild: [
    "git checkout <HEAD>",
    "按 manifest.entries 校验每个文件 sha256",
    "npm ci（依赖不入清单，按 package-lock.json 重建）",
    "npm run build -- --webpack",
  ],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));
process.stdout.write(
  `PASS: manifest ${path.relative(ROOT, OUT)} | 收录 ${entries.length} / 排除 ${excluded.length} | 疑点 ${findings.length} | ${(includedBytes / 1024 / 1024).toFixed(2)}MB\n`
);
if (findings.length > 0) {
  process.stderr.write(`WARN: 疑似密钥 ${findings.map((f) => `${f.path}(${f.rule})`).join(", ")}\n`);
  process.exit(2);
}