/**
 * 插件共享代码生成器（v27 · 插件重构 M2 / D4-B 决策：构建期代码生成）
 *
 *   node scripts/gen-plugin-shared.mjs
 *
 * 从 Mentora 源码（单一真源）生成 vault-home 插件的共享纯函数/数据：
 *   src/lib/ai/json.ts          → plugin-src/30-gen-json.js    （mtExtractJson + 等价性夹具）
 *   src/lib/mastery.ts          → plugin-src/31-gen-mastery.js （掌握状态机 + 夹具）
 *   src/lib/ai/persona-meta.ts  → plugin-src/32-gen-seats.js   （16 席位展示元数据）
 *
 * 产物挂到全局 `MT_GEN` 命名空间（不与 9c/9b 现存实现撞名）；
 * test/infra.js 用夹具做「生成版 vs 9c/9b 现存版」双端等价断言 = 漂移即刻报警。
 * 每个产物头部带源文件 sha256，test/infra.js 复算比对 = 源码改动未重新生成也报警。
 *
 * 运行要求：Node ≥ 22.6（--experimental-strip-types）或 ≥ 23.6（默认开）。
 * 本机 node v24 直接跑。产物写入后需重跑 node plugin-src/build.js 刷新 bundle。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

/* TS 无扩展名相对导入（mastery.ts → "./types"）在 strip-types 下需要解析钩子 */
register(new URL("./ts-resolve-hooks.mjs", import.meta.url));

const MENTORA_ROOT = path.resolve(import.meta.dirname, "..");
const PLUGIN_SRC =
  process.env.VH_PLUGIN_SRC || "D:/zcode/obsidian导航/home-dashboard/plugin-src";

const die = (m) => { console.error("生成失败：" + m); process.exit(1); };
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const imp = async (rel) => {
  const url = pathToFileURL(path.join(MENTORA_ROOT, rel)).href;
  try { return await import(url); }
  catch (e) { die(`导入 ${rel} 失败（Node ≥22.6 需支持 TS 类型擦除）：${e.message}`); }
};

const HEADER = (srcRel, srcSha) =>
  `/* ============================================================================
 *  本文件由 mentora/scripts/gen-plugin-shared.mjs 生成 —— 不要手改，改了会被覆盖。
 *  单一真源：mentora ${srcRel}（sha256 ${srcSha}）
 *  重新生成：cd mentora && node scripts/gen-plugin-shared.mjs && node plugin-src/build.js
 *  ========================================================================== */
`;

function writeGen(name, srcRel, body) {
  const abs = path.join(PLUGIN_SRC, name);
  const srcAbs = path.join(MENTORA_ROOT, srcRel);
  if (!fs.existsSync(srcAbs)) die(`源不存在：${srcAbs}`);
  const srcSha = sha256(fs.readFileSync(srcAbs, "utf8"));
  const out = HEADER(srcRel, srcSha) + body;
  try { new Function(out); } catch (e) { die(`${name} 语法检查失败：${e.message}`); }
  fs.writeFileSync(abs, out, "utf8");
  console.log(`  ✓ ${name}  ← ${srcRel}  (${(out.length / 1024).toFixed(1)} KB)`);
}

/* 函数源：strip-types 加载后 toString() 得到已擦除类型的等价 JS 源。
 * 类型擦除会留下成片空白（"cur      , "），在函数体不含多空格字符串字面量的前提下
 * 做空白规整；正确性由夹具（FIXTURES）兜底——规整若破坏语义，测试层立刻爆。 */
const fnDecl = (f) => {
  const s = f.toString();
  if (!/^\s*function\s/.test(s)) die("预期 function 声明，得到：" + s.slice(0, 60));
  return s.replace(/[ \t]{2,}/g, " ");
};

/* ---------------- 30-gen-json.js ---------------- */
const json = await imp("src/lib/ai/json.ts");
const JSON_CASES = [
  '```json\n{"a": 1, "b": [true, null]}\n```',
  '模型说：{"ok":true,"msg":"他说\\"你好\\""} 完毕',
  '前置文本 [ {"n":1}, {"n":2} ] 后置文本', // 裸数组：必须取整个数组而非首个对象（v14 教训）
  '{"nested":{"deep":{"x":1}},"arr":["{","}"]}',
  '  纯文本，没有 JSON  ',
  '[1,2,3]',
];
const jsonFixtures = JSON_CASES.map((input) => {
  let ok = null, err = null;
  try { ok = json.extractJson(input); } catch (e) { err = e.message; }
  return { input, ok, err };
});

