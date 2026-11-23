import { beforeEach, describe, expect, it } from "vitest";

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

import { DEFAULT_SETTINGS, useAppStore } from "../store";

/* ============ 备份/云恢复：customPersonas 必须做字段级归一 ============
 * 旧实现是 sanitizeBackup 里唯一「零字段校验就 as unknown as 强转」的实体
 * （goals/knowledge/books/sessions 都补默认值）。一份缺 system/缺 id 的脏 persona
 * 经备份导入后：council 会把 undefined 当系统提示词发给模型 API，列表渲染 key 冲突。
 * 本锁钉死导入后的必填字符串字段均已补齐（缺 id 用 uid 兜底）。
 * 注：identityNote 必须存在——council 的 isCustomPersona 以 `"identityNote" in p` 判定。 */

const importData = (data: unknown) => useAppStore.getState().importData(data);

beforeEach(() => {
  useAppStore.setState({
    goals: [],
    knowledge: [],
    books: [],
    sessions: [],
    customPersonas: [],
    folders: [],
    settings: { ...DEFAULT_SETTINGS, provider: "demo" },
  });
});

describe("sanitizeBackup：customPersonas 字段归一", () => {
  it("缺 id/system/identityNote 的脏 persona 被补齐为字符串（不再是 undefined）", () => {
    expect(importData({ customPersonas: [{ name: "张三" }] })).toBe(true);
    const p = useAppStore.getState().customPersonas[0];
    expect(typeof p.id).toBe("string");
    expect(p.id.length).toBeGreaterThan(0);
    expect(typeof p.system).toBe("string");
    expect(p.system).toBe("");
    expect(typeof p.identityNote).toBe("string");
    expect("identityNote" in p).toBe(true);
    expect(typeof p.name).toBe("string");
    expect(typeof p.createdAt).toBe("string");
  });

  it("类型错乱的字段被收敛为字符串默认值", () => {
    expect(importData({ customPersonas: [{ id: 123, system: { bad: true }, bio: [] }] })).toBe(true);
    const p = useAppStore.getState().customPersonas[0];
    expect(typeof p.id).toBe("string");
    expect(typeof p.system).toBe("string");
    expect(typeof p.bio).toBe("string");
  });

  it("合法 persona 字段原样保留", () => {
    expect(
      importData({
        customPersonas: [
          {
            id: "custom:abc",
            name: "费曼",
            tag: "物理",
            bio: "讲清楚",
            color: "#123456",
            identityNote: "理论物理学家",
            system: "你是费曼",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
    ).toBe(true);
    const p = useAppStore.getState().customPersonas[0];
    expect(p).toMatchObject({
      id: "custom:abc",
      name: "费曼",
      system: "你是费曼",
      identityNote: "理论物理学家",
    });
  });
});
