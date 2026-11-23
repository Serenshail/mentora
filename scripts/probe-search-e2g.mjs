/* 决定性实验：
 * E) 单词查询「卡尼曼」——若正常，说明多词查询被降级
 * F) 同查询用 + 号编码
 * G) 已知存在的具体图书条目「影响力 罗伯特西奥迪尼」（无间隔号）
 */
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

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
    out.push({ t: a[2].replace(/<[^>]+>/g, "").trim().slice(0, 55), u: href.slice(0, 75) });
  }
  return out;
}

async function t(label, q) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN&count=10`;
  const res = await fetch(url, { headers: { ...HEADERS, Referer: "https://cn.bing.com/" }, signal: AbortSignal.timeout(8000) });
  const html = await res.text();
  const parsed = parseBing(html);
  console.log(`\n[${label}] q="${q}" → ${parsed.length} 条`);
  parsed.slice(0, 4).forEach((r, i) => console.log(`   [${i + 1}] ${r.t} → ${r.u}`));
}

await t("E1 单词", "卡尼曼");
await t("E2 单词长词", "思考快与慢");
await t("F1 加号编码", "思考 快与慢 卡尼曼");
await t("G1 无间隔号", "影响力 罗伯特西奥迪尼 豆瓣");
