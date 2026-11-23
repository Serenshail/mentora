import { describe, expect, it } from "vitest";
import { ConcurrentWriteError } from "../server/db";
import {
  DbUnavailableError,
  SnapshotIncompleteError,
  expectationFromBase,
  isConcurrentWriteError,
  type Expectation,
} from "../server/snapshot-types";
import { versionToken } from "../server/version-token";

describe("T-ICT-005 expectationFromBase", () => {
  it("undefined 映射为 unconditional，绝不推断为 absent", () => {
    const e = expectationFromBase(undefined);
    expect(e).toEqual({ mode: "unconditional" });
    expect(e.mode).not.toBe("absent");
  });

  it("显式 null 才是 absent", () => {
    expect(expectationFromBase(null)).toEqual({ mode: "absent" });
  });

  it("字符串基线映射为 match，且必须携带令牌", () => {
    const token = versionToken("GZ1.x");
    expect(expectationFromBase("2026-11-20T00:00:00.000Z", token)).toEqual({ mode: "match", token });
  });

  it("match 模式缺少令牌立即失败，不降级为 unconditional", () => {
    expect(() => expectationFromBase("2026-11-20T00:00:00.000Z")).toThrow(/VersionToken/);
  });

  it("空字符串基线不会退化为 absent", () => {
    const token = versionToken("GZ1.x");
    expect(expectationFromBase("", token).mode).toBe("match");
  });
});

describe("T-ICT-005 类型互斥", () => {
  it("absent 携带令牌在类型层被拒绝", () => {
    // @ts-expect-error absent 分支不允许 token
    const bad: Expectation = { mode: "absent", token: versionToken("x") };
    expect(bad.mode).toBe("absent");
  });

  it("match 缺少令牌在类型层被拒绝", () => {
    // @ts-expect-error match 分支必须提供 token
    const bad: Expectation = { mode: "match" };
    expect(bad.mode).toBe("match");
  });
});

describe("T-ICT-005 错误契约", () => {
  it("ConcurrentWriteError 旧构造签名仍可用", () => {
    const e = new ConcurrentWriteError("data/u.json");
    expect(e.name).toBe("ConcurrentWriteError");
    expect(e.message).toContain("data/u.json");
    expect(e.details).toBeUndefined();
  });

  it("details 携带原因、当前版本与回执归属", () => {
    const e = new ConcurrentWriteError("data/u.json", {
      reason: "version-mismatch",
      currentVersion: "2026-11-20T08:00:00.000Z",
      currentUploadId: "3f2a1b4c-aaaa-bbbb-cccc-1234567890ab",
    });
    expect(isConcurrentWriteError(e)).toBe(true);
    expect(e.details?.reason).toBe("version-mismatch");
    expect(e.details?.currentVersion).toBe("2026-11-20T08:00:00.000Z");
  });

  it("错误序列化不泄露快照内容、账号或连接串", () => {
    const e = new ConcurrentWriteError("data/u.json", {
      reason: "token-mismatch",
      currentVersion: null,
    });
    const text = JSON.stringify({ name: e.name, message: e.message, details: e.details });
    expect(text).not.toContain("GZ1.");
    expect(text).not.toContain("postgresql://");
    expect(text).not.toContain("@");
  });

  it("DbUnavailableError 带稳定错误码", () => {
    expect(new DbUnavailableError().code).toBe("DB_UNAVAILABLE");
  });

  it("SnapshotIncompleteError 从契约层可导入且带错误码", () => {
    const e = new SnapshotIncompleteError("data/u.json", [1]);
    expect(e.code).toBe("SNAPSHOT_INCOMPLETE");
    expect(e.missing).toEqual([1]);
  });
});