import { ConcurrentWriteError, decrypt, rdsTx, type RdsTxClient } from "./db";
import {
  SnapshotIncompleteError,
  joinChunks,
  parseChunkHeader,
  versionToken,
  type VersionToken,
} from "./version-token";
import type {
  CommitKind,
  CommitOutcome,
  ConcurrentWriteReason,
  Expectation,
  SnapshotPayload,
} from "./snapshot-types";

/** 事务内读到的提交前状态。分块形态只在读取瞬间存在，成功写入即消失。 */
export type CommitState = {
  header: string | null;
  blocks: Map<number, string>;
};

export type CommitInput = {
  path: string;
  /** 新快照的明文业务数据；幂等比较使用它，服务端生成字段被规范化排除。 */
  payload: SnapshotPayload;
  /** 新快照的逻辑密文（单行形态，RDS 不分块）；条件写使用它的令牌。 */
  content: string;
  /** 对外版本标识，由调用方在提交前生成并保证单调递增。 */
  version: string;
  uploadId?: string;
  expect: Expectation;
  baseVersion?: string | null;
};

export type Decision =
  | { kind: "incomplete"; missing: number[] }
  | { kind: "conflict"; reason: ConcurrentWriteReason; currentVersion: string | null; currentUploadId?: string }
  | { kind: "idempotent"; version: string; token: VersionToken }
  | { kind: "write" };

/** 递归稳定序列化：对象键排序、数组保序，保证同内容不同插入顺序得到同一字符串。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 规范化业务数据：排除服务端生成的 `updatedAt`（版本）与 `uploadId`（上传回执）。
 * 幂等判定必须用它——两次提交的密文因随机 IV 必然不同，比较密文会把同内容误判为冲突。
 */
export function canonicalBusinessData(payload: SnapshotPayload): string {
  const { updatedAt: _updatedAt, uploadId: _uploadId, ...business } = payload;
  return stableStringify(business);
}

/** 由一条查询的行集构造状态；`#p-gate-*` 等非数字块键不计入分块。 */
export function stateFromRows(path: string, rows: Array<{ k?: string; v?: string }>): CommitState {
  let header: string | null = null;
  const blocks = new Map<number, string>();
  const prefix = `${path}#p`;
  for (const row of rows) {
    if (typeof row.k !== "string" || typeof row.v !== "string") continue;
    if (row.k === path) {
      header = row.v;
      continue;
    }
    if (!row.k.startsWith(prefix)) continue;
    const idx = row.k.slice(prefix.length);
    if (/^[0-9]+$/.test(idx)) blocks.set(Number(idx), row.v);
  }
  return { header, blocks };
}

function missingChunks(declared: number, blocks: Map<number, string>): number[] {
  const missing: number[] = [];
  for (let i = 0; i < declared; i++) if (typeof blocks.get(i) !== "string") missing.push(i);
  return missing;
}

function logicalOf(path: string, state: CommitState): string | null {
  if (state.header === null) return null;
  const declared = parseChunkHeader(state.header);
  if (declared === null) return state.header;
  return joinChunks(path, declared, [...Array(declared).keys()].map((i) => state.blocks.get(i)));
}

/**
 * 固定判定顺序（REQ-04-01/02/03/04，T-ICT-007b）：
 * ① 分块完整性 → ② 期望不存在 → ③ 内容幂等（**先于基线校验**）→ ④ 基线/令牌 → ⑤ 写入。
 */
export function decide(input: {
  state: CommitState;
  path: string;
  content: string;
  payload: SnapshotPayload;
  currentPayload: SnapshotPayload | null;
  expect: Expectation;
  baseVersion?: string | null;
  currentVersion?: string | null;
  currentUploadId?: string;
}): Decision {
  const { state, path, content, payload, currentPayload, expect, baseVersion, currentVersion, currentUploadId } = input;

  if (state.header !== null) {
    const declared = parseChunkHeader(state.header);
    if (declared !== null) {
      const missing = missingChunks(declared, state.blocks);
      if (missing.length > 0) return { kind: "incomplete", missing };
    }
  }

  const hasMain = state.header !== null;
  const hasBlocks = state.blocks.size > 0;

  if (expect.mode === "absent") {
    if (hasMain) return { kind: "conflict", reason: "exists", currentVersion: currentVersion ?? null, currentUploadId };
    if (hasBlocks) return { kind: "conflict", reason: "residual-block", currentVersion: null, currentUploadId };
    return { kind: "write" };
  }

  if (hasMain) {
    const currentLogical = logicalOf(path, state)!;
    const currentToken = versionToken(currentLogical);

    // 幂等比较规范化业务数据：排除 updatedAt/uploadId，避免「同内容、新密文」被误判冲突
    if (currentPayload !== null && canonicalBusinessData(currentPayload) === canonicalBusinessData(payload)) {
      return { kind: "idempotent", version: currentVersion ?? "", token: currentToken };
    }

    if (expect.mode === "match") {
      if (baseVersion === null) {
        return { kind: "conflict", reason: "version-mismatch", currentVersion: currentVersion ?? null, currentUploadId };
      }
      if (typeof baseVersion === "string" && baseVersion !== (currentVersion ?? "")) {
        return { kind: "conflict", reason: "version-mismatch", currentVersion: currentVersion ?? null, currentUploadId };
      }
      if (expect.token !== currentToken) {
        return { kind: "conflict", reason: "token-mismatch", currentVersion: currentVersion ?? null, currentUploadId };
      }
    }
    return { kind: "write" };
  }

  if (expect.mode === "match") {
    return { kind: "conflict", reason: "version-mismatch", currentVersion: null, currentUploadId };
  }
  return { kind: "write" };
}

