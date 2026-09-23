/* ============================================================
 * PopText — 手写体文字特效脚本 v4(零依赖)
 *
 * 核心行为:
 *   1. type():文本按字素簇切分,逐字母弹入(一次性,带光标);
 *   2. 打完即静止,不自动循环、不自动消除;
 *   3. 鼠标划过字母:该字母**跳起并变成一个 3D 甜品图标**——
 *      形状与字母呼应的优先(c→牛角包、o→甜甜圈、l→巧克力条、
 *      m→纸杯蛋糕、w→糖果…),其余字母从甜品池随机;
 *      图标用过冲放大取代字形,悬浮呼吸摇摆,再缩小恢复字母;
 *   4. 打字落位时也会来一次更短的变形(打字过程中也产生);
 *   5. 图标为 Microsoft Fluent 3D emoji(MIT),透明底 PNG,
 *      放在 EMOJI_BASE 目录(默认 ./emoji/,可用 setEmojiBase 改);
 *      图片缺失时自动退回 CSS 糖果气球字。
 *
 * 用法:
 *   PopText.type(el, "任意文字", { step: 85 })
 *   PopText.arm(container)   // 挂鼠标划过变形(用 data-text 时自动)
 *   PopText.setEmojiBase("static/emoji/")
 *
 * API:
 *   PopText.type(el, text[, opts])   → Promise,打字入场
 *   PopText.balloon(chEl[, dur])     → 手动触发变形(默认 900ms)
 *   PopText.hop(chEl)                → balloon 的兼容别名
 *   PopText.arm(container)           → pointerover 委托
 *   PopText.setEmojiBase(path)       → 图标资源目录
 *   opts: { step=85 每字间隔ms, startDelay=0, cursor=true }
 * ============================================================ */
