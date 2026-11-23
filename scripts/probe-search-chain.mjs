/* 搜索链路逐层探针（独立脚本，不改产品代码）
 * 层1：Bing 原始 HTML —— b_algo 块里到底是什么
 * 层2：解析器输出 —— 与 /api/search 实际返回对照
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const queries = [
  "影响力 罗伯特·西奥迪尼 豆瓣",
  "影响力 西奥迪尼",
  "思考快与慢 卡尼曼",
];

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function parseBing(html) {
  const out = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!a) continue;
    let href = a[1];
    const uParam = /[?&]u=a1([^&]+)/.exec(href);
    if (uParam && /^https?:\/\//i.test(Buffer.from(uParam[1], "base64").toString("utf8"))) {
      href = Buffer.from(uParam[1], "base64").toString("utf8");
    }
    if (!/^https?:\/\//i.test(href)) continue;
    const title = decodeEntities(a[2].replace(/<[^>]+>/g, "")).trim();
    out.push({ title: title.slice(0, 60), url: href.slice(0, 100) });
  }
  return out;
}

for (const q of queries) {
  console.log(`\n===== 查询: ${q} =====`);
  for (const host of ["https://cn.bing.com", "https://www.bing.com"]) {
    const url = `${host}/search?q=${encodeURIComponent(q)}&mkt=zh-CN&count=10`;
    try {
      const res = await fetch(url, { headers: { ...BROWSER_HEADERS, Referer: `${host}/` }, signal: AbortSignal.timeout(8000) });
      const html = await res.text();
      const hasAlgo = html.includes('class="b_algo"');
      const algoCount = (html.match(/<li class="b_algo"/g) || []).length;
      console.log(`-- ${host} status=${res.status} b_algo块=${algoCount} finalUrl=${res.url.slice(0, 90)}`);
      if (hasAlgo) {
        const parsed = parseBing(html);
        parsed.slice(0, 6).forEach((r, i) => console.log(`   [${i + 1}] ${r.title}  →  ${r.url}`));
        /* 检查是否是「没有找到结果」页 */
        const noResult = /没有找到|no results|找不到与/.test(html.slice(0, 20000));
        console.log(`   无结果提示=${noResult}`);
        /* 保存原始 HTML 供人工复核 */
        const fname = `docs/evidence/search-probe/bing-${host.includes("cn") ? "cn" : "www"}-${q.length}.html`;
        (await import("node:fs")).mkdirSync("docs/evidence/search-probe", { recursive: true });
        (await import("node:fs")).writeFileSync(fname, html);
        console.log(`   HTML已存: ${fname} (${html.length} 字节)`);
        break; // 第一个 host 有 b_algo 就够了
      }
    } catch (e) {
      console.log(`-- ${host} 异常: ${String(e).slice(0, 80)}`);
    }
  }
}
