import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseImageDimensions } from "../image-dimensions";

/* ============ compressImage 解码前尺寸防护（回归锁） ============
 * 背景：createImageBitmap(file) 按原始尺寸解码，2 亿像素全景图 ≈ 800MB 位图内存，
 * 移动端 Safari/Chrome 可能因位图分配失败直接杀标签页（OOM 崩溃后整页运行态全丢），
 * JS catch 接不住那种死法。修复：先按文件头读尺寸（只解析头，不触发解码），
 * 超像素上限直接拒绝；拿得到尺寸时把目标缩放传给 createImageBitmap 的 resize 选项，
 * 解码阶段就缩小。头解析是纯函数直接单测；解码前的守卫本身用静态扫描锁。 */

const HOME = readFileSync(join(process.cwd(), "src/components/agent-home.tsx"), "utf8");

const u8 = (...bytes: number[]) => new Uint8Array(bytes);
const le = (v: number, n: number) => Array.from({ length: n }, (_, i) => (Math.floor(v / 256 ** i) % 256));
const be = (v: number, n: number) => Array.from({ length: n }, (_, i) => (Math.floor(v / 256 ** (n - 1 - i)) % 256));

function png(width: number, height: number): Uint8Array {
  // 8 字节签名 + IHDR 长度(13) + "IHDR" + 宽高大端
  return u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be(width, 4), ...be(height, 4), 8, 6, 0, 0, 0);
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI + APP1（38 字节占位负载，模拟 EXIF 排在 SOF 前）+ SOF0 + EOI
  const sof = [8, ...be(height, 2), ...be(width, 2), 3, 1, 0x22, 0, 2, 1, 0x11, 1, 1, 0x11]; // len=17
  return u8(0xff, 0xd8, 0xff, 0xe1, ...be(40, 2), ...new Array(38).fill(0x41), 0xff, 0xc0, ...be(17, 2), ...sof, 0xff, 0xd9);
}

function gif(width: number, height: number): Uint8Array {
  return u8(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le(width, 2), ...le(height, 2), 0, 0, 0);
}

function riffChunk(fourcc: string, payload: number[]): Uint8Array {
  const body = [0x57, 0x45, 0x42, 0x50, ...fourcc.split("").map((c) => c.charCodeAt(0)), ...le(payload.length, 4), ...payload];
  return u8(0x52, 0x49, 0x46, 0x46, ...le(body.length, 4), ...body);
}

const webpVp8x = (w: number, h: number) => riffChunk("VP8X", [0x10, 0, 0, 0, ...le(w - 1, 3), ...le(h - 1, 3)]);
const webpVp8 = (w: number, h: number) => riffChunk("VP8 ", [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le(w, 2), ...le(h, 2)]);
const webpVp8l = (w: number, h: number) => riffChunk("VP8L", [0x2f, ...le(((h - 1) << 14) | (w - 1), 4)]);

describe("parseImageDimensions：各格式的文件头解析", () => {
  it("PNG（大端 IHDR）", () => {
    expect(parseImageDimensions(png(800, 600))).toEqual({ width: 800, height: 600 });
    expect(parseImageDimensions(png(14000, 2000))).toEqual({ width: 14000, height: 2000 });
  });

  it("JPEG（SOF 排在较大的 APP1 之后）", () => {
    expect(parseImageDimensions(jpeg(1200, 900))).toEqual({ width: 1200, height: 900 });
    expect(parseImageDimensions(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it("GIF（小端）", () => {
    expect(parseImageDimensions(gif(320, 240))).toEqual({ width: 320, height: 240 });
  });

  it("WebP 三种子格式（VP8X / VP8 / VP8L）", () => {
    expect(parseImageDimensions(webpVp8x(640, 480))).toEqual({ width: 640, height: 480 });
    expect(parseImageDimensions(webpVp8(1000, 1))).toEqual({ width: 1000, height: 1 });
    expect(parseImageDimensions(webpVp8l(257, 513))).toEqual({ width: 257, height: 513 });
  });

  it("解析不了返回 null：垃圾字节/截断头/未知子块，绝不让调用方炸掉", () => {
    expect(parseImageDimensions(u8(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16))).toBeNull();
    expect(parseImageDimensions(u8(0x89, 0x50, 0x4e, 0x47))).toBeNull(); // PNG 签名但截断
    expect(parseImageDimensions(new Uint8Array(0))).toBeNull();
    // RIFF/WEBP 但子块不是 VP8X/VP8/VP8L
    expect(parseImageDimensions(riffChunk("XXXX", new Array(16).fill(0)))).toBeNull();
  });
});

describe("compressImage：解码前守卫接线（静态扫描）", () => {
  it("先读头、超像素上限拒绝、能缩放就把 resize 传给 createImageBitmap", () => {
    expect(HOME).toContain("readImageDimensions(file)");
    expect(HOME).toContain("MAX_SOURCE_PIXELS");
    expect(HOME).toContain("createImageBitmap(file, scaled)");
    expect(HOME).toMatch(/dims\.width \* dims\.height > MAX_SOURCE_PIXELS/);
    expect(HOME).toMatch(/file\.size > MAX_SOURCE_BYTES/);
  });

  it("解码前的拒绝带具体原因，两处入口如实展示而不是一律「读取失败」", () => {
    expect(HOME).toContain("图片分辨率过大");
    expect(HOME).toMatch(/catch \(e\) \{[\s\S]*?e instanceof Error && e\.message \? e\.message : "图片读取失败"/);
    expect(HOME).toMatch(/\.catch\(\(err\) => toast\.error\(err instanceof Error && err\.message \? err\.message : "图片读取失败"\)\)/);
  });
});