(function (global) {
  'use strict';

  /* URL 带 #slow 时整体放慢 4 倍,便于肉眼观察/截图 */
  var TM = (global.location && global.location.hash === '#slow') ? 4 : 1;
  var reduceMotion = false;
  try { reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  /* ---------- 字母 → 物件 的固定映射(逐帧辨识自原视频) ----------
   * 图片映射:视频抠出的物件 + GitHub Fluent 3D emoji(MIT)
   *   o→甜甜圈(视频确认)  e→复古邮票  l→绿藤蔓  c→蜷成C形的橘猫
   *   r→毛毛虫(Fluent bug) a→棒球(Fluent baseball)
   * 字形气球映射:字母本身变成糖果/气球质感的自己
   *   w→彩条糖果 W  m→粉色气球 m  t→紫粉气球 T
   * 其余字母:随机糖果气球(视频未展示,属合理外推)
   * ------------------------------------------------------------- */
  var EMOJI_BASE = 'emoji/';
  /* 可选:页面里预置 window.POPTEXT_EMOJI_DATA = { 名字: dataURI } 即可内嵌图标,免掉 emoji 目录 */
  var EMOJI_DATA = global.POPTEXT_EMOJI_DATA || null;
  var IMG_FOR = {
    a: 'baseball', A: 'baseball',
    b: 'balloon',  B: 'balloon',
    c: 'cat-c',    C: 'cat-c',
    d: 'dog',      D: 'dog',
    e: 'stamp',    E: 'stamp',
    f: 'fries',    F: 'fries',
    g: 'gift',     G: 'gift',
    h: 'heart',    H: 'heart',
    i: 'icecream', I: 'icecream',
    k: 'key',      K: 'key',
    l: 'vine',     L: 'vine',
    n: 'notebook', N: 'notebook',
    o: 'doughnut', O: 'doughnut', '0': 'doughnut',
    p: 'pizza',    P: 'pizza',
    q: 'lollipop', Q: 'lollipop',
    r: 'bug',      R: 'bug',
    s: 'soccer',   S: 'soccer',
    u: 'umbrella', U: 'umbrella',
    v: 'violin',   V: 'violin',
    y: 'yarn',     Y: 'yarn',
    z: 'zzz',      Z: 'zzz',
    '1': 'candle',
    '8': 'snowman',
    '9': 'balloon'
  };

  function setEmojiBase(path) { EMOJI_BASE = String(path).replace(/\/?$/, '/'); }

  /* CSS 糖果气球(字形气球 + 未映射字母的默认形态) */
  var STYLE_FOR = {
    stripes: { bg: 'repeating-linear-gradient(78deg,#ff5f7e 0 .09em,#ffffff .09em .18em,#3ecf8e .18em .27em)', stroke: '#d34a63', glow: 'rgba(255,120,150,.55)' },
    pink:    { bg: 'linear-gradient(135deg,#ffd3e0 8%,#ff7fa9 55%,#f0568f 96%)', stroke: '#d34a70', glow: 'rgba(255,127,169,.55)' },
    violet:  { bg: 'linear-gradient(135deg,#e8d5ff 8%,#b98af5 55%,#8f5bd8 96%)', stroke: '#7444b8', glow: 'rgba(185,138,245,.55)' },
    orange:  { bg: 'linear-gradient(135deg,#ffe0c2 8%,#f59e4c 55%,#d97721 96%)', stroke: '#b45f14', glow: 'rgba(245,158,76,.55)' },
    sky:     { bg: 'linear-gradient(135deg,#d0f0ff 8%,#4cc3f0 55%,#2196c9 96%)', stroke: '#1a7ba8', glow: 'rgba(76,195,240,.55)' },
    mint:    { bg: 'linear-gradient(135deg,#d8ffe9 8%,#3ecf8e 55%,#1f9e63 96%)', stroke: '#178a55', glow: 'rgba(62,207,142,.55)' },
    lemon:   { bg: 'linear-gradient(135deg,#fff3b0 8%,#ffc93c 55%,#e0a800 96%)', stroke: '#c78f00', glow: 'rgba(255,201,60,.55)' },
    amber:   { bg: 'linear-gradient(135deg,#ffe9c2 8%,#f5a623 55%,#c97e0f 96%)', stroke: '#a3660a', glow: 'rgba(245,166,35,.55)' },
    grape:   { bg: 'linear-gradient(135deg,#ecd9ff 8%,#a86ee8 55%,#7e4bc0 96%)', stroke: '#68399f', glow: 'rgba(168,110,232,.55)' },
    rose:    { bg: 'linear-gradient(135deg,#ffdde8 8%,#f06292 55%,#c2185b 96%)', stroke: '#a3154b', glow: 'rgba(240,98,146,.55)' },
    teal:    { bg: 'linear-gradient(135deg,#ccf5f0 8%,#26b5a6 55%,#12897c 96%)', stroke: '#0d6e63', glow: 'rgba(38,181,166,.55)' }
  };
  var CSS_FOR = {
    w: 'stripes', W: 'stripes',
    m: 'pink',    M: 'pink',
    t: 'violet',  T: 'violet',
    j: 'orange',  J: 'orange',
    x: 'sky',     X: 'sky',
    '2': 'mint', '3': 'lemon', '4': 'amber',
    '5': 'grape', '6': 'rose', '7': 'teal'
  };
  var PALETTES = [
    { bg: 'linear-gradient(135deg,#ffd3e0 8%,#ff5f9e 55%,#e0407f 96%)', stroke: '#c22e6b', glow: 'rgba(255,95,158,.55)' },
    { bg: 'linear-gradient(135deg,#fff3b0 8%,#ffc93c 55%,#e0a800 96%)', stroke: '#c78f00', glow: 'rgba(255,201,60,.55)' },
    { bg: 'linear-gradient(135deg,#d0e4ff 8%,#5a8dee 55%,#3a6bd0 96%)', stroke: '#2f57b3', glow: 'rgba(90,141,238,.55)' },
    { bg: 'linear-gradient(135deg,#ecd9ff 8%,#a86ee8 55%,#7e4bc0 96%)', stroke: '#68399f', glow: 'rgba(168,110,232,.55)' }
  ];
  var lastPick = -1;
  function pickPalette() {
    var i;
    do { i = Math.floor(Math.random() * PALETTES.length); } while (i === lastPick && PALETTES.length > 1);
    lastPick = i;
    return PALETTES[i];
  }

  
  /* 按字素簇切分:emoji、组合字符不会被拆碎 */
  function splitGraphemes(str) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      var seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
      return Array.from(seg.segment(str), function (s) { return s.segment; });
    }
    return Array.from(str);
  }
  function makeCh(char) {
    var s = document.createElement('span');
    s.className = 'pt-ch';
    var g = document.createElement('span');
    g.className = 'pt-glyph';
    g.textContent = char;
    s.appendChild(g);
    return s;
  }

  function makeCursor() {
    var c = document.createElement('span');
    c.className = 'pt-cursor';
    return c;
  }

  /* CSS 糖果气球字形（未映射字母 / 图片加载失败时的兜底形态） */
  function cssBalloonSpan(ch0) {
    var s = document.createElement('span');
    s.textContent = ch0;
    var style = STYLE_FOR[CSS_FOR[ch0]] || pickPalette();
    s.style.backgroundImage = style.bg;
    s.style.webkitBackgroundClip = 'text';
    s.style.backgroundClip = 'text';
    s.style.color = 'transparent';
    s.style.webkitTextStroke = '.085em ' + style.stroke;
    s.style.filter = 'drop-shadow(0 .04em .07em ' + style.glow + ')';
    return s;
  }

  /* 打字前预加载本段文字用到的 emoji：否则入场那 620ms 里图片没解码完,
   * 该字母的入场变形会被跳过——表现为"只有 M/T(CSS 气球)会动,其他字母没特效"。 */
  function preload(chars) {
    for (var i = 0; i < chars.length; i++) {
      var key = IMG_FOR[chars[i].toLowerCase()];
      if (!key) continue;
      var im = new Image();
      im.src = (EMOJI_DATA && EMOJI_DATA[key]) ? EMOJI_DATA[key] : EMOJI_BASE + key + '.png';
    }
  }

  /* ---------- 变形:字母跳起变成对应图标,悬浮后缩回 ----------
   * 设计原则(Apple HIG / Material 3):
   *   一次交互只有一个主运动(交换本身);图标光学尺寸≈大写高度;
   *   入场减速曲线、悬浮极克制、出场快速收敛;升起时投影加深(深度感)。
   * dur 默认 800ms:跳起 24% → 悬浮 42% → 缩回 34% */
  function balloon(ch, dur) {
    dur = (dur || 800) * TM;
    if (!ch || !ch.classList || !ch.classList.contains('pt-ch')) return;
    if (!ch.classList.contains('pt-settled')) return;
    if (reduceMotion) return;
    var glyph = ch.querySelector('.pt-glyph');
    if (!glyph) return;

    /* 重入:作废上一次变形,清掉旧图层 */
    ch.__ptTok = (ch.__ptTok || 0) + 1;
    var my = ch.__ptTok;
    var old = ch.querySelector('.pt-bb');
    if (old) old.remove();

    var ch0 = glyph.textContent;
    /* t/T 专属：把图标横向校正到手写体 t 的墨迹正中。
       脚本体的墨迹普遍比字盒中心偏右约 0.07em,宽字母看不出来,
       但 t 只有 0.28em 宽——按字盒居中会让图标整体歪到左邻 n 上。
       校正后图标恰好落在 t 本身的表面;其余字母维持原样(偏差 0)。 */
    var dxEm = 0;
    if (ch0 === 't' || ch0 === 'T') {
      try {
        var cs = getComputedStyle(ch);
        var fs = parseFloat(cs.fontSize) || 16;
        var cv = balloon._cv || (balloon._cv = document.createElement('canvas'));
        var c2 = cv.getContext('2d');
        c2.font = fs + 'px ' + cs.fontFamily;
        var mt = c2.measureText(ch0);
        if (mt && mt.actualBoundingBoxRight != null) {
          var gl = glyph.getBoundingClientRect();
          var chr = ch.getBoundingClientRect();
          /* 墨迹中心 = 字形盒左缘 + (右扩展-左扩展)/2 */
          var inkC = gl.left + (mt.actualBoundingBoxRight - mt.actualBoundingBoxLeft) / 2;
          dxEm = (inkC - (chr.left + chr.width / 2)) / fs;
        }
      } catch (e) { dxEm = 0; }
    }
    var bb, isImg = false;
    if (IMG_FOR[ch0.toLowerCase()]) {
      bb = document.createElement('img');
      bb.src = (EMOJI_DATA && EMOJI_DATA[IMG_FOR[ch0.toLowerCase()]]) ? EMOJI_DATA[IMG_FOR[ch0.toLowerCase()]] : EMOJI_BASE + IMG_FOR[ch0.toLowerCase()] + '.png';
      isImg = true;
    } else {
      bb = cssBalloonSpan(ch0);
    }
      bb.className = 'pt-bb';
      bb.alt = '';
      bb.draggable = false;
      /* t/T 的气球文字默认渲染在盒子左缘（墨迹因此整体压到左邻 n 上）——
         让它在盒内居中,配合下面的 translateX 校正,恰好盖在 t 本身上 */
      if (ch0 === 't' || ch0 === 'T') bb.style.textAlign = 'center';
      /* 图片加载失败 → 退回 CSS 糖果气球（脚本头注释承诺的兜底,此前未实现,
         导致缺图字母"没有特效"） */
      bb.onerror = function () {
        if (bb.__ptFb) return;
        bb.__ptFb = 1;
        var fb = cssBalloonSpan(ch0);
        fb.className = 'pt-bb';
        fb.draggable = false;
        if (ch0 === 't' || ch0 === 'T') fb.style.textAlign = 'center';
        bb.replaceWith(fb);
        bb = fb; isImg = false; started = true;
      };
      ch.appendChild(bb);

    /* 交换瞬间的小光点(只闪一次,细微) */
    function spark() {
      var colors = ['#ffffff', '#ffd76e', '#ff92af', '#7fe0bd'];
      for (var i = 0; i < 5; i++) {
        var s = document.createElement('span');
        s.className = 'pt-spark';
        var a = (i / 5) * 6.283 + Math.random() * 0.8;
        var dist = 11 + Math.random() * 8;
        s.style.setProperty('--dx', (Math.cos(a) * dist).toFixed(1) + 'px');
        s.style.setProperty('--dy', (Math.sin(a) * dist - 5).toFixed(1) + 'px');
        s.style.background = colors[i % 4];
        ch.appendChild(s);
        (function (el) { setTimeout(function () { el.remove(); }, 520); })(s);
      }
    }
    var sparked = false;

    var started = isImg ? false : true;
    bb.onload = function () { started = true; };

    function frame(now) {
      if (ch.__ptTok !== my) return;           /* 已被新变形取代 */
      var t = (now - start) / dur;
      if (t >= 1) {                            /* 收场:完全恢复 */
        bb.remove();
        glyph.style.opacity = '';
        glyph.style.transform = '';
        ch.style.transform = '';
        return;
      }
      if (isImg && t >= 0.06 && !started && !bb.complete) {
        requestAnimationFrame(frame);          /* 图标未就绪:等待,不推进 */
        return;
      }
      var scale, bbOp, gOp, rise, wob;
      if (t < 0.24) {                          /* 跳起:减速曲线入场,轻微过冲 */
        var k = t / 0.24;
        var e = 1 - Math.pow(1 - k, 3);
        scale = 0.55 + 0.6 * e;                /* 0.55 → 1.15 */
        bbOp = Math.min(1, k * 1.8);
        gOp = 1 - Math.min(1, k * 1.5);
        rise = -0.06 * e;
        wob = 2.2 * e * Math.sin(k * 6.283);
        if (!sparked && k > 0.55) { spark(); sparked = true; }
      } else if (t < 0.66) {                   /* 悬浮:极克制的呼吸 + 摇摆 */
        var k2 = (t - 0.24) / 0.42;
        scale = 1.15 + 0.025 * Math.sin(k2 * Math.PI * 2);
        bbOp = 1; gOp = 0; rise = -0.06;
        wob = 1.2 * Math.sin(k2 * Math.PI * 3);
      } else {                                 /* 缩回:快速收敛 */
        var k3 = (t - 0.66) / 0.34;
        var k3e = k3 * k3;
        scale = 1.15 - 0.6 * k3e;
        bbOp = 1 - k3e;
        gOp = k3;
        rise = -0.06 * (1 - k3);
        wob = 1.2 * (1 - k3);
      }
      ch.style.transform = 'translateY(' + rise.toFixed(3) + 'em)';
      glyph.style.opacity = gOp.toFixed(2);
      glyph.style.transform = gOp > 0 ? 'scale(' + (1 - 0.08 * (1 - gOp)).toFixed(3) + ')' : '';
      bb.style.opacity = bbOp.toFixed(2);
      bb.style.transform =
        'translate(-50%,-50%) translateX(' + dxEm.toFixed(3) + 'em)' +
        ' translateY(' + (rise * 0.45).toFixed(3) + 'em)' +
        ' rotate(' + wob.toFixed(1) + 'deg) scale(' + scale.toFixed(3) + ')';
      bb.style.filter = 'drop-shadow(0 ' + (0.04 + 0.05 * (-rise / 0.06)).toFixed(2) + 'em ' +
        (0.06 + 0.06 * (-rise / 0.06)).toFixed(2) + 'em rgba(0,0,0,' + (0.24 + 0.12 * (-rise / 0.06)).toFixed(2) + '))';
      requestAnimationFrame(frame);
    }
    var start = performance.now();
    requestAnimationFrame(frame);
  }

  /* 兼容旧名 */
  function hop(ch) { balloon(ch, 900); }

  /* ---------- 打字入场 ---------- */
  function type(el, text, opts) {
    opts = opts || {};
    var step = opts.step != null ? opts.step : 85;
    var startDelay = opts.startDelay || 0;
    var useCursor = opts.cursor !== false;
    var chars = splitGraphemes(String(text));
    preload(chars); // 入场前预热 emoji,保证每个字母的入场变形都不被"等图"跳过
    el.textContent = '';
    var cursor = useCursor ? makeCursor() : null;
    if (cursor) el.appendChild(cursor);
    return new Promise(function (resolve) {
      setTimeout(function () {
        var i = 0;
        (function next() {
          if (i >= chars.length) {
            if (cursor) cursor.classList.add('pt-done'); /* 打完光标消失,页面静止 */
            resolve();
            return;
          }
          var ch = makeCh(chars[i]);
          ch.classList.add('pt-in');
          el.insertBefore(ch, cursor);
          /* 落位后来一次更短的变形(打字过程中也产生该效果) */
          setTimeout(function () {
            ch.classList.add('pt-settled');
            balloon(ch, 620);
          }, 560);
          i++;
          setTimeout(next, step);
        })();
      }, startDelay);
    });
  }

  /* ---------- 容器级 pointerover 委托:划过已入场字母即变形 ---------- */
  function arm(container) {
    container.addEventListener('pointerover', function (e) {
      var ch = e.target && e.target.closest ? e.target.closest('.pt-ch') : null;
      if (ch && ch.classList.contains('pt-settled')) balloon(ch, 900);
    });
  }

  /* 自动初始化:所有带 data-text 的 .pop-text 容器 */
  function auto() {
    var nodes = document.querySelectorAll('.pop-text[data-text]');
    Array.prototype.forEach.call(nodes, function (node) {
      arm(node);
      var idx = Number(node.getAttribute('data-delay') || 0);
      type(node, node.getAttribute('data-text'), { startDelay: idx });
    });
  }

  /* #slow 时放慢 CSS 打字动画(balloon 的 JS 时长已按 TM 放慢) */
  if (TM !== 1) {
    var st = document.createElement('style');
    st.textContent = '.pt-ch{animation-duration:' + (0.55 * TM) + 's !important}';
    var applySt = function () { document.head.appendChild(st); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applySt);
    else applySt();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    auto();
  }

  global.PopText = {
    type: type,
    balloon: balloon,
    hop: hop,
    arm: arm,
    setEmojiBase: setEmojiBase,
    splitGraphemes: splitGraphemes
  };
})(window);
