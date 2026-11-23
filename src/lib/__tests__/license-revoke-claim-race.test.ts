import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁：revokeLicense 与 claimLicense 的竞态不得让已作废的卡密复活。
 *
 * 旧实现 revoke 是裸的 getLicense→dbPut 覆盖（无锁无版本校验），而 claimLicense 的
 * 时序是 读 rec(unused) → dbPutIfAbsent(claim) → dbPut(used)。作废若落在 claim 的
 * 读与写之间，claim 的写后到即胜（KV 通道 last-write-wins），已 revoked 的码以 used
 * 落库——作废泄漏卡密的应急操作被恰好并发的一次兑换静默抵消，该码此后永久有效。
 *
 * 修复：revoke 先写只增不改的墓碑（licenses/revoked/<sha>.json，dbPutIfAbsent 原子），
 * claim/releaseClaim 在写完记录后复核墓碑，读到即收敛回 revoked 并拒绝入账。
 * 本文件用内存 KV 替身跑，不碰远端库：
 *  1) 作废恰好插在 claim 的"读到写"之间 → claim 返回 REVOKED，记录收敛为 revoked；
 *  2) 记录被别处覆盖回 unused（模拟 last-write-wins）→ 墓碑仍让 claim 拒绝；
 *  3) releaseClaim 回滚不得把已作废的码还原成 unused；
 *  4) 写后复核读失败 → 拒绝入账且不把码烧成 revoked（回滚成 unused 供重试）；
 *  5) 常规路径（无作废）不受影响，重复作废幂等。 */

const state = vi.hoisted(() => ({
  /** 下一次 dbPutIfAbsent 前插入的钩子（模拟作废落在 claim 读与写之间） */
  onPutIfAbsent: null as null | ((path: string) => Promise<void>),
  /** 第 N 次读墓碑时抛错（1 = claim 的前置检查，2 = 写后复核） */
  failTombstoneReadAt: 0,
  tombstoneReads: 0,
}));

const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  emailHash: (email: string) => Buffer.from(email.toLowerCase()).toString("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => {
    if (path.startsWith("licenses/revoked/")) {
      state.tombstoneReads++;
      if (state.failTombstoneReadAt === state.tombstoneReads) throw new Error("DB 读取失败（500）");
    }
    return store.has(path) ? structuredClone(store.get(path)) : null;
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbPutIfAbsent: vi.fn(async (path: string, value: unknown) => {
    const hook = state.onPutIfAbsent;
    if (hook) {
      state.onPutIfAbsent = null; // 先摘钩子，避免 revoke 内部再次触发（无递归）
      await hook(path);
    }
    if (store.has(path)) return false;
    store.set(path, structuredClone(value));
    return true;
  }),
  dbDelete: vi.fn(async (path: string) => {
    store.delete(path);
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  ),
}));

import { createHash } from "node:crypto";
import { claimLicense, createBatch, getLicense, releaseClaim, revokeLicense } from "../server/license";

const codeHash = (raw: string) => createHash("sha256").update(raw.replace(/[^0-9A-Z]/g, "")).digest("hex");
const licensePath = (code: string) => `licenses/${codeHash(code)}.json`;
const claimPath = (code: string) => `claim/${codeHash(code)}.json`;
const revokePath = (code: string) => `licenses/revoked/${codeHash(code)}.json`;

async function freshCode(): Promise<string> {
  const { codes } = await createBatch({ count: 1, plan: "month", createdBy: "t" });
  return codes[0];
}

beforeEach(() => {
  store.clear();
  state.onPutIfAbsent = null;
  state.failTombstoneReadAt = 0;
  state.tombstoneReads = 0;
});

