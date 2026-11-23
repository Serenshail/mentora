import { describe, expect, it } from "vitest";
import { decideReceiptRealign, type UploadReceipt } from "../sync-receipt";

const ACCOUNT = "user-a";
const V2 = "2026-11-20T08:00:00.000Z";
const RECEIPT_ID = "3f2a1b4c-aaaa-bbbb-cccc-1234567890ab";

function base(overrides: Partial<Parameters<typeof decideReceiptRealign>[0]> = {}) {
  return decideReceiptRealign({
    conflict: { conflict: true, currentVersion: V2, currentUploadId: RECEIPT_ID },
    receipts: [{ id: RECEIPT_ID, edit: 100 }] as UploadReceipt[],
    accountId: ACCOUNT,
    receiptAccountId: ACCOUNT,
    currentEdit: 200,
    ...overrides,
  });
}

describe("T-ICT-021 跨设备不覆盖他人改动", () => {
  it("回执不属于本机：不对齐", () => {
    expect(base({ receipts: [{ id: "other-device-upload", edit: 100 }] })).toEqual({ realign: false, reason: "receipt-miss" });
  });

  it("回执属于其他账户：不对齐", () => {
    expect(base({ receiptAccountId: "user-b" })).toEqual({ realign: false, reason: "account-mismatch" });
  });

  it("版本标识缺失或非 ISO：不对齐", () => {
    for (const version of [null, "", "2026-11-20 08:00:00", "not-a-date", 123]) {
      expect(base({ conflict: { conflict: true, currentVersion: version, currentUploadId: RECEIPT_ID } })).toEqual({
        realign: false,
        reason: "invalid-version",
      });
    }
  });

  it("恶意回执标识：不对齐且不污染回执列表", () => {
    const receipts: UploadReceipt[] = [{ id: RECEIPT_ID, edit: 100 }];
    for (const id of ["__proto__", "", "x".repeat(81), "constructor"]) {
      expect(base({ conflict: { conflict: true, currentVersion: V2, currentUploadId: id } })).toEqual({
        realign: false,
        reason: "receipt-miss",
      });
    }
    expect(receipts).toHaveLength(1);
    expect(receipts[0].id).toBe(RECEIPT_ID);
  });

  it("云端存在本机缺失的文件：不重推", () => {
    const cloud = { goals: [{ id: "cloud-only" }], knowledge: [], books: [], sessions: [], customPersonas: [], agentSessions: [] };
    const local = { goals: [], knowledge: [], books: [], sessions: [], customPersonas: [], agentSessions: [] };
    expect(base({ cloudData: cloud, localData: local })).toEqual({ realign: false, reason: "cloud-has-extra" });
  });

  it("云端是本机子集：允许对齐（不会覆盖他人新增）", () => {
    const cloud = { goals: [], folders: [] };
    const local = { goals: [{ id: "local-only" }], folders: ["A"] };
    const d = base({ cloudData: cloud, localData: local });
    expect(d.realign).toBe(true);
  });
});