"use client";

/* 同步决策的纯函数层（复核 REVIEW-TENCENT §2 要求）
 *
 * 为什么单独抽出来：同步覆盖是「数据丢失级」风险，但它原本埋在三个带副作用的函数里
 * （bootSync / syncAfterLogin / useAutoPush），既难测也难证明。复核明确指出
 * 「现有测试主要检查源码文字，不能证明这些行为安全」。
 *
 * 这里把「拿到云端结果之后该做什么」变成**无副作用的纯函数**：
 * 输入 = 云端拉取结果 + 本地是否有实质数据 + 时间水位；
 * 输出 = 一个明确的动作（pull / push / none）+ 原因。
 * 上层只负责执行动作，不再各自实现一套判断。
 */

export type PullStatus = "ok" | "empty" | "error";

export interface SyncDecisionInput {
  /** 云端拉取结果 */
  cloud: { status: PullStatus; data?: Record<string, unknown> | null; updatedAt?: string };
  /** 本地是否有**实质**数据（空壳会话不算） */
  localHas: boolean;
  /** 本地同步水位（ms） */
  localTs: number;
  /** 云端快照时间（ms） */
  cloudTs: number;
  /** 允许的时钟漂移（ms） */
  toleranceMs: number;
  /**
   * 拉取期间用户是否**真的编辑过业务数据**。
   * 注意：不能用「store 引用变化」判断——页面水合必然换引用，那个信号恒为真。
   * 由调用方用「业务字段指纹」比对得出。
   */
  editedDuringPull?: boolean;
  hasUnsyncedEdits?: boolean;
  hasLocalOnlyEntries?: boolean;
  cloudAcknowledgedLocalUpload?: boolean;
}

export type SyncAction =
  | { kind: "none"; reason: string }
  | { kind: "pull"; reason: string }
  | { kind: "push"; reason: string }
  /** 双方都有数据且都变过：不静默覆盖任何一方，交给上层提示/合并 */
  | { kind: "conflict"; reason: string };

/**
 * 决定拉取之后要做什么。
 *
 * 铁律（按优先级）：
 *  1. 拉取失败/超时 → **绝不写云端**（错误 ≠ 云端为空）。这是数据丢失的主要入口。
 *  2. 云端有数据 → 采用云端，除非用户真的在这期间编辑过（那时是冲突，不是覆盖）。
 *  3. 云端为空 + 本地有实质数据 → 推本地（修复历史空快照）。
 *  4. 双方都空 → 什么都不做。
 */
export function decideSyncAction(input: SyncDecisionInput): SyncAction {
  const { cloud, localHas, localTs, cloudTs, toleranceMs, editedDuringPull, hasUnsyncedEdits, hasLocalOnlyEntries, cloudAcknowledgedLocalUpload } = input;

  /* ① 拉取失败：保持本地、不写云端。任何「顺手推一下」都是拿未知状态覆盖真实数据。 */
  if (cloud.status === "error") {
    return { kind: "none", reason: "云端拉取失败：保持本地不动，绝不反推（错误≠云端为空）" };
  }

  const cloudOk = hasSubstantialData(cloud.data);

  /* ② 云端为空 */
  if (cloud.status === "empty" || !cloudOk) {
    if (!localHas) return { kind: "none", reason: "云端与本地都无实质数据" };
    /* 用户拉取期间编辑过也无所谓：云端本来就没东西，推上去不会覆盖任何真实数据 */
    return { kind: "push", reason: "云端为空且本地有实质数据：推送本地（修复空快照）" };
  }

  const knownBase = cloudTs === localTs && localTs > 0;
  if (localHas && (hasUnsyncedEdits || hasLocalOnlyEntries || editedDuringPull) &&
      (knownBase || (cloudAcknowledgedLocalUpload && cloudTs > localTs))) {
    return { kind: "push", reason: "云端仍在本机已知版本，补传本机未同步编辑" };
  }

  /* ③ 云端有数据 + 用户在拉取期间真的编辑过 → 冲突，不静默覆盖 */
  if (editedDuringPull) {
    if (!localHas) return { kind: "pull", reason: "云端有数据、本地无实质数据：采用云端" };
    return {
      kind: "conflict",
      reason: "云端与本地在拉取窗口内都有数据变更：不得静默覆盖任一方，需提示或合并",
    };
  }

  /* ④ 云端有数据、用户没编辑过 */
  if (!localHas) return { kind: "pull", reason: "本地无实质数据：采用云端（新设备/慢网首次打开）" };
  if ((hasUnsyncedEdits || hasLocalOnlyEntries) && cloudTs > localTs) {
    return { kind: "conflict", reason: "本机有未同步内容，保留本机与云端两份数据" };
  }
  if (cloudTs > localTs + toleranceMs) {
    return { kind: "pull", reason: "云端明显比本地新：采用云端" };
  }
  return { kind: "none", reason: "本地已是较新状态，无需拉取" };
}

