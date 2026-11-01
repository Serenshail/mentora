/* WXML/WXSS → HTML 预览器（仅供设计迭代时目检，不进小程序包）
 *
 * 小程序在真机上是 WebView 渲染，WXSS 基本就是 CSS 子集，所以把 WXML 翻成 HTML、
 * WXSS 的 rpx 换算成 px，就能用 Chromium 还原到非常接近的效果。
 * 有了它，改 UI 时不必依赖微信开发者工具的窗口（本机那套 GUI 自动化抢不到焦点）。
 *
 * 用法：node scripts/mp-preview.cjs [pageName]
 *   生成 preview/<page>.html，配合 scripts/mp-shots.mjs 截图。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "miniprogram");
const OUT = path.join(__dirname, "..", "preview");
const VIEWPORT = 390; // iPhone 14 逻辑宽度
const RPX = VIEWPORT / 750; // 1rpx = 0.52px

/* ---------------- WXML 解析 ---------------- */
const VOID = new Set(["input", "image", "import", "include", "icon", "wxs"]);

function parse(src) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      const t = src.slice(i);
      if (t.trim()) stack[stack.length - 1].children.push({ tag: "#text", text: t });
      break;
    }
    if (lt > i) {
      const t = src.slice(i, lt);
      if (t.trim()) stack[stack.length - 1].children.push({ tag: "#text", text: t });
    }
    // 注释
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    const gt = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      // 弹到匹配的父级
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const tag = (sp < 0 ? body : body.slice(0, sp)).trim();
    const attrStr = sp < 0 ? "" : body.slice(sp);
    const attrs = parseAttrs(attrStr);
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID.has(tag)) stack.push(node);
  }
  return root;
}

/** 找到标签结束的 >，跳过引号内的 > */
function findTagEnd(src, lt) {
  let q = null;
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i;
  }
  return src.length - 1;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : "true";
  }
  return attrs;
}

/* ---------------- 表达式求值 ---------------- */
function evalExpr(expr, ctx) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("$d", `with($d){ return (${expr}); }`);
    const v = fn(ctx);
    return v === undefined || v === null ? "" : v;
  } catch (e) {
    return "";
  }
}

function interp(str, ctx) {
  if (str === undefined) return "";
  return String(str).replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => String(evalExpr(e, ctx)));
}

/** {{blocks: item.blocks}} → 真实对象 */
function interpObject(str, ctx) {
  const raw = String(str).trim();
  // 支持两种调用："{{obj}}" 或裸表达式 "item.blocks"
  const m = /^\{\{([\s\S]*)\}\}$/.exec(raw) || [null, raw];
  if (!m) return {};
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function("$d", `with($d){ return ({${m[1]}}); }`);
    return fn(ctx) || {};
  } catch (e) {
    return {};
  }
}

/* ---------------- 模板收集 ---------------- */
const templates = {}; // name -> node

function collectTemplates(node) {
  for (const c of node.children || []) {
    if (c.tag === "template" && c.attrs.name) templates[c.attrs.name] = c;
    collectTemplates(c);
  }
}

/* ---------------- 渲染 ---------------- */
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TAG_MAP = {
  view: "div",
  "scroll-view": "div",
  block: null, // 透明
  text: "span",
  image: "img",
  navigator: "div",
  button: "button",
  input: "input",
  textarea: "textarea",
  label: "label",
  "rich-text": "div",
  swiper: "div",
  "swiper-item": "div",
  template: null,
};

function renderChildren(children, ctx) {
  let out = "";
  // wx:if / wx:elif / wx:else 必须作为链处理
  let chainMatched = false;
  for (const c of children) {
    const a = c.attrs || {};
    if (a["wx:if"] !== undefined) {
      chainMatched = truthy(interp(a["wx:if"], ctx));
      if (chainMatched) out += renderNode(c, ctx);
      continue;
    }
    if (a["wx:elif"] !== undefined) {
      if (chainMatched) continue;
      chainMatched = truthy(interp(a["wx:elif"], ctx));
      if (chainMatched) out += renderNode(c, ctx);
      continue;
    }
    if (a["wx:else"] !== undefined) {
      if (!chainMatched) out += renderNode(c, ctx);
      chainMatched = false;
      continue;
    }
    chainMatched = false;
    out += renderNode(c, ctx);
  }
  return out;
}

