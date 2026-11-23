import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 跨设备冲突：服务端必须有原子条件写（复核 §3） ============
 * 复核点名的现状：`applyPhaseEdit` 的 baseSignature 只比本地 store，
 * 而 `/api/sync` 是整份快照覆盖；PG 通道的 rdsPut 完全忽略 sha → 无任何并发控制。
 * 客户端「GET 后比对再写」在跨设备场景没有原子性。
 *
 * 本文件锁三件事：
 *  ① rdsPut 支持 expectSha 条件写（服务端原子）
 *  ② /api/sync 在客户端声明 baseSha 时走条件写，冲突返回 409
 *  ③ 不带 baseSha 的旧路径仍可写（兼容），但不会被当成"有并发保护"
 */

const dbSrc = readFileSync(fileURLToPath(new URL("../server/db.ts", import.meta.url)), "utf8");
const syncSrc = readFileSync(fileURLToPath(new URL("../../app/api/sync/route.ts", import.meta.url)), "utf8");

describe("① rdsPut 服务端条件写", () => {
  it("有 ConcurrentWriteError 类型，供上层区分冲突", () => {
    expect(dbSrc).toMatch(/export class ConcurrentWriteError/);
    expect(dbSrc).toMatch(/this\.name = "ConcurrentWriteError"/);
  });

  it("expectSha 非空时用条件 UPDATE（md5(v) 比对 + RETURNING）", () => {
    expect(dbSrc).toMatch(/UPDATE kv SET v = \$2 WHERE k = \$1 AND md5\(v\) = \$3 RETURNING k/);
  });

  it("expectSha === null 时用 ON CONFLICT DO NOTHING + RETURNING（只在不存在时插入）", () => {
    expect(dbSrc).toMatch(/INSERT INTO kv \(k, v\) VALUES \(\$1, \$2\) ON CONFLICT\(k\) DO NOTHING RETURNING k/);
  });

  it("影响 0 行就抛冲突（不能静默成功）", () => {
    expect(dbSrc).toMatch(/if \(updated\.length === 0\) throw new ConcurrentWriteError\(path\)/);
    expect(dbSrc).toMatch(/if \(rows\.length === 0\) throw new ConcurrentWriteError\(path\)/);
  });

  it("dbPut 的 rds 分支：只有 overwriteOnConflict 才无条件写", () => {
    expect(dbSrc).toMatch(/opts\.compareSnapshot \? \(opts\.sha \?\? null\) : opts\.overwriteOnConflict \? undefined : opts\.sha/);
    expect(dbSrc).toMatch(/await rdsPut\(path, content, expect\)/);
  });
});

describe("② /api/sync 冲突返回 409", () => {
  it("接受客户端声明的 baseVersion", () => {
    expect(syncSrc).toMatch(/const declaredBaseVersion = typeof parsed\.baseVersion === "string"/);
  });

  it("baseVersion 与当前快照不一致 → 409（服务端原子比对）", () => {
    expect(syncSrc).toMatch(/if \(currentVersion !== declaredBaseVersion\)/);
    expect(syncSrc).toMatch(/status: 409/);
    expect(syncSrc).toMatch(/conflict: true/);
    expect(syncSrc).toMatch(/currentVersion,/);
  });

  it("GET 把服务端版本标识返回给客户端（客户端才能声明 baseVersion）", () => {
    expect(syncSrc).toMatch(/const version = rest\.updatedAt \?\? _sha \?\? null/);
    expect(syncSrc).toMatch(/updatedAt: rest\.updatedAt, version/);
  });
});

describe("③ 兼容：不带 baseVersion 仍可写", () => {
  it("旧客户端（不带 baseVersion）跳过条件检查，走覆盖写", () => {
    /* declaredBaseVersion === undefined 时不进入条件分支 */
    expect(syncSrc).toMatch(/declaredBaseVersion !== undefined/);
    expect(syncSrc).toMatch(/overwriteOnConflict: true/);
  });
});
