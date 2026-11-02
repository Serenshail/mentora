/* 生成小程序品牌字体样式。
 * 与网页版用同一份现成资产：public/fonts/great-vibes.woff2（OFL 许可，自托管），
 * 品牌写法保持一致 —— <view class="font-brand">Mentora</view>。
 *
 * 为什么 base64 内联：小程序 WXSS 引用不了包内的本地字体文件，
 * wx.loadFontFace 又依赖网络域名白名单（且大陆真机连不上 Vercel）；
 * 内联后离线可用，开发者工具与真机行为一致（约 57KB，主包配额内）。
 *
 * 用法：node scripts/gen-mp-font.mjs   （字体文件更新后重跑，勿手改 base64） */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "public", "fonts", "great-vibes.woff2");
const OUT = join(here, "..", "miniprogram", "styles", "font-brand.wxss");

const b64 = readFileSync(SRC).toString("base64");

/* 类名与规则逐字对齐网页 globals.css 的 .font-brand（字体族 + 正字距） */
const css = `/* ============================================================
 * 品牌字体：Great Vibes 手写体 —— 与网页版同一份字体文件、同一个类名。
 * 由 scripts/gen-mp-font.mjs 生成；字体更新后重跑，不要手改 base64。
 * ============================================================ */
@font-face {
  font-family: "Great Vibes";
  font-style: normal;
  font-weight: 400;
  src: url("data:font/woff2;base64,${b64}") format("woff2");
}
.font-brand {
  font-family: "Great Vibes", cursive;
  letter-spacing: 0.01em;
}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, css);
console.log("ok →", OUT, `${(css.length / 1024).toFixed(1)} KB`);