/* ---------------- 31-gen-mastery.js ---------------- */
const types = await imp("src/lib/types.ts");
if (!Array.isArray(types.MASTERY_ORDER)) die("types.ts 未导出 MASTERY_ORDER");
const mastery = await imp("src/lib/mastery.ts");
const MASTERY_CASES = [
  { fn: "masteryFromQuiz", args: [[{ verdict: "pass", hintLevel: 0, kind: "apply" }, { verdict: "partially_correct", hintLevel: 2 }]] },
  { fn: "masteryFromQuiz", args: [[{ verdict: "correct", hintLevel: 0, kind: "build" }]] },
  { fn: "masteryFromReview", args: ["independent", true, 4, 21] },
  { fn: "masteryFromReview", args: ["guided", true, 1, 30] },
  { fn: "masteryFromReview", args: ["durable", false, 9, 100] },
  { fn: "advanceMastery", args: ["unknown", undefined, "correct", 0, { applyEvidence: true }] },
  { fn: "advanceMastery", args: ["learning", "learning", "partially_correct", 2, undefined] },
  { fn: "advanceMastery", args: ["exposed", undefined, "ungradable", 3, undefined] },
  { fn: "maxStatus", args: ["review", "transferable"] },
];
const masteryFixtures = [];
for (const c of MASTERY_CASES) {
  const f = mastery[c.fn];
  if (typeof f !== "function") die(`mastery.ts 缺少导出 ${c.fn}`);
  let ok = null, err = null;
  try { ok = f(...c.args); } catch (e) { err = e.message; }
  masteryFixtures.push({ fn: c.fn, args: c.args, ok, err });
}

/* ---------------- 32-gen-seats.js ---------------- */
const seats = await imp("src/lib/ai/persona-meta.ts");
if (!Array.isArray(seats.ALL_SEAT_METAS) || !seats.ALL_SEAT_METAS.length) die("persona-meta 无席位数据");
const seatsData = JSON.stringify(seats.ALL_SEAT_METAS, null, 2);

/* ---------------- 写盘 ---------------- */
console.log("生成插件共享代码 → " + PLUGIN_SRC);
writeGen(
  "30-gen-json.js",
  "src/lib/ai/json.ts",
  `const MT_GEN = {};\n` +
  `${fnDecl(json.extractJson)}\n` +
  `MT_GEN.extractJson = extractJson;\n` +
  `MT_GEN.JSON_FIXTURES = ${JSON.stringify(jsonFixtures, null, 2)};\n\n` +
  `/* 用法：MT_GEN.extractJson(text) —— 与产品 client.ts 同算法；\n` +
  ` * MT_GEN.JSON_FIXTURES = 生成时用真源跑出的输入/输出对，测试层据此做双端等价断言。 */\n`
);
writeGen(
  "31-gen-mastery.js",
  "src/lib/mastery.ts",
  `MT_GEN.MASTERY_ORDER = ${JSON.stringify(types.MASTERY_ORDER)};\n` +
  `const MASTERY_ORDER = MT_GEN.MASTERY_ORDER;\n` +
  `${fnDecl(mastery.advanceMastery)}\n` +
  `${fnDecl(mastery.maxStatus)}\n` +
  `${fnDecl(mastery.masteryFromQuiz)}\n` +
  `${fnDecl(mastery.masteryFromReview)}\n` +
  `MT_GEN.advanceMastery = advanceMastery;\n` +
  `MT_GEN.maxStatus = maxStatus;\n` +
  `MT_GEN.masteryFromQuiz = masteryFromQuiz;\n` +
  `MT_GEN.masteryFromReview = masteryFromReview;\n` +
  `MT_GEN.MASTERY_FIXTURES = ${JSON.stringify(masteryFixtures, null, 2)};\n`
);
writeGen(
  "32-gen-seats.js",
  "src/lib/ai/persona-meta.ts",
  `MT_GEN.SEATS = ${seatsData};\n\n` +
  `/* 用法：MT_GEN.SEATS —— 与产品 persona-meta.ts 同源；9b 的 MT_PERSONAS/MT_CONCEPT_PERSONAS\n` +
  ` * 与本表的 name/tag/bio/color 一致性由 test/infra.js 断言（漂移即刻报警）。 */\n`
);
console.log("完成。记得跑：node plugin-src/build.js");
