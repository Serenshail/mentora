/* 对照实验：定位 Bing 反爬降级的触发条件与可用替代通道
 * A) cn.bing.com vs www.bing.com
 * B) 带 cookie（模拟二次访问）
 * C) DDG html 兜底是否可用
 * D) Bing 强制国际版参数（ensearch=1 / mkt=en-US）
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const Q = "思考 快与慢 卡尼曼 豆瓣";

function parseBing(html) {
  const out = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(m[0]);
    if (!a) continue;
    let href = a[1];
    const uParam = /[?&]u=a1([^&]+)/.exec(href);
    if (uParam && /^https?:\/\//i.test(Buffer.from(uParam[1], "base64").toString("utf8"))) {
      href = Buffer.from(uParam[1], "base64").toString("utf8");
    }
    if (!/^https?:\/\//i.test(href)) continue;
    out.push({ t: a[2].replace(/<[^>]+>/g, "").trim().slice(0, 50), u: href.slice(0, 80) });
  }
  return out;
}

async function tryBing(label, url, extraHeaders = {}) {
  try {
    const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const parsed = parseBing(html);
    console.log(`\n[${label}] status=${res.status} b_algo=${parsed.length}`);
    parsed.slice(0, 4).forEach((r, i) => console.log(`   [${i + 1}] ${r.t} → ${r.u}`));
    if (parsed.length === 0) {
      const cap = /<title>([^<]*)<\/title>/i.exec(html);
      console.log("   (无 b_algo) title:", cap ? cap[1].slice(0, 60) : "?");
    }
  } catch (e) {
    console.log(`\n[${label}] 异常: ${String(e).slice(0, 90)}`);
  }
}

async function tryDDG() {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(Q)}`, {
      headers: { ...HEADERS, Referer: "https://www.google.com/" },
      signal: AbortSignal.timeout(8000),
    });
    const html = (await res.text()).slice(0, 400_000);
    const out = [];
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of html.matchAll(linkRe)) {
      let href = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (!/^https?:\/\//i.test(href)) continue;
      out.push({ t: m[2].replace(/<[^>]+>/g, "").trim().slice(0, 50), u: href.slice(0, 80) });
      if (out.length >= 5) break;
    }
    console.log(`\n[DDG] status=${res.status} results=${out.length}`);
    out.forEach((r, i) => console.log(`   [${i + 1}] ${r.t} → ${r.u}`));
    if (out.length === 0) {
      const cap = /<title>([^<]*)<\/title>/i.exec(html);
      console.log("   (无结果) title:", cap ? cap[1].slice(0, 80) : "?", "htmlLen:", html.length);
    }
  } catch (e) {
    console.log(`\n[DDG] 异常: ${String(e).slice(0, 90)}`);
  }
}

await tryBing("A1 cn.bing 基线", `https://cn.bing.com/search?q=${encodeURIComponent(Q)}&mkt=zh-CN&count=10`);
await tryBing("A2 www.bing 基线", `https://www.bing.com/search?q=${encodeURIComponent(Q)}&mkt=zh-CN&count=10`);
await tryBing("B1 cn.bing 带cookie", `https://cn.bing.com/search?q=${encodeURIComponent(Q)}&mkt=zh-CN&count=10`, {
  Cookie: "SRCHHPGUSR=SRCHLANG=zh-Hans; _EDGE_S=mkt=zh-cn; _EDGE_CD=m=zh-cn",
});
await tryBing("D1 www.bing ensearch", `https://www.bing.com/search?q=${encodeURIComponent(Q)}&ensearch=1&count=10`);
await tryDDG();
