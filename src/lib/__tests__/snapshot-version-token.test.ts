import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SnapshotIncompleteError,
  joinChunks,
  logicalContent,
  parseChunkHeader,
  tokenOf,
  versionToken,
} from "../server/version-token";

describe("T-ICT-004 parseChunkHeader", () => {
  it("识别紧凑分块头", () => {
    expect(parseChunkHeader('{"__chunks__":3}')).toBe(3);
    expect(parseChunkHeader('{"__chunks__":1}')).toBe(1);
  });

  it("普通密文与非法形态返回 null", () => {
    expect(parseChunkHeader("GZ1.AAAA")).toBeNull();
    expect(parseChunkHeader('{"__chunks__":0}')).toBeNull();
    expect(parseChunkHeader('{"__chunks__":3, "x":1}')).toBeNull();
    expect(parseChunkHeader(' {"__chunks__":3}')).toBeNull();
    expect(parseChunkHeader('{"__chunks__":3} ')).toBeNull();
    expect(parseChunkHeader('{"__chunks__":"3"}')).toBeNull();
  });
});

describe("T-ICT-004 versionToken", () => {
  it("与 crypto md5 完全一致并带 md5: 前缀", () => {
    const logical = "GZ1." + Buffer.from("hello mentora").toString("base64");
    const expected = "md5:" + crypto.createHash("md5").update(logical, "utf8").digest("hex");
    expect(versionToken(logical)).toBe(expected);
  });

  it("同一内容恒等，不同内容不同", () => {
    expect(versionToken("a")).toBe(versionToken("a"));
    expect(versionToken("a")).not.toBe(versionToken("b"));
  });
});

describe("T-ICT-004 分块拼接", () => {
  it("按序拼接后与单行内容令牌一致", () => {
    const a = "GZ1.aaa";
    const b = "bbb";
    const c = "ccc";
    expect(joinChunks("data/u.json", 3, [a, b, c])).toBe("GZ1.aaabbbccc");
    expect(tokenOf("data/u.json", '{"__chunks__":3}', [a, b, c])).toBe(versionToken("GZ1.aaabbbccc"));
  });

  it("交换块顺序会改变令牌", () => {
    const t1 = tokenOf("data/u.json", '{"__chunks__":2}', ["A", "B"]);
    const t2 = tokenOf("data/u.json", '{"__chunks__":2}', ["B", "A"]);
    expect(t1).not.toBe(t2);
  });

  it("缺块或空洞抛 SnapshotIncompleteError，不拼接部分内容", () => {
    const err = (() => {
      try {
        joinChunks("data/u.json", 3, ["A", undefined, "C"]);
        return null;
      } catch (e) {
        return e as SnapshotIncompleteError;
      }
    })();
    expect(err).toBeInstanceOf(SnapshotIncompleteError);
    expect(err?.code).toBe("SNAPSHOT_INCOMPLETE");
    expect(err?.missing).toEqual([1]);
  });

  it("块数不足同样抛错（不把短数组当完整）", () => {
    expect(() => joinChunks("data/u.json", 3, ["A", "B"])).toThrow(SnapshotIncompleteError);
  });

  it("单行形态原样返回", () => {
    const raw = "GZ1.single";
    expect(logicalContent("data/u.json", raw)).toBe(raw);
    expect(tokenOf("data/u.json", raw)).toBe(versionToken(raw));
  });
});

describe("T-ICT-004 性能护栏", () => {
  it("8MB 逻辑内容令牌计算 < 200ms", () => {
    const big = "a".repeat(8 * 1024 * 1024);
    const t0 = performance.now();
    const token = versionToken(big);
    const cost = performance.now() - t0;
    expect(token.startsWith("md5:")).toBe(true);
    expect(cost).toBeLessThan(200);
  });
});