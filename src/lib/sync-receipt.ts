import { hasFilesMissingFromCloud } from "./sync-decision";

export type UploadReceipt = { id: string; edit: number };

export type ConflictPayload = {
  conflict?: unknown;
  currentVersion?: unknown;
  currentUploadId?: unknown;
};

export type ReceiptDecision =
  | {
      realign: false;
      reason: "not-conflict" | "invalid-version" | "receipt-miss" | "account-mismatch" | "cloud-has-extra";
    }
  | { realign: true; version: string; push: boolean };

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 409 后是否允许「对齐水位并重推一次」。三条保护缺一不可：
 * ① 归属：回执命中本机 `recentUploads`，且回执账户与当前登录账户一致；
 * ② 时序：当前编辑必须晚于该次上传；没有更晚编辑时只对齐水位、不重推；
 * ③ 完整性：云端不能存在本机缺失的文件/条目（否则重推会用旧内容覆盖他人新增）。
 * 409 响应体不足以核实时，调用方应先 GET 云端状态再调用本函数。
 */
export function decideReceiptRealign(input: {
  conflict: ConflictPayload | null;
  receipts: UploadReceipt[];
  accountId: string;
  /** 回执所属账户；未知时省略（旧回执无此字段）。 */
  receiptAccountId?: string;
  /** 当前本地编辑序号（`<单调计数>:<随机>` 的前半段）。 */
  currentEdit: number;
  cloudData?: unknown;
  localData?: unknown;
}): ReceiptDecision {
  const c = input.conflict;
  if (!c || c.conflict !== true) return { realign: false, reason: "not-conflict" };
  if (typeof c.currentVersion !== "string" || !ISO_MS.test(c.currentVersion)) {
    return { realign: false, reason: "invalid-version" };
  }
  if (input.receiptAccountId !== undefined && input.receiptAccountId !== input.accountId) {
    return { realign: false, reason: "account-mismatch" };
  }
  if (typeof c.currentUploadId !== "string" || c.currentUploadId.length === 0 || c.currentUploadId.length > 80) {
    return { realign: false, reason: "receipt-miss" };
  }
  const receipt = input.receipts.find((r) => r.id === c.currentUploadId);
  if (!receipt) return { realign: false, reason: "receipt-miss" };
  const asRecord = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  const cloud = asRecord(input.cloudData);
  const local = asRecord(input.localData);
  if (cloud && local && hasFilesMissingFromCloud(cloud, local)) {
    return { realign: false, reason: "cloud-has-extra" };
  }
  return { realign: true, version: c.currentVersion, push: input.currentEdit > receipt.edit };
}

/**
 * 推送成功后是否清除 dirty 标记：只有「当前编辑仍是本次发出的那批」才清。
 * 重推期间产生的新编辑必须保留待同步标记，否则会在下一次同步前被误判为已同步。
 */
export function shouldClearDirty(sentMarker: string | null, currentMarker: string | null): boolean {
  return sentMarker !== null && sentMarker === currentMarker;
}