describe("revoke 与 claim 竞态：已作废的码不得以 used 复活", () => {
  it("作废落在 claim 的读与写之间 → claim 返回 REVOKED，记录收敛为 revoked", async () => {
    const code = await freshCode();
    // 钩子命中 claim 的原子占用：此刻 claim 已读完 rec(unused)，尚未写 used
    state.onPutIfAbsent = async (path) => {
      if (path === claimPath(code)) await revokeLicense(code);
    };

    const res = await claimLicense(code, { email: "a@x.com", userId: "u-a" });

    // 修复前：claim 的 dbPut(used) 后到覆盖 revoked，这里会返回 ok:true（卡密复活）
    expect(res).toMatchObject({ ok: false, reason: "REVOKED" });
    const rec = await getLicense(code);
    expect(rec?.status).toBe("revoked");
    expect(rec?.usedBy).toBeNull();
    expect(store.has(claimPath(code))).toBe(false); // 占用标记已撤，不卡住后台核对
    expect(store.has(revokePath(code))).toBe(true); // 墓碑已落库

    // 再兑一次仍被墓碑拦住
    const retry = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(retry).toMatchObject({ ok: false, reason: "REVOKED" });
  });

  it("记录被别处覆盖回 unused（last-write-wins）时，墓碑仍拒绝兑换", async () => {
    const code = await freshCode();
    await revokeLicense(code);
    // 模拟另一条路径把记录整档覆盖回 unused（旧版 releaseClaim/人工复位现场）
    const rec = await getLicense(code);
    store.set(licensePath(code), { ...rec, status: "unused", usedBy: null });

    const res = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(res).toMatchObject({ ok: false, reason: "REVOKED" });
    expect(store.has(claimPath(code))).toBe(false);
  });

  it("releaseClaim 回滚不把已作废的码还原成 unused", async () => {
    const code = await freshCode();
    const claimed = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(claimed.ok).toBe(true);

    await revokeLicense(code);
    await releaseClaim(code); // 模拟写档案失败后的补偿

    const rec = await getLicense(code);
    expect(rec?.status).toBe("revoked"); // 修复前这里会回到 unused，码重新可兑
  });

  it("记录仍显示 used、但墓碑已存在 → releaseClaim 绝不还原成 unused", async () => {
    const code = await freshCode();
    const claimed = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(claimed.ok).toBe(true);

    await revokeLicense(code);
    /* 构造「回滚读到旧快照」的现场：作废已落墓碑，但记录被覆盖回 used（last-write-wins）。
     * 旧的 releaseClaim 只按记录状态判断，会把它还原成 unused 让码重新可兑；
     * 新增的墓碑守卫必须挡住。 */
    const revoked = await getLicense(code);
    store.set(licensePath(code), { ...revoked, status: "used", usedBy: (claimed as { license: { usedBy: unknown } }).license.usedBy });

    await releaseClaim(code);

    const after = await getLicense(code);
    expect(after?.status).not.toBe("unused"); // 关键断言：绝不能回到可兑状态
    expect(store.has(claimPath(code))).toBe(true);
  });

  it("写后复核墓碑读失败 → 拒绝入账，且把码回滚成 unused 而不是烧成 revoked", async () => {
    const code = await freshCode();
    state.failTombstoneReadAt = 2; // 第 2 次读 = claim 写 used 之后的复核

    const res = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(res).toMatchObject({ ok: false, reason: "DB" });

    const rec = await getLicense(code);
    expect(rec?.status).toBe("unused"); // 无法证明已作废时绝不烧码（后台无恢复入口）
    expect(rec?.usedBy).toBeNull();
    expect(store.has(claimPath(code))).toBe(false);

    // 复核读恢复后同一张码可以正常兑换（不因一次 KV 抖动永久作废）
    state.failTombstoneReadAt = 0;
    const retry = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(retry.ok).toBe(true);
  });

  it("常规路径不受影响：无墓碑时正常兑换；重复作废幂等", async () => {
    const code = await freshCode();
    const ok = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(ok.ok).toBe(true);
    expect((await getLicense(code))?.status).toBe("used");

    const first = await revokeLicense(code);
    const second = await revokeLicense(code);
    expect(first?.status).toBe("revoked");
    expect(second?.status).toBe("revoked");
    expect((await getLicense(code))?.status).toBe("revoked");
    expect(store.has(revokePath(code))).toBe(true);
  });

  it("作废后兑换一律 REVOKED（先作废再兑，基础语义不回退）", async () => {
    const code = await freshCode();
    await revokeLicense(code);
    const res = await claimLicense(code, { email: "a@x.com", userId: "u-a" });
    expect(res).toMatchObject({ ok: false, reason: "REVOKED" });
    expect(store.has(claimPath(code))).toBe(false);
  });
});
