#!/usr/bin/env node
/* ============================================================
 * 验收判分质量 eval（quiz-grade 任务的回归评测集）
 *
 * 用途：判分是全产品使用频次最高的 AI 调用，prompt 或模型一改就可能悄悄变味。
 * 本脚本用固定夹具跑 /api/chat 的 quiz-grade 任务，把模型判分与人工标注期望对比，
 * 输出准确率；低于阈值退出码 1（可挂 CI）。
 *
 * 运行：
 *   1) npm run dev            # 本地起服务（本地无需登录态；线上有登录墙，勿对生产跑）
 *   2) npm run eval           # 默认打 http://localhost:3000
 *      EVAL_BASE_URL=http://localhost:3001 npm run eval
 *
 * 契约与 learn/[id]/page.tsx submitQuiz 完全一致：
 *   ctx = { day, knowledgePoints, lesson(≤8000), items:[{itemId,kind,question}], answers }
 * ============================================================ */

const BASE = process.env.EVAL_BASE_URL || "http://localhost:3000";
const PASS_RATE = 0.8;

const LESSON = `## 今日任务：提示词基础
## 知识点
- zero-shot：不给例子，直接下指令。适合任务边界清晰、模型见过的任务
- few-shot：给 2-3 个输入输出示例，让模型模仿格式
- 角色设定：一句"你是…"能显著稳定输出风格
- 输出约束：明确"只输出 JSON/不超过 100 字"比事后修剪省一半时间
## 示例
你是产品文案。任务：把功能点改写成朋友圈文案。要求：不超过 50 字，只输出文案本身。`;

const KP = ["zero-shot 与 few-shot 的区别", "角色设定与输出约束"];

const ITEMS = [
  { itemId: "a1", kind: "explain", question: "用自己的话说清：什么是 zero-shot / few-shot，差别在哪" },
  { itemId: "a2", kind: "apply", question: "写一个让模型稳定输出 JSON 的 prompt，并贴出你跑通的结果" },
];

/* 人工标注夹具：answers 为学员作答，expect 为每条的期望判分（数组=可接受集合） */
const CASES = [
  {
    name: "全对：定义准确 + prompt 有角色/约束/只输出",
    answers: {
      a1: "zero-shot 是直接下指令不给例子，靠模型已有能力；few-shot 是先给两三个输入输出示例让它照着格式来。差别在于是否提供示例：任务格式越特殊越需要 few-shot。",
      a2: "你是数据助手。把下面的句子改写成 JSON，字段固定为 {name, age}。只输出 JSON，不要解释。句子：小明今年 12 岁。",
    },
    expect: { a1: ["correct"], a2: ["correct"] },
  },
  {
    name: "半对：zero-shot 说成不用训练（概念近似）+ prompt 完整",
    answers: {
      a1: "zero-shot 就是模型不用训练直接用，few-shot 是要给几个例子训练一下再用。",
      a2: "你是数据助手。把下面的句子改写成 JSON，字段固定为 {name, age}。只输出 JSON，不要解释。句子：小明今年 12 岁。",
    },
    expect: { a1: ["partially_correct", "correct"], a2: ["correct"] },
  },
  {
    name: "定义完全错 + prompt 只有半句话",
    answers: {
      a1: "zero-shot 是模型自己训练自己，few-shot 是人工训练。",
      a2: "告诉它要输出 JSON 就行。",
    },
    expect: { a1: ["incorrect"], a2: ["partially_correct", "incorrect"] },
  },
  {
    name: "a1 准确但简短 + a2 写成输出散文的 prompt（跑题）",
    answers: {
      a1: "zero-shot 不给示例直接问，few-shot 给示例再问，few-shot 格式更稳。",
      a2: "你是一名作家。请以「秋天的公园」为题写一篇 300 字散文，要有画面感。",
    },
    expect: { a1: ["correct"], a2: ["incorrect"] },
  },
  {
    name: "诚实空白：两条都写不知道",
    answers: { a1: "不知道", a2: "不知道" },
    expect: { a1: ["incorrect", "ungradable"], a2: ["incorrect", "ungradable"] },
  },
  {
    name: "a2 缺『只输出』约束（常见易错点）",
    answers: {
      a1: "zero-shot 直接问，few-shot 先给例子。给例子能对齐输出格式，不给例子靠模型常识。",
      a2: "请把「小明今年 12 岁」转成 JSON，字段有 name 和 age。",
    },
    expect: { a1: ["correct"], a2: ["partially_correct", "correct"] },
  },
  {
    name: "复述讲义原文（以讲义为参照应判对）",
    answers: {
      a1: "zero-shot：不给例子，直接下指令。适合任务边界清晰、模型见过的任务。few-shot：给 2-3 个输入输出示例，让模型模仿格式。",
      a2: "你是产品文案。任务：把功能点改写成朋友圈文案。要求：只输出 JSON 格式，包含 title 和 content 两个字段，不要输出其他内容。",
    },
    expect: { a1: ["correct"], a2: ["correct"] },
  },
  {
    name: "答非所问：写学习计划",
    answers: {
      a1: "我打算每天早上学一小时提示词，周末做项目。",
      a2: "我明天先把课程看完再说。",
    },
    expect: { a1: ["incorrect"], a2: ["incorrect"] },
  },
];

