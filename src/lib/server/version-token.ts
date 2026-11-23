import crypto from "node:crypto";

/**
 * 服务端内部版本令牌：`md5(逻辑密文)`。
 * 只在服务端流转，**绝不进入 HTTP 响应**（D1 非分块 token 会含整段密文）。
 */
export type VersionToken = `md5:${string}`;

/** 历史分块头只接受紧凑格式：`{"__chunks__":N}`，N > 0。 */
const CHUNK_HEADER_RE = /^\{"__chunks__":(\d+)\}$/;

/** 分块缺失/空洞：接口映射为 503 `SNAPSHOT_INCOMPLETE`，不返回部分内容。 */
export class SnapshotIncompleteError extends Error {
  readonly code = "SNAPSHOT_INCOMPLETE" as const;
  constructor(
    public readonly path: string,
    public readonly missing: number[]
  ) {
    super(`云端快照不完整：${path} 缺少分块 ${missing.join(",") || "?"}`);
    this.name = "SnapshotIncompleteError";
  }
}

/** 识别历史分块头；普通密文、`{"__chunks__":0}`、带空格或额外字段一律返回 null。 */
export function parseChunkHeader(raw: string): number | null {
  const m = CHUNK_HEADER_RE.exec(raw);
  if (!m) return null;
  const declared = Number(m[1]);
  return Number.isFinite(declared) && declared > 0 ? declared : null;
}

/** 对逻辑密文计算唯一令牌；与 PG `md5(v)` 对纯 ASCII 密文恒等。 */
export function versionToken(logical: string): VersionToken {
  return `md5:${crypto.createHash("md5").update(logical, "utf8").digest("hex")}`;
}

/** 按序拼接分块；缺块或空洞即抛错，绝不拼接部分内容。 */
export function joinChunks(path: string, declared: number, parts: Array<string | undefined | null>): string {
  const missing: number[] = [];
  for (let i = 0; i < declared; i++) {
    if (typeof parts[i] !== "string") missing.push(i);
  }
  if (missing.length > 0) throw new SnapshotIncompleteError(path, missing);
  return (parts as string[]).slice(0, declared).join("");
}

/**
 * 由一行物理存储值还原逻辑密文：
 * - 单行形态：`raw` 即逻辑密文；
 * - 分块形态：`raw` 是 header，须传入 `#p0..#p(N-1)`。
 */
export function logicalContent(
  path: string,
  raw: string,
  parts?: Array<string | undefined | null>
): string {
  const declared = parseChunkHeader(raw);
  if (declared === null) return raw;
  return joinChunks(path, declared, parts ?? []);
}

/** 一次调用完成「还原 + 令牌」，避免调用方分别处理分块形态。 */
export function tokenOf(path: string, raw: string, parts?: Array<string | undefined | null>): VersionToken {
  return versionToken(logicalContent(path, raw, parts));
}