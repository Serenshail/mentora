/* 小程序 UI 视觉预览器（仅开发期用，不入小程序包）
 *
 * 为什么需要它：WXML/WXSS 无法在浏览器里直接跑，而微信开发者工具需要交互登录。
 * 这个脚本把 WXML 的最小子集 + WXSS（已是标准 CSS）转成 HTML，
 * 用 Playwright 渲染成图片，用来检查**布局层级、留白、字号节奏**是否成立。
 *
 * 它不验证交互与真实数据，只验证视觉结构——这正是"UI 改得好不好"要回答的问题。
 *
 * 用法：node scripts/preview-mp-ui.mjs
 * 产物：.tmp-mp-preview/*.png
 */
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MP = join(here, "..", "miniprogram");
const OUT = join(here, "..", ".tmp-mp-preview");
mkdirSync(OUT, { recursive: true });

const APP_WXSS = readFileSync(join(MP, "app.wxss"), "utf8");
const NAV_WXSS = readFileSync(join(MP, "components/nav-bar/nav-bar.wxss"), "utf8");
/* 品牌字体（base64 内联的 Great Vibes）——预览器与实机同一份资产 */
const FONT_WXSS = existsSync(join(MP, "styles/font-brand.wxss"))
  ? readFileSync(join(MP, "styles/font-brand.wxss"), "utf8")
  : "";

/* ---- WXSS → CSS：rpx 换算。750rpx = 375px 屏宽，即 1rpx = 0.5px ---- */
function wxssToCss(src) {
  return src
    .replace(/(-?\d*\.?\d+)rpx/g, (_, n) => `${parseFloat(n) / 2}px`)
    // 小程序里变量都挂在 page 选择器上；浏览器 HTML 没有 <page> 元素，
    // 必须映射到 :root，否则全部 var() 颜色失效（卡片透明、边框消失）。
    // 只认"行首的 page {"，绝不碰 ".page" / "#page" 等类选择器。
    .replace(/^page\s*\{/gm, ":root {")
    .replace(/env\(safe-area-inset-bottom\)/g, "0px")
    .replace(/env\(safe-area-inset-top\)/g, "0px");
}

/* ---- WXML → HTML：只处理这些页面用到的语法 ---- */
function wxmlToHtml(src, data) {
  let s = src;
  // 去掉 import / nav-bar（nav-bar 单独注入）
  s = s.replace(/<import[^>]*\/>/g, "");
  s = s.replace(/<nav-bar([^>]*)\/>/g, (_, attrs) => {
    const home = /home="\{\{true\}\}"/.test(attrs);
    const titleM = attrs.match(/title="([^"]*)"/);
    const title = titleM ? titleM[1].replace(/\{\{[^}]*\}\}/g, "") : "";
    return `<div class="nav"><div class="nav-bar" style="height:44px">
      <div class="nav-left">${
        home
          ? '<div class="nav-brand font-brand">Mentora</div>'
          : '<div class="nav-back"><div class="nav-chev"></div></div>'
      }${title ? `<div class="nav-title ellipsis">${title}</div>` : ""}</div></div></div>`;
  });
  // 先展开 wx:for，再裁决 wx:if —— 与 WXML 实际求值顺序一致。
  // 插值在 for 内部完成（item 只在循环作用域里存在），
  // 最外层只兜底处理循环外的插值。
  s = renderFor(s, data);
  s = renderIf(s, data);
  s = renderFor(s, data);
  s = renderIf(s, data);
  s = s.replace(/\{\{([^}]*)\}\}/g, (_, expr) => {
    const v = evalExpr(expr, data);
    return v == null ? "" : String(v);
  });
  // 标签映射
  s = s.replace(/<view/g, "<div").replace(/<\/view>/g, "</div>");
  s = s.replace(/<text/g, "<span").replace(/<\/text>/g, "</span>");
  s = s.replace(/<image([^>]*)\/>/g, (_m, attrs) => {
    const cls = (attrs.match(/class="([^"]*)"/) || [, ""])[1];
    return `<div class="${cls}" style="background:#e8e8ed"></div>`;
  });
  s = s.replace(/<scroll-view([^>]*)>/g, "<div>");
  s = s.replace(/<\/scroll-view>/g, "</div>");
  s = s.replace(/<template[^>]*\/>/g, "");
  s = s.replace(/<block[^>]*>/g, "").replace(/<\/block>/g, "");
  // 自闭合的 view/input 等
  s = s.replace(/<input([^>]*)\/>/g, (_m, attrs) => {
    const cls = (attrs.match(/class="([^"]*)"/) || [, ""])[1];
    const ph = (attrs.match(/placeholder="([^"]*)"/) || [, ""])[1];
    return `<div class="${cls}" style="display:flex;align-items:center;color:#aeaeb2">${ph}</div>`;
  });
  s = s.replace(/<textarea([^>]*)\/>/g, (_m, attrs) => {
    const cls = (attrs.match(/class="([^"]*)"/) || [, ""])[1];
    const ph = (attrs.match(/placeholder="([^"]*)"/) || [, ""])[1];
    return `<div class="${cls}" style="display:flex;color:#aeaeb2;align-items:flex-start;padding-top:12px">${ph}</div>`;
  });
  s = s.replace(/<button([^>]*)>/g, "<div>");
  s = s.replace(/<\/button>/g, "</div>");
  return s;
}