function renderNode(node, ctx) {
  if (node.tag === "#text") return interp(node.text, ctx);

  // wx:for（优先于 wx:if）
  if (node.attrs["wx:for"] !== undefined) {
    // wx:for 的表达式用**当前**上下文求值（此时内层 item 还没绑定）
    let arr = evalExpr(stripBraces(node.attrs["wx:for"]), ctx);
    if (!Array.isArray(arr)) arr = [];
    const itemName = node.attrs["wx:for-item"] || "item";
    const idxName = node.attrs["wx:for-index"] || "index";
    const clone = { ...node, attrs: { ...node.attrs } };
    delete clone.attrs["wx:for"];
    let out = "";
    arr.forEach((it, idx) => {
      const sub = Object.assign({}, ctx);
      sub[itemName] = it;
      sub[idxName] = idx;
      out += renderNode(clone, sub);
    });
    return out;
  }

  // 条件（elif/else 由 renderChildren 处理，这里只兜底单独出现的情况）
  if (node.attrs["wx:if"] !== undefined) {
    if (!truthy(interp(node.attrs["wx:if"], ctx))) return "";
  }

  // template 引用
  if (node.tag === "template" && node.attrs.is) {
    const tpl = templates[node.attrs.is];
    if (!tpl) return "";
    const sub = Object.assign({}, ctx);
    const data = interpObject(node.attrs.data || "", ctx);
    Object.assign(sub, data);
    return renderChildren(tpl.children, sub);
  }

  if (node.tag === "import" || node.tag === "wxs" || node.tag === "template") return "";

  const htmlTag = TAG_MAP[node.tag] === undefined ? "div" : TAG_MAP[node.tag];
  const inner = renderChildren(node.children, ctx);
  if (htmlTag === null) return inner; // block

  // rich-text：nodes 是对象数组（span/text），不是 WXML 子节点
  if (node.tag === "rich-text") {
    let nodes = evalExpr(stripBraces(node.attrs.nodes || "[]"), ctx);
    if (!Array.isArray(nodes)) nodes = [];
    const renderRich = (arr) =>
      arr
        .map((n) => {
          if (!n || typeof n !== "object") return "";
          if (n.type === "text") return esc(n.text === undefined ? "" : n.text);
          const tagName = n.name || "span";
          const st = (n.attrs && n.attrs.style) || "";
          const kids = n.children ? renderRich(n.children) : "";
          return `<${tagName}${st ? ` style="${esc(st)}"` : ""}>${kids}</${tagName}>`;
        })
        .join("");
    const cls0 = interp(node.attrs.class || "", ctx);
    return `<div${cls0 ? ` class="${esc(cls0)}"` : ""}>${renderRich(nodes)}</div>`;
  }

  const cls = interp(node.attrs.class || "", ctx).replace(/\s+/g, " ").trim();
  const style = interp(node.attrs.style || "", ctx);
  const attrs = [];
  if (cls) attrs.push(`class="${esc(cls)}"`);
  if (style) attrs.push(`style="${esc(style)}"`);
  attrs.push(`data-wx="${node.tag}"`);

  if (node.tag === "input") {
    const val = interp(node.attrs.value || "", ctx);
    const ph = interp(node.attrs.placeholder || "", ctx);
    const phCls = interp(node.attrs["placeholder-class"] || "", ctx);
    if (val) {
      attrs.push(`value="${esc(val)}"`);
    } else {
      attrs.push(`placeholder="${esc(ph)}"`);
      if (phCls) attrs.push(`data-ph="${esc(phCls)}"`);
    }
    const type = node.attrs.password === "true" || node.attrs.password === "" ? "password" : "text";
    if (type === "password") attrs.push(`type="password"`);
    return `<input ${attrs.join(" ")} />`;
  }
  if (node.tag === "textarea") {
    const val = interp(node.attrs.value || "", ctx);
    const ph = interp(node.attrs.placeholder || "", ctx);
    attrs.push(`placeholder="${esc(ph)}"`);
    return `<textarea ${attrs.join(" ")}>${esc(val)}</textarea>`;
  }
  if (node.tag === "image") {
    let src = interp(node.attrs.src || "", ctx);
    // 内联成 base64：避免 file:// 图片被 Chromium 拦截，也避免双击 class
    const inline = (rel) => {
      try {
        const abs = path.join(ROOT, rel);
        const buf = fs.readFileSync(abs);
        const ext = path.extname(abs).slice(1).toLowerCase();
        const mime = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
        return `data:${mime};base64,${buf.toString("base64")}`;
      } catch (e) {
        return "";
      }
    };
    let data = "";
    if (src.charAt(0) === "/") data = inline(src.slice(1));
    else if (!/^(https?|data):/.test(src)) data = inline(src);
    if (data) src = data;
    const cls = interp(node.attrs.class || "", ctx);
    attrs.push(`class="wx-image ${cls}"`);
    attrs.push(`src="${src}"`);
    return `<img ${attrs.join(" ")} />`;
  }
  if (node.tag === "button") {
    return `<button ${attrs.join(" ")}>${inner}</button>`;
  }
  return `<${htmlTag} ${attrs.join(" ")}>${inner}</${htmlTag}>`;
}