function metaOf(raw: string | null, path: string): { version: string; uploadId?: string; payload: SnapshotPayload } {
  if (raw === null) return { version: "", payload: {} };
  try {
    const payload = decrypt<SnapshotPayload>(raw);
    const version = typeof payload.updatedAt === "string" ? payload.updatedAt : "";
    const uploadId = typeof payload.uploadId === "string" ? payload.uploadId : undefined;
    return { version, uploadId, payload };
  } catch {
    throw new SnapshotIncompleteError(path, []);
  }
}

/**
 * 唯一快照写入入口：单事务内完成「一次查询读 → 判定 → 写主行 → 清旧块」。
 * 失败时整体回滚，主行与块行保持调用前状态。
 */
export async function commitSnapshot(input: CommitInput): Promise<CommitOutcome> {
  return rdsTx(input.path, async (c: RdsTxClient) => {
    // 一条 SELECT 取齐主行与全部块行（T-ICT-007b 验收 1）；事务内不再二次查询
    const rows = await c.query(
      "SELECT k, v FROM kv WHERE k = $1 OR (k LIKE $2 AND k ~ $3)",
      [input.path, `${input.path}#p%`, `^${input.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#p[0-9]+$`]
    );
    const state = stateFromRows(input.path, rows.rows as Array<{ k?: string; v?: string }>);
    // 存在性判定（尤其 absent）不需要解密；解密失败不能掩盖「已存在」冲突
    let previousMeta: { version: string; uploadId?: string; payload: SnapshotPayload } = { version: "", payload: {} };
    let metaError: unknown = null;
    if (state.header !== null) {
      try {
        previousMeta = metaOf(logicalOf(input.path, state), input.path);
      } catch (e) {
        metaError = e;
      }
    }

    const decision = decide({
      state,
      path: input.path,
      content: input.content,
      payload: input.payload,
      currentPayload: state.header === null ? null : previousMeta.payload,
      expect: input.expect,
      baseVersion: input.baseVersion,
      currentVersion: previousMeta.version || null,
      currentUploadId: previousMeta.uploadId,
    });

    if (decision.kind === "incomplete") {
      throw new SnapshotIncompleteError(input.path, decision.missing);
    }
    if (decision.kind === "conflict") {
      const details =
        decision.currentUploadId === undefined
          ? { reason: decision.reason, currentVersion: decision.currentVersion }
          : { reason: decision.reason, currentVersion: decision.currentVersion, currentUploadId: decision.currentUploadId };
      throw new ConcurrentWriteError(input.path, details);
    }
    if (metaError) {
      throw metaError;
    }
    if (decision.kind === "idempotent") {
      return {
        kind: "idempotent" as CommitKind,
        version: decision.version,
        token: decision.token,
        previous: null,
      };
    }

    // 先 UPSERT 主行，再清旧块；同一事务，任一失败整体回滚
    await c.query("INSERT INTO kv(k, v) VALUES($1, $2) ON CONFLICT(k) DO UPDATE SET v = EXCLUDED.v", [
      input.path,
      input.content,
    ]);
    await c.query("DELETE FROM kv WHERE k LIKE $1 AND k ~ $2", [
      `${input.path}#p%`,
      `^${input.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#p[0-9]+$`,
    ]);

    const kind: CommitKind = state.header === null ? "created" : "advanced";
    const previous =
      state.header === null
        ? null
        : { payload: previousMeta.payload, version: previousMeta.version, uploadId: previousMeta.uploadId };
    return { kind, version: input.version, token: versionToken(input.content), previous };
  });
}

/** 只读：一次查询取逻辑密文与令牌，供 GET 或写入前置使用（不写存储）。 */
export async function readSnapshot(
  path: string
): Promise<{ raw: string; token: VersionToken; version: string; uploadId?: string } | null> {
  return rdsTx(path, async (c: RdsTxClient) => {
    const rows = await c.query(
      "SELECT k, v FROM kv WHERE k = $1 OR (k LIKE $2 AND k ~ $3)",
      [path, `${path}#p%`, `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#p[0-9]+$`]
    );
    const state = stateFromRows(path, rows.rows as Array<{ k?: string; v?: string }>);
    if (state.header === null) return null;
    const raw = logicalOf(path, state)!;
    const meta = metaOf(raw, path);
    return { raw, token: versionToken(raw), version: meta.version, uploadId: meta.uploadId };
  });
}