/* ---- NDJSON 流式读取（与 client.ts streamChat 同协议） ---- */
async function callQuizGrade(ctx) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      args: { ctx },
      messages: [{ role: "user", content: "开始评分。" }],
      temperature: 0.3,
      task: "quiz-grade",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let err = null;
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
        if (ev.t === "d") full += ev.v;
        else if (ev.t === "e") err = ev.v || "模型返回错误";
      } catch { /* 半行 */ }
    }
  }
  if (err) throw new Error(err);
  return full;
}

/* ---- 容错 JSON 提取（extractJson 的独立实现） ---- */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > start) candidates.push(text.slice(start, end + 1));
  }
  candidates.push(text.trim());
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* next */ }
  }
  throw new Error("无法从模型输出解析 JSON");
}

async function main() {
  console.log(`eval quiz-grade → ${BASE}，共 ${CASES.length} 个夹具\n`);
  let total = 0;
  let pass = 0;
  const failures = [];

  for (const c of CASES) {
    const ctx = JSON.stringify({
      day: "Day 1：提示词基础",
      knowledgePoints: KP,
      lesson: LESSON,
      items: ITEMS,
      answers: c.answers,
    });
    let out;
    try {
      const full = await callQuizGrade(ctx);
      out = extractJson(full);
    } catch (e) {
      failures.push(`${c.name} → 调用/解析失败：${e.message}`);
      console.log(`✗ ${c.name}（调用失败：${e.message}）`);
      total += ITEMS.length;
      continue;
    }
    const byId = new Map((out.items ?? []).map((i) => [i.itemId, i]));
    const got = [];
    for (const item of ITEMS) {
      total += 1;
      const expected = c.expect[item.itemId];
      const v = byId.get(item.itemId)?.verdict;
      const ok = expected.includes(v);
      if (ok) pass += 1;
      else failures.push(`${c.name} / ${item.itemId}：期望 ${expected.join("|")}，实际 ${v}`);
      got.push(`${item.itemId}:${v}${ok ? "" : `(期望${expected.join("|")})`}`);
    }
    console.log(`${got.every((g) => !g.includes("期望")) ? "✓" : "✗"} ${c.name}\n   ${got.join("  ")}`);
  }

  const rate = total ? pass / total : 0;
  console.log(`\n判分一致率：${pass}/${total} = ${(rate * 100).toFixed(1)}%（阈值 ${PASS_RATE * 100}%）`);
  if (failures.length) {
    console.log("\n不一致明细：");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(rate >= PASS_RATE ? 0 : 1);
}

main().catch((e) => {
  console.error("eval 运行失败：", e.message);
  process.exit(1);
});
