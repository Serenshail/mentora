import { describe, expect, it } from "vitest";

/* Node 环境没有 localStorage：zustand persist 写盘会走 safeStorage（内部 try/catch），
 * 这里仍给一份最小内存实现，保证 partialize/migrate 行为与浏览器一致。 */
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
    configurable: true,
  });
}

import { useAppStore } from "../store";
import type { ChatMsg } from "../types";

/* ============ agentChat 内存字段已移除，v6/v7 迁移仍读磁盘快照 ============
 * 旧实现把恒为空数组的 agentChat 留在内存态：partialize 每次落盘它、bindStoreSync
 * 回采它、clearAgentChat 维护 legacy 分支，而注释称「仅作 v6 迁移源」——但迁移读的是
 * 磁盘快照原文（migrateState 的入参），内存字段根本不是迁移源，纯属误导。
 * 本锁钉死：内存态与 partialize 都不再有 agentChat；v6 旧快照的迁移包装仍然生效。 */

describe("agentChat 已从内存态/持久化中移除", () => {
  it("内存状态不再有 agentChat 字段", () => {
    expect("agentChat" in useAppStore.getState()).toBe(false);
  });

  it("partialize 不再落盘 agentChat（避免每次写盘一个恒空字段）", () => {
    const partialize = useAppStore.persist.getOptions().partialize;
    expect(typeof partialize).toBe("function");
    const out = partialize!(useAppStore.getState()) as Record<string, unknown>;
    expect("agentChat" in out).toBe(false);
    expect("agentSessions" in out).toBe(true);
  });

  it("v6 旧快照的 agentChat 仍被迁移包装成「历史对话」会话", () => {
    const migrate = useAppStore.persist.getOptions().migrate;
    expect(typeof migrate).toBe("function");
    const legacy: ChatMsg[] = [
      { id: "m1", role: "user", content: "你好", at: "2026-01-01T00:00:00.000Z" },
      { id: "m2", role: "assistant", content: "在的", at: "2026-01-01T00:00:01.000Z" },
    ];
    const out = migrate!({ agentChat: legacy }, 6) as {
      agentSessions?: { messages: ChatMsg[] }[];
    };
    expect(out.agentSessions).toHaveLength(1);
    expect(out.agentSessions![0].messages).toEqual(legacy);
  });
});
