import "server-only";
import type { NextRequest } from "next/server";

/* ============================================================
 * 请求体体积闸（与 sync/route.ts、chat/route.ts 的体积闸同一纪律）
 *
 * 问题：req.json() 会把整个请求体缓冲进内存再解析。Vercel 平台层有 ~4.5MB
 * 封顶，但腾讯云自托管（Caddy 默认不限 body）下，攻击者用限流额度内的请求
 * 发 GB 级 JSON，JSON.parse 的内存尖峰足以 OOM 杀掉单进程 Node。
 *
 * 双层闸：
 *  1) 声明闸：content-length 超标直接拒，不碰请求体（挡「老实的超标包」）；
 *  2) 流式终闸：按块累计字节数，一超限立即返回 null——chunked（无声明值）
 *     的「说谎分块包」最多只缓冲到超限那一刻为止，不会把整个 GB 级包
 *     读进内存（这是与 chat 的 req.text() 终闸的本质区别：text() 必然
 *     先缓冲完整个请求体才量得出大小）。
 *
 * 返回值约定：null 仅表示体积超标（调用方回 413）；解析失败/空体/流中断
 * 一律回退 {}，与旧 req.json().catch(() => ({})) 行为逐字对齐，调用方的
 * 字段校验路径不变。真实端点载荷（登录/注册/改密 ≤1KB，头像 dataURL
 * ≤400KB 字符）远低于默认上限，不会误伤。
 * ============================================================ */

/** 认证/公共小载荷端点的默认请求体上限：512KB */
export const AUTH_BODY_LIMIT = 512 * 1024;

export async function readJsonBody<T = Record<string, unknown>>(
  req: NextRequest,
  limit: number = AUTH_BODY_LIMIT
): Promise<T | null> {
  /* 第 1 层：声明值超标，未读一字节就拒。
   * headers 用可选链：真实 NextRequest 恒有 headers，测试替身（裸 { json } 形状）可能没有
   * ——没有声明头时按 0 处理，交给流式终闸兜底，生产语义不变。 */
  const declared = Number(req.headers?.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;

  /* 请求体不可读（无 body / 环境无流）时退回 json()：语义与旧行为一致 */
  const stream = (req as { body?: AsyncIterable<Uint8Array> | null }).body ?? null;
  if (!stream) {
    try {
      return (await req.json()) as T;
    } catch {
      return {} as T;
    }
  }

  /* 第 2 层：流式限量累计，超限即断流返回 */
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const piece of stream) {
      total += piece.byteLength;
      if (total > limit) return null; // 首包超限即弃，绝不继续缓冲
      chunks.push(piece);
    }
  } catch {
    return {} as T; // 流中断：与旧 json() 抛错回 {} 对齐
  }

  if (total === 0) return {} as T;
  try {
    const text = new TextDecoder("utf-8").decode(concat(chunks, total));
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/**
 * 以流式方式读出请求体文本，累计字节数超 limit 立即断流并返回 null。
 *
 * 供需要自行 JSON.parse / 量字符数的路由（chat）复用，避免它们退回
 * `req.text()`——text() 必然先把整个请求体缓冲进内存，对无 content-length
 * 的 chunked 大包来说「读完再判大小」的闸门等于没有闸门。
 *
 * 语义：
 *  - 声明闸：content-length 超限 → null（不读一字节）；
 *  - 流式终闸：按块累计，超限即 return（for-await 提前退出会 cancel 底层流，
 *    后续字节不再进内存）；
 *  - 流中断 → ""（与旧 `req.text().catch(() => "")` 对齐）；
 *  - 环境无 body 可读 → 退回 text()，并做读取后的同口径字节校验（测试替身/老环境）。
 */
export async function readTextBodyWithLimit(
  req: NextRequest,
  limit: number = AUTH_BODY_LIMIT
): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;

  const stream = (req as { body?: AsyncIterable<Uint8Array> | null }).body ?? null;
  /* 运行时不提供可迭代 body（测试替身/老环境）→ 退回 text() + 读取后字节校验，
     行为与旧 `req.text()` 一致；不能把「不可迭代」误判成空体。 */
  if (!stream || typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
    const raw = await req.text().catch(() => "");
    return Buffer.byteLength(raw, "utf8") > limit ? null : raw;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const piece of stream) {
      total += piece.byteLength;
      if (total > limit) return null; // 首包超限即弃，绝不继续缓冲
      chunks.push(piece);
    }
  } catch {
    return ""; // 流中断：与旧 text().catch(() => "") 对齐
  }

  if (total === 0) return "";
  return new TextDecoder("utf-8").decode(concat(chunks, total));
}

/** 已知总长的小块拼接（≤limit，单块直返，避免二次拷贝） */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Binary counterpart for compressed snapshots: enforce the cap before buffering the whole upload. */
export async function readBytesBodyWithLimit(req: NextRequest, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return null;
  const stream = req.body as AsyncIterable<Uint8Array> | null;
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    const bytes = new Uint8Array(await req.arrayBuffer());
    return bytes.byteLength > limit ? null : bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const piece of stream) {
    total += piece.byteLength;
    if (total > limit) return null;
    chunks.push(piece);
  }
  return concat(chunks, total);
}
