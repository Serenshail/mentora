import { describe, expect, it } from "vitest";
import { callSignature } from "../agent/protocol";

/* 回归锁：callSignature 曾用 JSON.stringify(args, Object.keys(args).sort()) 作 replacer。
 * replacer 数组是白名单且对每一层生效，嵌套对象会被滤成 {}，
 * 于是 {query:'react',opts:{depth:1}} 与 {query:'react',opts:{depth:99}} 签名相同，
 * runner 的打转守卫（runner.ts:247-249）会把仅嵌套参数不同的调用误判为重复调用。
 * 现在工具参数已有嵌套形状（如 edit_phase 的 changes），必须锁住。 */
describe("callSignature 嵌套参数", () => {
  it("嵌套对象内容不同 → 签名不同（原缺陷场景）", () => {
    const a = callSignature("search_brain", { query: "react", opts: { depth: 1 } });
    const b = callSignature("search_brain", { query: "react", opts: { depth: 99 } });
    expect(a).not.toBe(b);
  });

  it("edit_phase 的 changes 嵌套差异可区分", () => {
    const a = callSignature("edit_phase", { topic: "线性代数", changes: { phaseOrder: ["p1", "p2"] } });
    const b = callSignature("edit_phase", { topic: "线性代数", changes: { phaseOrder: ["p2", "p1"] } });
    expect(a).not.toBe(b);
  });

  it("嵌套数组里的对象不被清空", () => {
    const a = callSignature("edit_phase", {
      topic: "x",
      changes: { addPhases: [{ title: "阶段一" }] },
    });
    const b = callSignature("edit_phase", {
      topic: "x",
      changes: { addPhases: [{ title: "阶段二" }] },
    });
    expect(a).not.toBe(b);
    expect(a).not.toContain('"addPhases":[{}]');
  });

  it("嵌套键顺序无关", () => {
    expect(
      callSignature("edit_phase", { topic: "x", changes: { a: 1, b: 2 } })
    ).toBe(callSignature("edit_phase", { topic: "x", changes: { b: 2, a: 1 } }));
  });

  it("数组顺序仍然有意义", () => {
    expect(callSignature("reminders", { action: "create", days: [1, 2] })).not.toBe(
      callSignature("reminders", { action: "create", days: [2, 1] })
    );
  });

  it("扁平参数行为不变：顺序无关、值不同则签名不同", () => {
    expect(callSignature("search_brain", { query: "闭包", limit: 3 })).toBe(
      callSignature("search_brain", { limit: 3, query: "闭包" })
    );
    expect(callSignature("search_brain", { query: "闭包" })).not.toBe(
      callSignature("search_brain", { query: "协程" })
    );
  });

  it("循环引用不抛错（守卫不能中断整轮对话）", () => {
    const cyclic: Record<string, unknown> = { topic: "x" };
    cyclic.self = cyclic;
    expect(() => callSignature("edit_phase", cyclic)).not.toThrow();
    expect(callSignature("edit_phase", cyclic)).toContain("edit_phase:");
  });

  it("工具名参与签名", () => {
    expect(callSignature("search_brain", { query: "x" })).not.toBe(
      callSignature("web_search", { query: "x" })
    );
  });
});
