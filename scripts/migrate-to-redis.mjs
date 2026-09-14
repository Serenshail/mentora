/* 一次性迁移：GitHub DB → Upstash Redis
 * 用法：node scripts/migrate-to-redis.mjs
 * 前置：环境变量 GITHUB_DB_REPO/GITHUB_DB_TOKEN + UPSTASH_REDIS_REST_URL/TOKEN
 * 密文原样搬运（AUTH_SECRET 不变，加密层通用）。可重复执行（SET 幂等）。
 */
import "dotenv/config";

const REPO = process.env.GITHUB_DB_REPO;
const GT = process.env.GITHUB_DB_TOKEN;
const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const UT = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!REPO || !GT || !URL_ || !UT) {
  console.error("缺环境变量。需要：GITHUB_DB_REPO, GITHUB_DB_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}

async function gh(path, method, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method,
    headers: {
      Authorization: `token ${GT}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "mentora-migrate",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function upstash(command) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${UT}` },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${await res.text()}`);
  return res.json();
}

const DIRS = ["users", "sync"];
let total = 0;

for (const dir of DIRS) {
  const { status, json } = await gh(dir, "GET");
  if (status === 404) {
    console.log(`[skip] ${dir}/ 不存在`);
    continue;
  }
  if (status !== 200) {
    console.error(`[fail] 列 ${dir}/ 失败：${status}`);
    process.exit(1);
  }
  const files = json.filter((f) => f.name.endsWith(".json"));
  console.log(`[dir ] ${dir}/ 共 ${files.length} 个文件`);
  for (const f of files) {
    const r = await gh(`${dir}/${f.name}`, "GET");
    if (r.status !== 200) {
      console.error(`[fail] 读 ${dir}/${f.name}：${r.status}`);
      continue;
    }
    const raw = Buffer.from(r.json.content, "base64").toString("utf8");
    await upstash(["SET", `${dir}/${f.name}`, raw]);
    total += 1;
    console.log(`[ ok ] ${dir}/${f.name}（${raw.length} 字节）`);
  }
}

console.log(`\n完成：共迁移 ${total} 个文件。`);
