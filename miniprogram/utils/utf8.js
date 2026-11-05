/* UTF-8 增量解码器：流式响应的分块到达可能把一个多字节汉字切成两半，
 * 不能逐块独立 decode。这里维护跨块字节状态，只吐出完整字符。
 * 若运行环境有 TextDecoder（开发者工具/新版客户端）则优先用原生的。 */

function Utf8Decoder() {
  this.pending = [];
  this.native = null;
  /* 首个输出前剥 UTF-8 BOM（原生 TextDecoder 默认就剥，手写路径要自己对齐） */
  this.stripBom = true;
  try {
    if (typeof TextDecoder === "function") {
      this.native = new TextDecoder("utf-8");
    }
  } catch (e) {
    this.native = null;
  }
}

/* 追加一个 ArrayBuffer，返回已能完整解码的字符串 */
Utf8Decoder.prototype.push = function (buffer) {
  var arr = new Uint8Array(buffer);
  if (this.native) {
    // stream:true 保留不完整的多字节序列到下一次
    return this.native.decode(arr, { stream: true });
  }
  var bytes = this.pending.concat(Array.prototype.slice.call(arr));
  var out = "";
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i];
    var need = 0;
    var cp = 0;
    if (b < 0x80) {
      need = 0;
      cp = b;
    } else if ((b & 0xe0) === 0xc0) {
      need = 1;
      cp = b & 0x1f;
    } else if ((b & 0xf0) === 0xe0) {
      need = 2;
      cp = b & 0x0f;
    } else if ((b & 0xf8) === 0xf0) {
      need = 3;
      cp = b & 0x07;
    } else {
      // 坏字节：统一产出 U+FFFD（对齐原生 TextDecoder），不再静默吞掉
      out += "\uFFFD";
      i += 1;
      continue;
    }
    if (i + need >= bytes.length) break; // 半包：留给下一块
    var ok = true;
    for (var k = 1; k <= need; k++) {
      var cb = bytes[i + k];
      if ((cb & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (cb & 0x3f);
    }
    if (!ok) {
      out += "\uFFFD";
      i += 1;
      continue;
    }
    /* overlong（C0 80 之类）/代理区/超上限：统一产出 U+FFFD（按整个序列替换，
     * 与原生逐字节替换粒度略异但同样是 U+FFFD），不再产出 NUL、孤立代理项——
     * 旧实现的怪字符会让下游 JSON.parse 丢行。 */
    var valid =
      (need === 0 && cp < 0x80) ||
      (need === 1 && cp >= 0x80) ||
      (need === 2 && cp >= 0x800 && !(cp >= 0xd800 && cp <= 0xdfff)) ||
      (need === 3 && cp >= 0x10000 && cp <= 0x10ffff);
    if (!valid) {
      out += "\uFFFD";
    } else if (need === 3 && cp > 0xffff) {
      // 代理对（emoji 等）
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
    i += need + 1;
  }
  this.pending = bytes.slice(i);
  if (this.stripBom && out.length > 0) {
    this.stripBom = false;
    if (out.charAt(0) === "\uFEFF") out = out.slice(1);
  }
  return out;
};

module.exports = { Utf8Decoder: Utf8Decoder };
