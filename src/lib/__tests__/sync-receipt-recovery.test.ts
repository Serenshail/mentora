import { describe, expect, it } from "vitest";
import { decideReceiptRealign, shouldClearDirty, type UploadReceipt } from "../sync-receipt";

const ACCOUNT = "user-a";
const V2 = "2026-11-20T08:00:00.000Z";

function receipts(edit = 100): UploadReceipt[] {
  return [{ id: "3f2a1b4c-aaaa-bbbb-cccc-1234567890ab", edit }];
}

describe("T-ICT-020 409 对齐一次并重推", () => {
  it("回执命中且有更晚编辑：对齐并重推", () => {
    const d = decideReceiptRealign({
      conflict: { conflict: true, currentVersion: V2, currentUploadId: "3f2a1b4c-aaaa-bbbb-cccc-1234567890ab" },
      receipts: receipts(100),
      accountId: ACCOUNT,
      receiptAccountId: ACCOUNT,
      currentEdit: 200,
    });
    expect(d).toEqual({ realign: true, version: V2, push: true });
  });

  it("回执命中但当前无更晚编辑：只对齐水位，不发第二次请求", () => {
    const d = decideReceiptRealign({
      conflict: { conflict: true, currentVersion: V2, currentUploadId: "3f2a1b4c-aaaa-bbbb-cccc-1234567890ab" },
      receipts: receipts(200),
      accountId: ACCOUNT,
      receiptAccountId: ACCOUNT,
      currentEdit: 200,
    });
    expect(d).toEqual({ realign: true, version: V2, push: false });
  });

  it("重推发出后产生的新编辑必须保留 dirty 标记", () => {
    expect(shouldClearDirty("100:abc", "150:def")).toBe(false);
    expect(shouldClearDirty("100:abc", "100:abc")).toBe(true);
    expect(shouldClearDirty(null, null)).toBe(false);
  });

  it("非冲突响应不触发对齐", () => {
    expect(decideReceiptRealign({ conflict: null, receipts: receipts(), accountId: ACCOUNT, currentEdit: 300 }).realign).toBe(false);
    expect(
      decideReceiptRealign({ conflict: { conflict: false }, receipts: receipts(), accountId: ACCOUNT, currentEdit: 300 }).realign
    ).toBe(false);
  });
});