/* 解码前读取图片像素尺寸：只解析文件头，不触发任何解码。
 *
 * 稳定性背景：compressImage 此前先 createImageBitmap(file) 全尺寸解码再算缩放，
 * 2 亿像素全景图 ≈ 800MB 位图内存，移动端 Safari/Chrome 可能因位图分配失败直接
 * 杀标签页（OOM 后整页运行态全丢，正在跑的其它会话任务一并中断）——JS 的
 * try/catch 接不住那种死法。调用方（agent-home 的 compressImage）据此在解码前：
 *   1) 超大像素图直接拒绝；
 *   2) 把目标缩放传给 createImageBitmap 的 resizeWidth/resizeHeight，
 *      在解码阶段就缩小（不再产生全尺寸位图）。
 * 解析不了（HEIC/AVIF/截断文件）返回 null，由调用方退回原路径、以解码异常兜底。 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** 读文件头部并解析尺寸；任何 IO/解析异常都折成 null（不影响原流程） */
export async function readImageDimensions(file: Blob): Promise<ImageDimensions | null> {
  try {
    /* JPEG 的 SOF 标记可能排在较大的 EXIF/缩略图 APP 段之后，预读 256KB 足以覆盖
     * 常见照片/截图；更大的段解析不到时返回 null 走原路径 */
    const buf = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    return parseImageDimensions(buf);
  } catch {
    return null;
  }
}

/** 纯函数版本：便于在无 DOM 的 vitest 里直接对文件头做回归锁 */
export function parseImageDimensions(buf: Uint8Array): ImageDimensions | null {
  if (buf.length < 10) return null;
  /* PNG：89 50 4E 47 0D 0A 1A 0A + IHDR——宽/高大端位于第 16/20 字节 */
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  /* GIF87a/89a：小端宽/高位于第 6/8 字节 */
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  /* WebP：RIFF....WEBP，再按子块格式（VP8X/VP8 /VP8L）取宽高；
   * 长度下限按子格式各自判（最小合法 VP8L 文件只有 25 字节） */
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    if (buf.length < 16) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const fourcc = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
    if (fourcc === "VP8X") {
      /* 扩展格式：画布宽/高各 24 位小端、值为「尺寸-1」，位于第 24-26/27-29 字节。
       * 手动拼 3 字节：getUint32(27) 会越界读第 30 字节（最小合法文件恰好 30 字节）。 */
      if (buf.length < 30) return null;
      return {
        width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
        height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
      };
    }
    if (fourcc === "VP8 ") {
      /* 有损关键帧：帧头后是 sync 9D 01 2A，随后 14 位宽/14 位高（小端） */
      if (buf.length < 30) return null;
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (fourcc === "VP8L") {
      /* 无损：第 21 字节起 32 位 LSB-first 位流 = 14 位宽-1 + 14 位高-1 */
      if (buf.length < 25) return null;
      if (buf[20] !== 0x2f) return null;
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  /* JPEG：FFD8 起按段扫描，取第一个 SOF0-SOF15 的尺寸（跳过 DHT/DAC/JPG 等
   * 无尺寸标记；SOF 恒在 SOS 之前，不会扫进熵编码数据）。 */
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 <= buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      if (marker === 0xff) {
        off++; // 填充字节
        continue;
      }
      /* 独立标记（无长度段）：SOI/EOI/RSTn */
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const len = (buf[off + 2] << 8) | buf[off + 3];
      if (len < 2) return null; // 段长非法：避免死循环，退回原路径
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: (buf[off + 5] << 8) | buf[off + 6],
          width: (buf[off + 7] << 8) | buf[off + 8],
        };
      }
      off += 2 + len;
    }
    return null;
  }
  return null;
}
