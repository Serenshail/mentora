/* 生成小程序 tabBar 图标（5 图 × 常态/选中 = 10 张 96px PNG）。
 * 零依赖：手写 PNG 编码（zlib deflate + CRC32）+ 简单光栅化（3x 超采样抗锯齿）。
 * 用法：node scripts/gen-mp-icons.mjs  （输出到 miniprogram/images/tab/） */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 96;
const SS = 3; // 超采样
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "miniprogram", "images", "tab");

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------- 光栅化（有符号距离近似：area 覆盖率 → alpha） ---------- */
function raster(shapes, color) {
  const big = SIZE * SS;
  const cov = new Float32Array(SIZE * SIZE);
  const hit = new Uint8Array(big * big);
  for (const s of shapes) {
    const [x0, y0, x1, y1] = s.bounds;
    for (let y = Math.max(0, Math.floor(y0 * SS)); y < Math.min(big, Math.ceil(y1 * SS)); y++) {
      for (let x = Math.max(0, Math.floor(x0 * SS)); x < Math.min(big, Math.ceil(x1 * SS)); x++) {
        if (s.test(x / SS, y / SS)) hit[y * big + x] = 1;
      }
    }
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let n = 0;
      for (let dy = 0; dy < SS; dy++)
        for (let dx = 0; dx < SS; dx++) if (hit[(y * SS + dy) * big + x * SS + dx]) n++;
      cov[y * SIZE + x] = n / (SS * SS);
    }
  }
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const [r, g, b] = color;
  for (let i = 0; i < SIZE * SIZE; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = Math.round(cov[i] * 255);
  }
  return rgba;
}

/* ---------- 形状库（96 视框，线宽≈7） ---------- */
const stroke = 7;
const inRect = (x, y, w, h) => (px, py) => px >= x && px <= x + w && py >= y && py <= y + h;
const roundRect = (x, y, w, h, r) => (px, py) => {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const dx = Math.max(x + r - px, px - (x + w - r), 0);
  const dy = Math.max(y + r - py, py - (y + h - r), 0);
  return dx * dx + dy * dy <= r * r;
};
const ring = (cx, cy, r) => (px, py) => {
  const d = Math.hypot(px - cx, py - cy);
  return d >= r - stroke / 2 && d <= r + stroke / 2;
};
const disc = (cx, cy, r) => (px, py) => Math.hypot(px - cx, py - cy) <= r;
const seg = (x0, y0, x1, y1) => (px, py) => {
  const vx = x1 - x0, vy = y1 - y0;
  const L2 = vx * vx + vy * vy || 1;
  let t = ((px - x0) * vx + (py - y0) * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * vx), py - (y0 + t * vy)) <= stroke / 2;
};
const tri = (ax, ay, bx, by, cx, cy) => (px, py) => {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const u = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
};
const union = (...tests) => (px, py) => tests.some((t) => t(px, py));
const minus = (a, b) => (px, py) => a(px, py) && !b(px, py);

/* ---- 五个图形（填充式，简洁几何） ---- */
const ICONS = {
  // 总览：仪表盘 = 圆角方框 + 内部两块
  home: () => [
    { bounds: [14, 14, 82, 82], test: minus(roundRect(14, 14, 68, 68, 16), roundRect(21, 21, 54, 54, 11)) },
    { bounds: [26, 26, 46, 46], test: roundRect(26, 26, 20, 20, 5) },
    { bounds: [52, 26, 72, 42], test: roundRect(52, 26, 20, 16, 5) },
    { bounds: [26, 52, 46, 72], test: roundRect(26, 52, 20, 20, 5) },
    { bounds: [52, 52, 72, 72], test: roundRect(52, 52, 20, 20, 5) },
  ],
  // 学习：毕业帽 = 菱形帽 + 帽穗
  learn: () => [
    { bounds: [8, 28, 88, 56], test: union(tri(48, 26, 90, 44, 48, 60), tri(48, 26, 6, 44, 48, 60)) },
    { bounds: [28, 52, 68, 70], test: union(
        minus(roundRect(28, 52, 40, 18, 6), roundRect(35, 52, 26, 12, 3)),
      ) },
    { bounds: [82, 44, 88, 62], test: union(seg(84, 44, 84, 58), disc(84, 62, 4)) },
  ],
  // 大脑：神经节点 = 三圆相连
  brain: () => [
    { bounds: [18, 22, 78, 74], test: union(
        minus(disc(38, 42, 18), disc(38, 42, 18 - stroke)),
        minus(disc(62, 38, 14), disc(62, 38, 14 - stroke)),
        minus(disc(58, 62, 15), disc(58, 62, 15 - stroke)),
        seg(50, 45, 54, 55),
      ) },
  ],
  // 读书：打开的书 = 两个对称页
  read: () => [
    { bounds: [12, 26, 84, 72], test: union(
        minus(roundRect(12, 28, 36, 42, 6), roundRect(18, 34, 24, 30, 4)),
        minus(roundRect(48, 28, 36, 42, 6), roundRect(54, 34, 24, 30, 4)),
      ) },
    { bounds: [46, 28, 50, 70], test: inRect(46, 28, 4, 42) },
  ],
  // 我的：人 = 头 + 肩弧
  me: () => [
    { bounds: [32, 16, 64, 48], test: minus(disc(48, 32, 16), disc(48, 32, 16 - stroke)) },
    { bounds: [18, 54, 78, 82], test: union(
        minus(disc(48, 92, 34), disc(48, 92, 34 - stroke)),
      ) },
  ],
};

const GRAY = [134, 134, 139]; // #86868b
const ACCENT = [91, 84, 230]; // #5b54e6

mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries(ICONS)) {
  writeFileSync(join(OUT, `${name}.png`), encodePNG(SIZE, SIZE, raster(make(), GRAY)));
  writeFileSync(join(OUT, `${name}-on.png`), encodePNG(SIZE, SIZE, raster(make(), ACCENT)));
  console.log("ok", name);
}
console.log("done →", OUT);