function stripBraces(s) {
  const m = /^\{\{([\s\S]*)\}\}$/.exec(String(s).trim());
  return m ? m[1] : s;
}

function truthy(v) {
  if (v === "" || v === "false" || v === "0" || v === undefined || v === null) return false;
  return true;
}

/* ---------------- WXSS → CSS ---------------- */
function wxssToCss(file) {
  let css = fs.readFileSync(file, "utf8");
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // rpx → px
  css = css.replace(/(-?[\d.]+)rpx/g, (_, n) => `${(parseFloat(n) * RPX).toFixed(2)}px`);
  // page 选择器 → body/.page-root
  css = css.replace(/(^|\})\s*page\s*\{/g, "$1 html,body {");
  return css;
}

/* ---------------- 页面清单与 mock 数据 ---------------- */
const MOCKS = require("./mp-preview-data.cjs");

function build(pagePath) {
  const name = pagePath.split("/").pop();
  const wxml = fs.readFileSync(path.join(ROOT, pagePath + ".wxml"), "utf8");
  const pageCss = fs.existsSync(path.join(ROOT, pagePath + ".wxss"))
    ? fs.readFileSync(path.join(ROOT, pagePath + ".wxss"), "utf8")
    : "";

  // 收集 md.wxml 的模板
  const mdTpl = fs.readFileSync(path.join(ROOT, "wxml", "md.wxml"), "utf8");
  collectTemplates(parse(mdTpl));

  const tree = parse(wxml);
  const data = (MOCKS[name] && MOCKS[name]()) || {};
  const body = renderChildren(tree.children, data);

  const css =
    wxssToCss(path.join(ROOT, "app.wxss")) +
    "\n" +
    pageCss
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(-?[\d.]+)rpx/g, (_, n) => `${(parseFloat(n) * RPX).toFixed(2)}px`);

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=${VIEWPORT},initial-scale=1">
<style>
/* --- 小程序基础样式复位（与真机 WebView 行为对齐） --- */
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:${VIEWPORT}px}
div,span,button,input,textarea{display:block}
span{display:inline}
button{border:none;background:none;font:inherit;padding:0;margin:0;text-align:inherit}
input,textarea{border:none;outline:none;font:inherit;background:none;padding:0;margin:0;width:100%;resize:none}
input::placeholder,textarea::placeholder{color:#b8bcc4}
img{display:block}
.wx-image{object-fit:cover}
${css}
</style></head>
<body>${body}</body></html>`;
  fs.mkdirSync(OUT, { recursive: true });
  const f = path.join(OUT, name + ".html");
  fs.writeFileSync(f, html);
  return f;
}

const only = process.argv[2];
const app = JSON.parse(fs.readFileSync(path.join(ROOT, "app.json"), "utf8"));
const pages = app.pages.filter((p) => !only || p.includes(only));
for (const p of pages) {
  const f = build(p);
  console.log("built", path.relative(process.cwd(), f));
}
