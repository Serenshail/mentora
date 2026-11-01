/* WXML 结构校验：标签配对 + {{}} 完整性 + 常见错误。
 * 用法：node scripts/check-mp-wxml.cjs */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "miniprogram");
const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));

const VOID = new Set(["input", "image", "icon", "import", "include", "wxs", "switch", "slider", "progress", "textarea", "canvas"]);

let problems = 0;
function err(file, msg, line) {
  problems++;
  console.log(`✗ ${file}:${line || "?"} — ${msg}`);
}

function checkFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(root, file);

  // 1) {{ }} 配平
  const open = (src.match(/\{\{/g) || []).length;
  const close = (src.match(/\}\}/g) || []).length;
  if (open !== close) err(rel, `插值不配平：{{ x${open} vs }} x${close}`);

  // 2) 标签配对（忽略自闭合与 void）
  const lines = src.split("\n");
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  let consumed = 0;
  while ((m = tagRe.exec(src))) {
    const [raw, slash, name, attrs, selfClose] = m;
    const lineNo = src.slice(0, m.index).split("\n").length;
    if (name === "wxs" || name === "import" || name === "include") continue;
    if (slash === "/") {
      const top = stack.pop();
      if (!top) err(rel, `多余的闭合标签 </${name}>`, lineNo);
      else if (top.name !== name) err(rel, `标签错配：<${top.name}> 在第 ${top.line} 行打开，却被 </${name}> 关闭`, lineNo);
    } else if (selfClose === "/") {
      continue;
    } else if (attrs && /\{\{[\s\S]*$/.test(attrs.trim()) && !/\}\}/.test(attrs)) {
      err(rel, `<${name}> 属性里的 {{ 未闭合`, lineNo);
    } else {
      stack.push({ name, line: lineNo });
    }
  }
  for (const t of stack) err(rel, `<${t.name}> 未闭合（第 ${t.line} 行）`, t.line);

  // 3) 事件处理器是否存在于同名 js
  const jsFile = file.replace(/\.wxml$/, ".js");
  if (fs.existsSync(jsFile)) {
    const js = fs.readFileSync(jsFile, "utf8");
    const handlers = new Set([...src.matchAll(/(?:bind|catch)(?::)?([a-zA-Z]+)="([a-zA-Z_$][\w$]*)"/g)].map((x) => x[2]));
    for (const h of handlers) {
      const declared =
        new RegExp(`(^|\\s)${h}\\s*:\\s*function`, "m").test(js) ||
        new RegExp(`(^|\\s)${h}\\s*\\(`, "m").test(js) ||
        new RegExp(`${h}\\s*=\\s*function`, "m").test(js);
      if (!declared) err(rel, `事件处理器 ${h} 在 ${path.basename(jsFile)} 里找不到`);
    }
    // 4) 模板引用（data 字段）是否在 data 里声明
    const dataBlock = /data\s*:\s*\{([\s\S]*?)\n\s{2}\}/.exec(js);
    if (dataBlock) {
      const dataKeys = new Set(
        [...dataBlock[1].matchAll(/^\s{4}([a-zA-Z_$][\w$]*)\s*:/gm)].map((x) => x[1])
      );
      const used = new Set([...src.matchAll(/\{\{\s*([a-zA-Z_$][\w$]*)/g)].map((x) => x[1]));
      const builtin = new Set(["item", "index", "true", "false", "null", "undefined"]);
      // <template is="..." data="{{x: y}}"/> 里声明的局部别名（如 blocks）不属于页面 data
      const tplAliases = new Set(
        [...src.matchAll(/<template[^>]*data="\{\{([^}]*)\}\}"/g)].flatMap((mm) =>
          mm[1].split(",").map((s) => s.split(":")[0].trim())
        )
      );
      for (const u of used) {
        if (builtin.has(u) || dataKeys.has(u) || tplAliases.has(u)) continue;
        // wx:for-item 自定义别名
        const alias = new RegExp(`wx:for-item="${u}"`).test(src);
        const forIdx = new RegExp(`wx:for-index="${u}"`).test(src);
        if (alias || forIdx) continue;
        err(rel, `模板引用了 data 里没有的字段：${u}`);
      }
    }
  }
}

function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (f.endsWith(".wxml")) checkFile(p);
  }
}

walk(root);
// 独立模板也要查
checkFile(path.join(root, "wxml", "md.wxml").replace(/.*/, path.join(root, "wxml/md.wxml")));

console.log(problems ? `\n${problems} problem(s)` : "WXML OK");
process.exit(problems ? 1 : 0);
