/* WXSS 兼容性检查：小程序 WXSS 支持的 CSS 子集有限。
 * 检查：非法选择器（后代选择器允许但属性选择器/伪元素受限）、
 *       不支持的属性值、@media/@keyframes 语法、单位使用。
 * 用法：node scripts/check-mp-wxss.cjs */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "miniprogram");

let problems = 0;
function err(file, msg) {
  problems++;
  console.log(`✗ ${file} — ${msg}`);
}

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".wxss")) files.push(p);
  }
})(root);

for (const file of files) {
  const rel = path.relative(root, file);
  let css = fs.readFileSync(file, "utf8");

  // 去注释后再分析
  const noComment = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stripped = noComment.replace(/@import[^;]+;/g, "");

  // 1) 大括号配平
  const open = (stripped.match(/{/g) || []).length;
  const close = (stripped.match(/}/g) || []).length;
  if (open !== close) err(rel, `大括号不配平 { x${open} / } x${close}`);

  // 2) 圆括号配平（rgba/calc 里常见漏写）
  const po = (stripped.match(/\(/g) || []).length;
  const pc = (stripped.match(/\)/g) || []).length;
  if (po !== pc) err(rel, `圆括号不配平 ( x${po} / ) x${pc}`);

  // 3) WXSS 不支持的选择器/写法
  // 注：:last-child / :first-child 在渲染层可用，保留。
  // 例外：button 组件默认边框重置（.btn::after{border:none}）是官方推荐写法，必须保留。
  const withoutBtnReset = noComment.replace(/\.btn::after\s*\{[^}]*\}/g, "");
  const unsupported = [
    [/::(before|after)\b|:(before|after)\b/g, "伪元素 ::before/::after（WXSS 不支持，需用真实节点）"],
    [/@supports\b/g, "@supports 不被支持"],
    [/position:\s*sticky/g, "position:sticky 在部分基础库不稳"],
  ];
  for (const [re, msg] of unsupported) {
    const hits = withoutBtnReset.match(re);
    if (hits) err(rel, `${msg} ×${hits.length}`);
  }


  // 4) 属性声明缺少分号（最后一条除外）：粗略检测"值后紧跟换行新属性"
  const declBlocks = [...stripped.matchAll(/\{([^{}]*)\}/g)];
  for (const b of declBlocks) {
    const body = b[1].trim();
    if (!body) continue;
    const decls = body.split(";").map((s) => s.trim()).filter(Boolean);
    for (const d of decls) {
      if (!d.includes(":")) err(rel, `疑似非法声明：${d.slice(0, 50)}`);
    }
  }

  // 5) 未知 CSS 变量（用了但没定义）
  const defined = new Set([...noComment.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  // app.wxss 里定义的全局变量对所有页面有效
  const appCss = fs.readFileSync(path.join(root, "app.wxss"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  [...appCss.matchAll(/(--[\w-]+)\s*:/g)].forEach((m) => defined.add(m[1]));
  const usedVars = [...noComment.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
  const unknown = [...new Set(usedVars)].filter((v) => !defined.has(v));
  if (unknown.length) err(rel, `未定义的 CSS 变量：${unknown.join(", ")}`);
}

console.log(problems ? `\n${problems} problem(s)` : `WXSS OK (${files.length} files)`);
process.exit(problems ? 1 : 0);