/* 极简 wx:for 展开：只支持 `wx:for="{{arr}}"` + item 字段。
 * 关键：闭合位置必须用配对查找——循环体里套着嵌套 view，
 * 非贪婪的 `[\s\S]*?<\/tag>` 会在第一个内层闭合处提前截断，
 * 目标卡就只剩半截（进度条露在外面、文字全丢）。 */
function renderFor(src, data) {
  const re = /<(\w[\w-]*)([^>]*?)wx:for="\{\{([\w.]+)\}\}"([^>]*?)>/g;
  let out = "";
  let cursor = 0;
  let m;
  while ((m = re.exec(src))) {
    const [full, tag, pre, listName, post] = m;
    if (m.index < cursor) continue;
    if (/\/>$/.test(post)) continue; // 自闭合无循环体
    const innerStart = m.index + full.length;
    const closeIdx = findMatchingClose(src, innerStart, tag);
    if (closeIdx < 0) continue;
    const inner = src.slice(innerStart, closeIdx);
    const list = evalExpr(listName, data);
    out += src.slice(cursor, m.index);
    if (Array.isArray(list)) {
      // 清掉 wx:for-* 属性，只留普通属性
      const cleanAttrs = (pre + post)
        .replace(/wx:for="[^"]*"/g, "")
        .replace(/wx:for-item="[^"]*"/g, "")
        .replace(/wx:for-index="[^"]*"/g, "")
        .replace(/wx:key="[^"]*"/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const alias = (pre + post).match(/wx:for-item="([\w]+)"/);
      out += list
        .map((item, i) => {
          const scope = { ...data, item, index: i };
          if (alias) scope[alias[1]] = item;
          // 顺序：先展开内层 for → 裁决 if → 最后做插值。
          // 插值必须在循环作用域里做，item.xxx 才能取到值。
          let body = renderFor(inner, scope);
          body = renderIf(body, scope);
          body = body.replace(/\{\{([^}]*)\}\}/g, (_mm, expr) => {
            const v = evalExpr(expr, scope);
            return v == null ? "" : String(v);
          });
          return `<${tag} ${cleanAttrs}>${body}</${tag}>`;
        })
        .join("");
    }
    cursor = closeIdx + `</${tag}>`.length;
    re.lastIndex = cursor;
  }
  out += src.slice(cursor);
  return out;
}

/* 处理 wx:if / wx:elif / wx:else 三元链 —— 必须按"同层兄弟"整体裁决，
 * 否则 if 不成立时 elif 分支会被当普通节点渲染，预览就会同时出现两块。 */
function renderIf(src, data) {
  // 逐个找 if 起点，然后向后吃掉紧邻的 elif / else 兄弟（允许中间有空白）
  const startRe = /<(\w[\w-]*)([^>]*?)wx:if="\{\{([^}]+)\}\}"([^>]*?)>/g;
  let out = "";
  let cursor = 0;
  let m;
  while ((m = startRe.exec(src))) {
    const [full, tag, pre, cond, post] = m;
    if (m.index < cursor) continue;
    const selfClosing = /\/$/.test(post);
    out += src.slice(cursor, m.index);
    // 取本元素内容
    let inner = "";
    let end = m.index + full.length;
    if (!selfClosing) {
      const closeTag = `</${tag}>`;
      const closeIdx = findMatchingClose(src, m.index + full.length, tag);
      if (closeIdx < 0) {
        out += full;
        cursor = end;
        continue;
      }
      inner = src.slice(m.index + full.length, closeIdx);
      end = closeIdx + closeTag.length;
    }
    // 收集 elif / else 兄弟（中间允许夹注释与空白——WXML 里经常这样写）
    const branches = [{ cond, inner, pre, post, tag }];
    let scan = end;
    for (;;) {
      const rest = src.slice(scan);
      const lead = rest.match(/^(?:\s+|<!--[\s\S]*?-->)*/);
      const leadLen = lead ? lead[0].length : 0;
      const sibRe = /^<(\w[\w-]*)([^>]*?)(?:wx:elif="\{\{([^}]+)\}\}"|wx:else)([^>]*?)>/;
      const sm = rest.slice(leadLen).match(sibRe);
      if (!sm) break;
      const sTag = sm[1];
      if (sTag !== tag) break;
      const sStart = scan + leadLen;
      const sInnerStart = sStart + sm[0].length;
      const sClose = findMatchingClose(src, sInnerStart, sTag);
      if (sClose < 0) break;
      branches.push({
        cond: sm[3] ? sm[3] : "true", // wx:else 记为恒真
        inner: src.slice(sInnerStart, sClose),
        pre: sm[2],
        post: sm[4],
        tag: sTag,
      });
      scan = sClose + `</${sTag}>`.length;
      end = scan;
    }
    // 只渲染第一个成立的分支
    const hit = branches.find((b) => evalExpr(b.cond, data));
    if (hit) {
      // 属性顺序无关，但必须把 pre 与 post 都带上（class 常在 wx:if 之前）
      out += `<${hit.tag}${hit.pre}${hit.post}>${hit.inner}</${hit.tag}>`;
    }
    cursor = end;
    startRe.lastIndex = end;
  }
  out += src.slice(cursor);
  return out;
}

