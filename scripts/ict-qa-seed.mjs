#!/usr/bin/env node
/* 隔离 QA：种一次性激活码 + 注册演示账号（本地 PostgreSQL，不触碰生产 D1） */
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import pg from "pg";

const BASE = process.env.QA_BASE || "http://localhost:3101";
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const parse = (file) =>
  Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      })
  );

const env = parse(".env.qa");
const code = Array.from({ length: 12 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
const hash = crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
const batchId = `qa-${Date.now().toString(36)}`;

function encrypt(obj) {
  const key = crypto.scryptSync(env.AUTH_SECRET, "mentora-db-v1", 32);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj), "utf8"), { level: 6 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  return "GZ1." + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

const license = {
  id: `${batchId}-1`,
  code,
  plan: "trial",
  days: 7,
  note: "P0 QA 一次性码",
  batchId,
  createdAt: new Date().toISOString(),
  createdBy: "qa-seed",
  expiresAt: null,
  status: "unused",
  usedBy: null,
};

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
await client.query("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
await client.query("INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v", [
  `licenses/${hash}.json`,
  encrypt(license),
]);

const stamp = Date.now().toString(36);
const email = `qa-demo-${stamp}@163.com`;
const password = `qa-demo-pw-${stamp}`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, name: "QA验收", inviteCode: code }),
});
const body = await reg.json().catch(() => null);
if (reg.status !== 200) {
  console.error(`注册失败 ${reg.status} ${JSON.stringify(body).slice(0, 200)}`);
  await client.end();
  process.exit(1);
}

fs.writeFileSync(".qa-account.json", JSON.stringify({ email, password, userId: body?.user?.userId ?? "" }, null, 2), { mode: 0o600 });
await client.end();
console.log(`PASS: seeded + registered (${email.replace(/qa-demo-[^.]+/, "qa-demo-***")})`);