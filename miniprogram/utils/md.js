/* ========= Markdown → 小程序渲染结构 =========
 * 讲义/笔记/纪要都是 Markdown。小程序没有 DOM，用 rich-text 承接：
 * parse(text) → { blocks, links }
 *   blocks: [{t:'h'|'p'|'quote'|'list'|'code'|'hr'|'table', nodes|items|text|rows, _i}]
 *   links:  [{text, url}] —— 供页面顶部/底部生成可复制的链接清单
 * 行内语法：**粗体** *斜体* `代码` [文字](链接) [[双链]]
 * 块级语法：# 标题 / 段落 / > 引用 / - 列表 / 1. 列表 / ``` 代码围栏 / --- 分隔线 / 表格 */

/* 粗体分支 \*\*((?:[^*]|\*(?!\*))+)\*\*：内部允许单个 *（不容 **），这样
 * 「粗体里嵌斜体」（**a *b* c**）能整体命中；此前 \*\*([^*]+)\*\* 内部不容
 * 任何 *，嵌套时整体匹配失败、只剩内层斜体命中，外层星号以纯文本泄漏到
 * 渲染文本。命中的粗体内容再递归 tokenize（见 tokenize 粗体分支）。 */
var TOKEN_RE = /(`([^`]+)`)|(\[\[([^\]]+)\]\])|(!?\[([^\]]*)\]\(([^)\s]+)[^)]*\))|(\*\*((?:[^*]|\*(?!\*))+)\*\*)|(\*([^*]+)\*)/g;

function tokenize(text) {
  var spans = [];
  var last = 0;
  var m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) {
    if (m.index > last) {
      spans.push({ text: text.slice(last, m.index) });
    }
    if (m[2] !== undefined) {
      spans.push({ text: m[2], c: true });
    } else if (m[4] !== undefined) {
      spans.push({ text: m[4], w: true });
    } else if (m[7] !== undefined) {
      spans.push({ text: m[6] || m[7], link: m[7] });
    } else if (m[9] !== undefined) {
      /* 粗体内部递归 tokenize：嵌套的斜体/代码等子标记各自命中，再统一盖上
       * b:true（粗体套斜体 → b+i 的 span）。内层不可能再含 **（粗体正则的
       * 内部量词不容连续星号），递归深度最多两层，不会失控。 */
      var inner = tokenize(m[9]);
      for (var bi = 0; bi < inner.length; bi++) {
        var sub = Object.assign({}, inner[bi]);
        sub.b = true;
        spans.push(sub);
      }
    } else if (m[11] !== undefined) {
      spans.push({ text: m[11], i: true });
    }
    last = m.index + m[0].length;
    /* 粗体分支的递归 tokenize 会把共享正则的 lastIndex 重置为 0（exec 失败时
     * 自动归零），外层循环的扫描位置必须显式恢复，否则从文本头重扫、死循环。 */
    TOKEN_RE.lastIndex = last;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text: text }];
}

function spanStyle(sp) {
  var s = "";
  if (sp.b) s += "font-weight:600;";
  if (sp.i) s += "font-style:italic;";
  if (sp.c) {
    s += "font-family:ui-monospace,Menlo,monospace;";
    s += "font-size:0.94em;";
    /* 与 app.wxss 令牌对齐（带字面回退：rich-text 的内联样式不保证解析 CSS 变量） */
    s += "background:var(--surface-2, #f4f4f5);border-radius:4px;padding:1px 4px;";
  }
  if (sp.w) s += "color:var(--accent, #5b54e6);font-weight:600;";
  if (sp.link) s += "color:var(--accent, #5b54e6);";
  return s;
}

function spansToNodes(spans, baseStyle) {
  return spans.map(function (sp) {
    return {
      name: "span",
      attrs: { style: (baseStyle || "") + spanStyle(sp) },
      children: [{ type: "text", text: sp.text }]
    };
  });
}

function isListItem(line) {
  return /^(\s*)([-*+]|\d+[.、)])(\s+)(.*)$/.test(line);
}

/* 表格分隔行：| --- | :---: | 形态 */
function isTableDelimiterRow(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);
}

/* 表格起始：本行以 | 开头且下一行是分隔行（GFM 表格可打断段落） */
function isTableStart(lines, idx) {
  return (
    idx < lines.length &&
    lines[idx].trim().indexOf("|") === 0 &&
    idx + 1 < lines.length &&
    isTableDelimiterRow(lines[idx + 1])
  );
}

function parse(text) {
  var blocks = [];
  var links = [];
  var lines = String(text || "").split("\n");
  var i = 0;
  var collectSpans = function (raw) {
    var spans = tokenize(raw);
    spans.forEach(function (sp) {
      if (sp.link) links.push({ text: sp.text, url: sp.link });
    });
    return spans;
  };
  var pushInline = function (t, raw, baseStyle, extra) {
    var block = Object.assign({ t: t, nodes: spansToNodes(collectSpans(raw), baseStyle) }, extra || {});
    block._i = blocks.length;
    blocks.push(block);
  };

  while (i < lines.length) {
    var line = lines[i];
    var trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // 代码围栏
    var fence = /^```(\w*)/.exec(trimmed);
    if (fence) {
      var lang = fence[1] || "";
      var buf = [];
      i += 1;
      while (i < lines.length && lines[i].trim().indexOf("```") !== 0) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾围栏
      blocks.push({ t: "code", lang: lang, text: buf.join("\n"), _i: blocks.length });
      continue;
    }

    // 标题：不注入内联字重/颜色——md.wxml 把标题包在 class="md-h md-h{{level}}"
    // 里，app.wxss 的 .md-h1/.md-h2(700)、.md-h4(--ink-2) 才是设计系统的档位。
    // 此前统一内联 600 + --ink，内联样式压过父级类继承，标题层级被塌平
    // （h1/h2 与 h3/h4 同字重、h4 弱化色失效）。段落（.md-p）本来就走
    // 「外层类 + 继承」机制，标题对齐同一机制。
    var h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      var level = Math.min(h[1].length, 4);
      pushInline("h", h[2], "", { level: level });
      i += 1;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ t: "hr", _i: blocks.length });
      i += 1;
      continue;
    }

    // 引用
    if (trimmed.indexOf(">") === 0) {
      var qbuf = [];
      while (i < lines.length && lines[i].trim().indexOf(">") === 0) {
        qbuf.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      pushInline("quote", qbuf.join(" "), "color:var(--ink-2, #6e6e73);");
      continue;
    }

    // 表格（| a | b | 形态，含分隔行）
    if (isTableStart(lines, i)) {
      var rows = [];
      while (i < lines.length && lines[i].trim().indexOf("|") === 0) {
        if (!isTableDelimiterRow(lines[i])) {
          var cells = lines[i].trim().replace(/^\||\|$/g, "").split("|");
          rows.push({
            _i: rows.length,
            cells: cells
              .filter(function (c, ci, arr) {
                return !(ci === arr.length - 1 && !c.trim());
              })
              .map(function (c, ci) {
                return {
                  _i: ci,
                  nodes: spansToNodes(collectSpans(c.trim()), "")
                };
              })
          });
        }
        i += 1;
      }
      blocks.push({ t: "table", rows: rows, _i: blocks.length });
      continue;
    }

    // 列表（连续行归组）
    if (isListItem(line)) {
      var ordered = /^\s*\d+[.、)]/.test(line);
      var items = [];
      while (i < lines.length && isListItem(lines[i])) {
        var li = /^(\s*)([-*+]|\d+[.、)])(\s+)(.*)$/.exec(lines[i]);
        var spans = collectSpans(li[4]);
        items.push({ nodes: spansToNodes(spans, ""), _i: items.length });
        i += 1;
      }
      blocks.push({ t: "list", ordered: ordered, items: items, _i: blocks.length });
      continue;
    }

    // 段落：连续非空、非块级起始的行
    var pbuf = [trimmed];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isListItem(lines[i]) &&
      lines[i].trim().indexOf("#") !== 0 &&
      lines[i].trim().indexOf(">") !== 0 &&
      lines[i].trim().indexOf("```") !== 0 &&
      !isTableStart(lines, i) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
    ) {
      pbuf.push(lines[i].trim());
      i += 1;
    }
    pushInline("p", pbuf.join(" "), "");
  }

  return { blocks: blocks, links: links };
}

/* 提取纯文本（气泡摘要用）：去标记，保留代码与文字。
 * 粗体剥离用惰性匹配容忍内部的 *（嵌套斜体）：[^*]+ 会让「**a *b* c**」
 * 整体剥不掉，外层星号以字面残留（与 tokenize 粗体分支同一教训）。 */
function plain(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, function (m) {
      return m.replace(/```\w*\n?/g, "");
    })
    .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "");
}

module.exports = { parse: parse, plain: plain };