/** 找到与 start 处元素配对的闭合标签位置 */
function findMatchingClose(src, from, tag) {
  let depth = 1;
  const re = new RegExp(`<\\/?${tag}[\\s>/]`, "g");
  re.lastIndex = from;
  let m;
  while ((m = re.exec(src))) {
    if (src[m.index + 1] === "/") {
      depth--;
      if (depth === 0) return m.index;
    } else {
      // 自闭合不算层级
      const gt = src.indexOf(">", m.index);
      if (src[gt - 1] !== "/") depth++;
    }
  }
  return -1;
}

function evalExpr(expr, data) {
  try {
    const e = expr.trim();
    // 去掉字符串字面量，避免 new Function 里引号问题
    return new Function("d", `with(d){ return (${e}); }`)(data);
  } catch {
    return "";
  }
}

/* ---------- 页面样例数据 + 渲染 ---------- */
async function shoot(page, name, wxmlFile, data, extraCss = "") {
  const wxml = readFileSync(join(MP, wxmlFile), "utf8");
  const cssFile = join(MP, wxmlFile.replace(/\.wxml$/, ".wxss"));
  const pageCss = existsSync(cssFile) ? readFileSync(cssFile, "utf8") : "";
  const body = wxmlToHtml(wxml, data);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
${wxssToCss(FONT_WXSS)}
${wxssToCss(APP_WXSS)}
${wxssToCss(NAV_WXSS)}
${wxssToCss(pageCss)}
${extraCss}
html,body{margin:0;padding:0;width:375px;}
wmdcard{display:block}
</style></head><body>${body}</body></html>`;
  await page.setContent(html, { waitUntil: "load" });
  await page.setViewportSize({ width: 375, height: 812 });
  const file = join(OUT, name + ".png");
  await page.screenshot({ path: file, fullPage: true });
  if (process.env.DUMP_HTML) {
    console.log(`\n----- ${name} -----\n` + body.slice(0, 3000));
  }
  console.log("  ✓", name);
}

const browser = await chromium.launch({
  executablePath:
    "C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe",
});
const page = await browser.newPage({ deviceScaleFactor: 2 });

console.log("渲染中…");

/* ---- 今天页：有目标 + 有复习 ---- */
await shoot(page, "01-today", "pages/overview/overview.wxml", {
  greet: "晚上好",
  heading: "今天做一件事",
  sync: "已同步",
  goal: {
    id: "g1",
    topic: "Python 数据分析",
    direction: "三个月内能独立完成一份真实数据报告",
    progress: 42,
    done: 5,
    total: 12,
    gated: false,
    kicker: "阶段2 · 数据清洗",
    dayTitle: "Day 6：pandas 缺失值与类型转换",
  },
  dueCount: 7,
  streakDays: 4,
  loading: false,
  heatCols: Array.from({ length: 12 }, (_, w) => ({
    index: w,
    cells: [],
  })),
});

/* ---- 学习页：目标 ---- */
await shoot(page, "02-learn-goals", "pages/learn/learn.wxml", {
  tab: "goals",
  loading: false,
  adding: false,
  goals: [
    {
      id: "g1",
      topic: "Python 数据分析",
      direction: "三个月内能独立完成一份真实数据报告",
      progress: 42,
      done: 5,
      total: 12,
      statusLabel: "进行中",
      tone: "accent",
      active: true,
    },
    {
      id: "g2",
      topic: "雅思 6.5",
      direction: "半年内达到 6.5，主攻写作与口语",
      progress: 18,
      done: 3,
      total: 17,
      statusLabel: "进行中",
      tone: "accent",
      active: true,
    },
  ],
  books: [],
});

/* ---- 学习页：书架 ---- */
await shoot(page, "03-learn-books", "pages/learn/learn.wxml", {
  tab: "books",
  loading: false,
  adding: false,
  goals: [],
  books: [
    {
      id: "b1",
      title: "思考，快与慢",
      author: "丹尼尔·卡尼曼",
      progress: 60,
      chapters: "3/5 章",
      statusLabel: "在读",
      status: "reading",
    },
    {
      id: "b2",
      title: "反脆弱",
      author: "纳西姆·塔勒布",
      progress: 0,
      chapters: "0/6 章",
      statusLabel: "想读",
      status: "want",
    },
  ],
});

/* ---- 伙伴页：会话列表 ---- */
await shoot(page, "04-council-list", "pages/council/council.wxml", {
  view: "list",
  sessions: [
    { id: "s1", title: "要不要辞职做独立产品 · 3人 · 11/1", initial: "要", count: 8, when: "11/01", roundtable: true },
    { id: "s2", title: "Naval Ravikant", initial: "N", count: 4, when: "10/30", roundtable: false },
  ],
});

/* ---- 伙伴页：选人网格 ---- */
await shoot(page, "05-council-pick", "pages/council/council.wxml", {
  view: "pick",
  pickMode: "roundtable",
  picked: { naval: true, jobs: true, taleb: true },
  pickedCount: 3,
  allSeats: [
    { id: "naval", name: "Naval Ravikant", tag: "财富 · 自由哲学", initial: "N", concept: false, hasPhoto: true },
    { id: "jobs", name: "Steve Jobs", tag: "产品 · 聚焦", initial: "S", concept: false, hasPhoto: true },
    { id: "munger", name: "Charlie Munger", tag: "投资 · 理性", initial: "C", concept: false, hasPhoto: true },
    { id: "feynman", name: "Richard Feynman", tag: "物理 · 科学诚实", initial: "R", concept: false, hasPhoto: true },
    { id: "taleb", name: "Nassim Taleb", tag: "风险 · 反脆弱", initial: "N", concept: false, hasPhoto: true },
    { id: "graham", name: "Paul Graham", tag: "创业 · 写作思考", initial: "P", concept: false, hasPhoto: true },
    { id: "first-principles", name: "第一性原理", tag: "拆到不可再拆的事实", initial: "第", concept: true, hasPhoto: false },
    { id: "incentives", name: "激励相容", tag: "看懂激励驱动", initial: "激", concept: true, hasPhoto: false },
  ],
});

/* ---- 日记页：讲义态 ---- */
await shoot(page, "06-day-lesson", "pages/day/day.wxml", {
  day: {
    title: "Day 6：pandas 缺失值与类型转换",
    method: "先跑通一个真实脏数据案例，再逐个拆解每个处理方法的适用边界",
    status: "active",
    attempts: 0,
    stub: false,
    pendingUnlock: false,
    kps: ["isna 与 notna 的区别", "fillna 的四种策略", "astype 与 to_numeric 的取舍"],
  },
  tab: "lesson",
  readOnly: false,
  lessonBlocks: [
    { t: "h", level: 2, text: "① 直接可学的资料" },
    { t: "p", text: "pandas 官方文档的 Missing data 小节，先看 Working with missing data 的前两节。" },
  ],
  lessonBusy: false,
  links: [{ url: "https://pandas.pydata.org/docs/user_guide/missing_data.html" }],
  resources: [
    { title: "pandas 官方 · Missing data", why: "第一手资料，例子都能直接跑", kindLabel: "官方文档", url: "https://pandas.pydata.org" },
    { title: "B站 · pandas 数据清洗实战", why: "看第 3-5 集，跟着敲一遍", kindLabel: "视频课", url: "https://bilibili.com" },
  ],
});

/* ---- 复习页：待开始 ---- */
await shoot(page, "07-review-idle", "pages/review/review.wxml", {
  phase: "idle",
  queueCount: 7,
  total: 7,
  estimate: 5,
  correct: 0,
});

/* ---- 大脑页 ---- */
await shoot(page, "08-brain", "pages/brain/brain.wxml", {
  total: 42,
  linkCount: 67,
  dueCount: 7,
  query: "",
  activeFolder: "",
  folders: ["Python", "雅思", "读书", "工作"],
  loading: false,
  notes: [
    { id: "k1", title: "isna 与 notna 的区别", domain: "Python/笔记", excerpt: "isna 返回布尔掩码，notna 是它的取反；两者在链式调用里的可读性差别很大。", due: true, unresolved: false },
    { id: "k2", title: "fillna 的四种策略", domain: "Python/笔记", excerpt: "固定值、前向填充、后向填充、插值——选择取决于数据生成机制，不是习惯。", due: false, unresolved: false },
    { id: "k3", title: "沉没成本与反脆弱", domain: "读书", excerpt: "塔勒布认为沉没成本谬误的反面不是理性退出，而是从一开始就别把自己置于不可逆的位置。", due: false, unresolved: false },
  ],
});

await browser.close();
console.log("\n产物在 .tmp-mp-preview/");
