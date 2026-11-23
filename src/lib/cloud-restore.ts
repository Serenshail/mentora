/* ========= 「从云端恢复」的破坏性评估（纯函数，可单测） =========
 * 恢复 = 用云端快照**整体替换**本机数据：store.importData 里
 * `goals: clean.goals ?? s.goals` / `knowledge` / `books` / `sessions` /
 * `customPersonas`（store.ts:1742-1746）在快照带全键时（auth-client.ts:180-188
 * 的 localData() 恒带全键）一律取云端，`??` 兜底不会保留本地。
 * 旧实现「从云端恢复」一键直替：离线工作一段时间后（云端仍是旧快照）点这个
 * 与「登录后自动同步」文案同卡的按钮，本地较新的独有数据被静默覆盖，
 * 随后 2.5s 防抖自动推送再把旧快照推上云——离线成果两端皆失。
 * 这里只做「可断言的新旧/条目比对」，由设置页据此要求二次确认并明示代价。 */

export interface RestoreCounts {
  goals: number;
  knowledge: number;
  books: number;
  sessions: number;
  customPersonas: number;
  agentSessions: number;
}

const COUNT_KEYS = ["goals", "knowledge", "books", "sessions", "customPersonas", "agentSessions"] as const;

/** 云端快照的条目数：只统计数组字段，坏字段按 0 计（结构校验在 store.sanitizeBackup） */
export function countRestoreItems(data: Record<string, unknown> | null | undefined): RestoreCounts {
  const out: RestoreCounts = { goals: 0, knowledge: 0, books: 0, sessions: 0, customPersonas: 0, agentSessions: 0 };
  if (!data) return out;
  for (const k of COUNT_KEYS) {
    const v = data[k];
    if (Array.isArray(v)) out[k] = v.length;
  }
  return out;
}

export function totalRestoreItems(c: RestoreCounts): number {
  return COUNT_KEYS.reduce((n, k) => n + c[k], 0);
}

/** 与 auth-client bootSync 的 SYNC_TOLERANCE_MS 同口径：容忍几秒时钟漂移，
 *  否则刚推送完（水位=服务端 updatedAt）再点恢复会被误判成「云端旧」。 */
const SYNC_TOLERANCE_MS = 3000;

export interface CloudRestoreAssessment {
  cloudTotal: number;
  localTotal: number;
  /** 云端快照不比本机上次同步水位新 → 本机可能有没推上云的改动 */
  cloudStale: boolean;
  /** 云端条目比本机少 → 恢复会净丢条目 */
  fewerItems: boolean;
  /** 云端/本机都有数据时，这条恢复需要重点提示 */
  risky: boolean;
  /** updatedAt 或本机水位缺失（从未同步/未登录）时无法判断新旧 */
  freshnessKnown: boolean;
}

/**
 * 判断「用云端快照覆盖本机」是否会让用户丢掉更新的数据。
 * localWatermarkTs = 本机上次成功推送/拉取时服务端返回的 updatedAt（0 = 未知）。
 */
export function assessCloudRestore(args: {
  cloudUpdatedAt: string;
  localWatermarkTs: number;
  cloud: RestoreCounts;
  local: RestoreCounts;
}): CloudRestoreAssessment {
  const cloudTs = Date.parse(args.cloudUpdatedAt) || 0;
  const watermark = Number.isFinite(args.localWatermarkTs) ? args.localWatermarkTs : 0;
  const freshnessKnown = cloudTs > 0 && watermark > 0;
  const cloudStale = freshnessKnown && cloudTs <= watermark + SYNC_TOLERANCE_MS;
  const cloudTotal = totalRestoreItems(args.cloud);
  const localTotal = totalRestoreItems(args.local);
  const fewerItems = cloudTotal < localTotal;
  return {
    cloudTotal,
    localTotal,
    cloudStale,
    fewerItems,
    risky: cloudStale || fewerItems,
    freshnessKnown,
  };
}
