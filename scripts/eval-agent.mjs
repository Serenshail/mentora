#!/usr/bin/env node
/* ============================================================
 * 回答质量评测跑批器（阶段一：基线）
 *
 * 用法：
 *   node scripts/eval-agent.mjs                      # 打本地 dev server（默认 3000）
 *   BASE=http://... node scripts/eval-agent.mjs      # 打指定环境
 *   CASES=ds01,ds03 node scripts/eval-agent.mjs      # 只跑指定案例
 *
 * 纪律（用户裁定，写入 docs/AUDIT-PRD-2026-11-06.md 第四节）：
 *   任何 prompt/模型/上下文改动，必须附：测试案例、修改原因、前后对比、评估数据。
 *   本脚本产出归档 docs/evidence/eval-agent-<date>-<sha>.json，改前存 A、改后存 B，B<A 不许合入。
 *
 * 结构断言对齐 AGENT_CHAT 深讲协议九步（见 fixtures 的 must 字段）。
 * 教学效果的人工盲评（ChatGPT 对比）协议见 docs/QUALITY-BASELINE-*.md。
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:3000";
const ROOT = path.resolve(process.cwd());
const FIXTURES = process.env.FIXTURES || "scripts/eval-agent.fixtures.json";
const fixtures = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURES), "utf8"));
const MARKER_RE = Object.fromEntries(
  Object.entries(fixtures.markers ?? {}).map(([k, v]) => [k, v instanceof RegExp ? v : new RegExp(v)])
);
const only = (process.env.CASES || "").split(",").map((s) => s.trim()).filter(Boolean);
const cases = fixtures.cases.filter((c) => (only.length ? only.includes(c.id) : true));

/* 登录：EVAL_FRESH=1 时用管理员密码现场开激活码注册全新账号（独享当日配额）；
 * 否则用遗留探针账号。返回 { cookie, email, password, fresh }（fresh 用于跑完自删）。 */
