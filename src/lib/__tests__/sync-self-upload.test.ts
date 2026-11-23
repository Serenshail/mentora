import { describe, expect, it } from "vitest";
import { isSelfAcknowledgedUpload, shouldBlockAutoPush } from "../sync-decision";

const CLOUD = { goals: [{ id: "g1" }] };
const LOCAL = { goals: [{ id: "g1" }] };

describe("P0 单浏览器同步误报：自写版本识别", () => {
  it("回执 edit 与当前 edit 相等时仍认定为自写（关键回归）", () => {
    expect(
      isSelfAcknowledgedUpload({
        cloudStatus: "ok",
        cloudUploadId: "dab064b1",
        receipts: [{ id: "dab064b1", edit: 100 }],
        currentEdit: 100,
        cloudData: CLOUD,
        localData: LOCAL,
      })
    ).toBe(true);
  });

  it("回执早于当前编辑（后又有新编辑）时也认定为自写，交由推送补齐", () => {
    expect(
      isSelfAcknowledgedUpload({
        cloudStatus: "ok",
        cloudUploadId: "up-1",
        receipts: [{ id: "up-1", edit: 100 }],
        currentEdit: 200,
        cloudData: CLOUD,
        localData: LOCAL,
      })
    ).toBe(true);
  });

  it("回执晚于当前编辑（异常序）不算自写", () => {
    expect(
      isSelfAcknowledgedUpload({
        cloudStatus: "ok",
        cloudUploadId: "up-1",
        receipts: [{ id: "up-1", edit: 300 }],
        currentEdit: 200,
        cloudData: CLOUD,
        localData: LOCAL,
      })
    ).toBe(false);
  });

  it("跨设备上传（uploadId 不在本机回执）仍是真实冲突", () => {
    expect(
      isSelfAcknowledgedUpload({
        cloudStatus: "ok",
        cloudUploadId: "other-device",
        receipts: [{ id: "up-mine", edit: 100 }],
        currentEdit: 200,
        cloudData: CLOUD,
        localData: LOCAL,
      })
    ).toBe(false);
  });

  it("云端有本机缺失条目时不得当作自写对齐", () => {
    expect(
      isSelfAcknowledgedUpload({
        cloudStatus: "ok",
        cloudUploadId: "up-1",
        receipts: [{ id: "up-1", edit: 100 }],
        currentEdit: 100,
        cloudData: { goals: [{ id: "cloud-only" }] },
        localData: { goals: [] },
      })
    ).toBe(false);
  });

  it("拉取失败或无 uploadId 时不算自写", () => {
    expect(
      isSelfAcknowledgedUpload({
        cloudStatus: "error",
        cloudUploadId: "up-1",
        receipts: [{ id: "up-1", edit: 100 }],
        currentEdit: 100,
        cloudData: CLOUD,
        localData: LOCAL,
      })
    ).toBe(false);
    for (const id of [undefined, "", 123]) {
      expect(
        isSelfAcknowledgedUpload({
          cloudStatus: "ok",
          cloudUploadId: id,
          receipts: [{ id: "up-1", edit: 100 }],
          currentEdit: 100,
          cloudData: CLOUD,
          localData: LOCAL,
        })
      ).toBe(false);
    }
  });
});

describe("QA-00 冲突态禁止自动/保活覆盖", () => {
  it("conflict 状态阻断自动推送与 keepalive", () => {
    expect(shouldBlockAutoPush("conflict")).toBe(true);
    expect(shouldBlockAutoPush("conflict", {})).toBe(true);
    expect(shouldBlockAutoPush("conflict", { allowDuringConflict: false })).toBe(true);
  });

  it("仅显式处理（allowDuringConflict）放行", () => {
    expect(shouldBlockAutoPush("conflict", { allowDuringConflict: true })).toBe(false);
  });

  it("非冲突状态不阻断正常保存", () => {
    for (const st of ["idle", "saving", "saved", "error"]) expect(shouldBlockAutoPush(st)).toBe(false);
  });
});
