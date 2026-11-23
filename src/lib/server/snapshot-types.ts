import type { VersionToken } from "./version-token";

export type { VersionToken };
export { SnapshotIncompleteError } from "./version-token";

/** 学习快照的内容（字段随业务演进，服务层不穷举）。 */
export type SnapshotPayload = Record<string, unknown>;

/**
 * 写入意图的可辨识联合，替代 `string | null | undefined` 三态：
 * - `absent`：期望主行与块行都不存在（首次创建）；
 * - `match`：期望当前逻辑内容令牌匹配；
 * - `unconditional`：不声明基线（显式表达，非缺省推断）。
 */
export type Expectation =
  | { mode: "absent" }
  | { mode: "match"; token: VersionToken }
  | { mode: "unconditional" };

export type SnapshotRecord = {
  payload: SnapshotPayload;
  /** 对外版本标识：ISO 时间串，必须可 `Date.parse`。 */
  version: string;
  uploadId?: string;
};

export type CommitKind = "created" | "advanced" | "idempotent";

export type CommitOutcome = {
  kind: CommitKind;
  version: string;
  token: VersionToken;
  previous: SnapshotRecord | null;
};

export type ArchiveOutcome = "archived" | "exists" | "failed";

/** 条件写失败的原因分类，供 409 载荷与结构化事件使用。 */
export type ConcurrentWriteReason =
  | "exists"
  | "residual-block"
  | "version-mismatch"
  | "token-mismatch"
  | "lock-timeout";

export type ConcurrentWriteDetails = {
  reason: ConcurrentWriteReason;
  /** 冲突发生时事务内读到的版本；首次创建冲突时为 null。 */
  currentVersion: string | null;
  /** 当前云端版本由哪次上传写入；未知时省略。 */
  currentUploadId?: string;
};

/** 通道不可用（连接失败/超时/未配置），接口映射为 503 `DB_UNAVAILABLE`。 */
export class DbUnavailableError extends Error {
  readonly code = "DB_UNAVAILABLE" as const;
  constructor(message = "云端存储暂不可用") {
    super(message);
    this.name = "DbUnavailableError";
  }
}

/**
 * 把客户端的 `baseVersion` 映射为写入意图。
 * 关键：`undefined`（未声明）**绝不**推断为 `absent`；只有显式 `null` 才是「期望不存在」。
 */
export function expectationFromBase(
  baseVersion: string | null | undefined,
  token?: VersionToken
): Expectation {
  if (baseVersion === undefined) return { mode: "unconditional" };
  if (baseVersion === null) return { mode: "absent" };
  if (!token) {
    throw new Error("expectationFromBase: match 模式必须提供 VersionToken");
  }
  return { mode: "match", token };
}

/** 供路由与测试判断是否为并发冲突，避免按 name 字符串散落判断。 */
export function isConcurrentWriteError(e: unknown): e is Error & {
  name: "ConcurrentWriteError";
  details?: ConcurrentWriteDetails;
} {
  return e instanceof Error && e.name === "ConcurrentWriteError";
}