/** 云端快照里是否有**实质**数据（空壳会话不算）。与 store 侧 hasLocalData 同口径。 */
export function hasSubstantialData(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]) : []);
  const nonEmptySessions = arr("agentSessions").filter((x) => {
    const msgs = (x as { messages?: unknown[] })?.messages;
    return Array.isArray(msgs) && msgs.length > 0;
  }).length;
  return (
    arr("goals").length +
      arr("knowledge").length +
      arr("books").length +
      arr("sessions").length +
      arr("customPersonas").length +
      arr("folders").length +
      nonEmptySessions >
    0
  );
}

/**
 * 云端版本是否由**本机**上传产生（即使回执没到达客户端）。
 *
 * 单浏览器误报的根因：keepalive/排队的上传已经写进云端，但响应在页面卸载或刷新时被丢弃，
 * 本地水位与 dirty 标记没更新；下一次拉取看到「云端比本地新」，就误判成另一台设备。
 * 判定依据只有一条：云端 `uploadId` 命中本机 `recentUploads`，且该次上传不早于当前编辑。
 *
 * 安全边界：跨设备上传的 `uploadId` 不在本机回执列表里 → 仍走真实冲突分支。
 */
export function isSelfAcknowledgedUpload(input: {
  cloudStatus: PullStatus;
  cloudUploadId?: unknown;
  receipts: { id: string; edit: number }[];
  /** 当前本地编辑序号（`<单调计数>:<随机>` 的前半段）。 */
  currentEdit: number;
  cloudData: Record<string, unknown> | null;
  localData: Record<string, unknown>;
}): boolean {
  if (input.cloudStatus !== "ok") return false;
  if (typeof input.cloudUploadId !== "string" || input.cloudUploadId.length === 0) return false;
  const hit = input.receipts.find((r) => r.id === input.cloudUploadId);
  if (!hit) return false;
  // 相等也算本机已上传（发送时编辑序号 = 当前编辑序号，说明之后没有新编辑）
  if (hit.edit > input.currentEdit) return false;
  // 云端存在本机缺失的条目 → 不能当作自写版本直接对齐
  if (hasFilesMissingFromCloud(input.cloudData ?? {}, input.localData)) return false;
  return true;
}

export function shouldBlockAutoPush(status: string, opts: { allowDuringConflict?: boolean } = {}): boolean {
  return status === "conflict" && !opts.allowDuringConflict;
}

export function hasFilesMissingFromCloud(local: Record<string, unknown>, cloud: Record<string, unknown> | null): boolean {
  if (!cloud) return false;
  for (const key of ["goals", "knowledge", "books", "sessions", "customPersonas", "agentSessions"] as const) {
    const localEntries = Array.isArray(local[key]) ? local[key] : [];
    const cloudEntries = Array.isArray(cloud[key]) ? cloud[key] : [];
    const cloudIds = new Set(cloudEntries.map((entry) => entry?.id));
    if (localEntries.some((entry) =>
      typeof entry?.id === "string" && !cloudIds.has(entry.id) &&
      (key !== "agentSessions" || (Array.isArray(entry.messages) && entry.messages.length > 0))
    )) return true;
  }
  const cloudFolders = new Set(Array.isArray(cloud.folders) ? cloud.folders : []);
  return Array.isArray(local.folders) && local.folders.some(folder => !cloudFolders.has(folder));
}

/**
 * 业务数据指纹：只取「用户真正关心」的字段，用于判断拉取期间是否真的被编辑过。
 * **不用 store 引用变化**——页面水合必然换引用（复核点名的根因）。
 */
export function businessFingerprint(state: {
  goals?: unknown[];
  knowledge?: unknown[];
  folders?: string[];
  books?: unknown[];
  sessions?: unknown[];
  customPersonas?: unknown[];
  agentSessions?: { messages?: unknown[] }[];
}): string {
  const count = (a: unknown[] | undefined) => (Array.isArray(a) ? a.length : 0);
  const msgCount = (a: { messages?: unknown[] }[] | undefined) =>
    (Array.isArray(a) ? a : []).reduce((n, s) => n + (Array.isArray(s.messages) ? s.messages.length : 0), 0);
  /* 只数条数不够：内容替换（同数不同内容）也是编辑。加 id 拼接。 */
  const ids = (a: { id?: string }[] | undefined) =>
    (Array.isArray(a) ? a : []).map((x) => x?.id ?? "").join(",");
  return [
    count(state.goals),
    ids(state.goals as { id?: string }[]),
    count(state.knowledge),
    ids(state.knowledge as { id?: string }[]),
    JSON.stringify(state.folders ?? []),
    count(state.books),
    count(state.sessions),
    count(state.customPersonas),
    msgCount(state.agentSessions),
  ].join("|");
}