async function login() {
  if (process.env.EVAL_FRESH === "1") {
    const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
    const adminPw = /^ADMIN_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() || "";
    if (!adminPw) throw new Error("EVAL_FRESH=1 但 .env.local 缺 ADMIN_PASSWORD");
    const email = `eval-${Date.now().toString(36)}@163.com`;
    const password = "Ev#al" + Math.random().toString(36).slice(2, 8);
    const gen = await (await fetch(`${BASE}/api/admin/licenses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-password": adminPw },
      body: JSON.stringify({ count: 1, days: 30 }),
    })).json();
    const code = gen.codes?.[0];
    if (!code) throw new Error(`生成激活码失败: ${JSON.stringify(gen).slice(0, 120)}`);
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: "评测跑批", inviteCode: code }),
    });
    const tok = /mentora_session=([^;]+)/.exec(reg.headers.get("set-cookie") || "")?.[1];
    if (!tok) throw new Error(`激活码注册失败 ${reg.status}: ${(await reg.text()).slice(0, 120)}`);
    return { cookie: tok, email, password, fresh: true };
  }
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: process.env.PROBE_EMAIL || "probe-x2@163.com", password: process.env.PROBE_PASSWORD || "Pr#obe123" }),
  });
  const tok = /mentora_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  if (!tok) throw new Error(`login failed ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return { cookie: tok, email: "", password: "", fresh: false };
}

const CJK = /[\u4e00-\u9fff]/;
/* 深讲协议九步的结构断言（对齐 prompts.ts 深讲协议 + 用户理想样例） */
const MARKERS = {
  "deep.position": /知识点|涉及|考察|我会按|讲解顺序|定位/,
  "deep.goal": /假设|例如|比如说|输入|预期|目标是/,
  "deep.block": /是什么|为什么需要|不写会怎样|逐行|逐块|这一行|这段代码|这个成员/,
  "deep.trace": /模拟|逐步|第一次循环|代入|状态|过程表|\s\|\s/,
  "deep.flaws": /问题|边界|泄漏|注意|坑|误解|错误|隐患/,
  "deep.fix": /改进|修复|正确做法|修正|建议改/,
  "deep.compare": /对比|两种|相比|区别|更|第一种|第二种/,
  "deep.complexity": /O\(|复杂度|代价/,
  "deep.extract": /需要掌握|真正.{0,6}掌握|核心|最核心|知识点/,
  "deep.quiz": /小测|自测|测试|练一|检验|试着回答|先自己想/,
  /* 直答案例 */
  "direct.answer": (t) => CJK.test(t) && t.length > 120,
  /* 通用 */
  "clean.noMeta": (t) =>
    !/确认卡|先调用|调用工具|批准后|等待用户|report the|call the tool|give final answer|confirm briefly/i.test(t) &&
    CJK.test(t),
  "direct.noWorkflow": (t) => !/学习目标|开始引导|学习计划已|确认，生成总纲要/.test(t),
  "intent.recognize": /数据结构|顺序表|学习|目标|继续|进度|计划/,
};

/* 意图四路的函数型标记（JSON 里放不了函数） */
const FN_MARKERS = {
  "direct.noHandoff": (t) =>
    !/帮你.{0,16}(建|创建|立|拆|安排|加入)|目标.{0,8}(创建|立起来|建好)|加入书架|创建会话/.test(t),
  "intent.noDump": (t) => {
    const qMarks = (t.match(/？/g) || []).length;
    const numberedQ = /(?:^|\n)\s*[1-9][.、][^\n]{0,40}？/.test(t);
    return !(qMarks >= 3 && numberedQ);
  },
  "intent.engaged": (t) => /学|线性代数|安排|计划|目标|例子|讲/.test(t),
  "route.noRecreate": (t) => !/重新立|新建一个.{0,8}目标|重新创建/.test(t),
};

function structuralChecks(text, must) {
  const results = {};
  for (const key of must) {
    const m = MARKER_RE[key] ?? FN_MARKERS[key] ?? MARKERS[key];
    if (!m) { results[key] = { pass: false, reason: "unknown marker" }; continue; }
    const pass = typeof m === "function" ? Boolean(m(text)) : m.test(text);
    results[key] = { pass };
  }
  return results;
}

const CASE_TIMEOUT_MS = 420_000;

async function askOnce(cookie, c, signal) {
  const ctx = JSON.stringify({
    today: new Date().toISOString().slice(0, 10),
    activeGoal: fixtures.userBackground.activeGoal,
    knowledgeCount: 12,
    dueReviews: 2,
    books: 1,
    userName: fixtures.userBackground.userName,
    profile: fixtures.userBackground.profile,
    learningStyle: fixtures.userBackground.learningStyle,
  });
  const started = Date.now();
  let text = "";
  let err = "";
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `mentora_session=${cookie}` },
      body: JSON.stringify({
        task: "agent",
        args: { ctx, deep: c.type !== "direct", noTools: c.tools === false },
        messages: [{ role: "user", content: c.question }],
        temperature: 0.5,
        signal,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.t === "d") text += ev.v;
          else if (ev.t === "e") err = ev.v || "model error";
        } catch { /* 半行 */ }
      }
    }
  } catch (e) {
    err = e.message;
  }
  /* noTools 下模型偶尔仍吐 tool/plan 围栏（习惯残留），剥掉再判 */
  const cleaned = text
    .replace(/```(?:tool|plan)[\s\S]*?```/g, "")
    .replace(/```(?:tool|plan)[\s\S]*$/g, "")
    .trim();
  return { text: cleaned, err, ms: Date.now() - started };
}

async function askCase(cookie, c) {
  /* 每案例硬超时（模型网关可能流卡死无字节，实测挂过 2.5h）；失败/空回答自动重试一次 */
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CASE_TIMEOUT_MS);
    try {
      const r = await askOnce(cookie, c, ac.signal);
      /* deep 案例 <400 字视为坏样本（流被掐断的残片），direct 案例 >100 字即可 */
      const minLen = c.type === "direct" ? 100 : 400;
      /* 模型自身内部工具协议泄漏（如 qwen 的 <tool_call><function=code_execution>）= 截断坏样本 */
      const leaked = /<tool_call>|<function=|<\/invoke/i.test(r.text);
      if (!r.err && !leaked && r.text.length >= minLen) return { ...r, attempt };
      if (attempt === 1) console.log(`  (attempt ${attempt} 失败：${(r.err || (leaked ? "内部工具泄漏" : `len=${r.text.length}`)).slice(0, 50)}，重试一次)`);
      if (attempt === 2) return { ...r, attempt };
    } catch (e) {
      if (attempt === 2) return { text: "", err: e.message, ms: 0, attempt };
      console.log(`  (attempt ${attempt} 异常：${e.message.slice(0, 50)}，重试一次)`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { text: "", err: "unreachable", ms: 0, attempt: 2 };
}

const sha = (() => {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); }
  catch { return "unknown"; }
})();

const session = await login();
const cookie = session.cookie;
console.log(`eval-agent 基线跑批：${cases.length} 个案例 @ ${BASE}（promptVersion=${sha}）`);
const results = [];
for (const c of cases) {
  process.stdout.write(`- ${c.id} ... `);
  const { text, err, ms } = await askCase(cookie, c);
  const checks = err ? {} : structuralChecks(text, c.must);
  const passCount = Object.values(checks).filter((x) => x.pass).length;
  const ok = !err && passCount === c.must.length;
  console.log(ok ? "PASS" : `FAIL(${passCount}/${c.must.length})`, err ? `err=${err.slice(0, 60)}` : "", `${(ms / 1000).toFixed(1)}s`);
  results.push({
    id: c.id, type: c.type, ok, err: err || undefined, ms,
    checks, focus: c.focus, golden: c.golden,
    output: text,
  });
}

const passCount = results.filter((r) => r.ok).length;
const archive = {
  promptVersion: sha,
  task: "agent",
  scenario: fixtures.scenario,
  base: BASE,
  date: new Date().toISOString(),
  modelHint: "服务端配置模型（见 /api/health）",
  summary: { total: results.length, pass: passCount, fail: results.length - passCount },
  results,
};
const outDir = path.join(ROOT, "docs/evidence");
fs.mkdirSync(outDir, { recursive: true });
const evalName = path.basename(FIXTURES).replace(/.fixtures.json$/, "");
const outFile = path.join(outDir, `${evalName}-${new Date().toISOString().slice(0, 10)}-${sha}.json`);
/* 同版本增跑：按 case id 合并进已有归档（单案例复跑不覆盖整份） */
if (fs.existsSync(outFile)) {
  const prev = JSON.parse(fs.readFileSync(outFile, "utf8"));
  const byId = new Map(prev.results.map((r) => [r.id, r]));
  for (const r of results) byId.set(r.id, r);
  const merged = [...byId.values()];
  archive.results = merged;
  archive.summary = {
    total: merged.length,
    pass: merged.filter((r) => r.ok).length,
    fail: merged.filter((r) => !r.ok).length,
  };
  archive.mergedRuns = [...new Set([...(prev.mergedRuns ?? [prev.date]), archive.date])];
}
fs.writeFileSync(outFile, JSON.stringify(archive, null, 1));
console.log(`\n归档：${outFile}`);
console.log(`结果：${passCount}/${results.length} PASS`);
const failing = results.filter((r) => !r.ok).map((r) => {
  const bad = Object.entries(r.checks).filter(([, v]) => !v.pass).map(([k]) => k);
  return `${r.id}[缺:${bad.join(",")}]`;
});
if (failing.length) console.log(`未过：${failing.join(" ")}`);
if (session.fresh) {
  await fetch(`${BASE}/api/auth/account`, { method: "DELETE", headers: { "Content-Type": "application/json", cookie: `mentora_session=${session.cookie}` }, body: JSON.stringify({ password: session.password }) }).catch(() => {});
  console.log("新鲜探针已自删");
}
process.exit(results.some((r) => r.err) ? 2 : 0);
