import { describe, expect, it, vi } from "vitest";

/* 回归锁：update_settings 的 provider 白名单不再手抄数组，而是从 PROVIDERS
 * （Record<ProviderId, ProviderInfo>）派生。
 *  - 此前 tool-executors 里手抄了一份 7 项数组，给 ProviderId 加新 provider 时
 *    若忘了同步，新 provider 会被静默拒绝（漂移已实际发生过一次）。
 *  - 校验必须用 hasOwn 而非 in：in 走原型链，"constructor"/"toString" 会被误判合法。
 * 断言不写死 provider 名单（否则又成了第二份事实来源），只断言「PROVIDERS 的每个
 * key 都可用、非 key 都不可用」。 */

vi.mock("@/lib/ai/client", () => ({
  streamChat: vi.fn(async () => ""),
  extractJson: () => {
    throw new Error("no json");
  },
  readingPlanSchema: {},
  phaseListSchema: {},
}));
vi.mock("@/lib/store", () => ({
  useAppStore: {
    getState: () => ({ goals: [], knowledge: [], books: [], sessions: [], settings: {} }),
    setState: () => {},
    subscribe: () => () => {},
  },
}));
vi.mock("@/lib/book-verify", () => ({ verifyBook: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ buildContext: () => "", wikiRetrieve: () => [] }));
vi.mock("@/lib/track", () => ({ track: () => {} }));
vi.mock("@/lib/utils", () => ({
  uid: (p: string) => `${p}_test_${Math.random().toString(36).slice(2, 8)}`,
  todayISO: () => "2026-11-09",
}));
vi.mock("@/lib/resources", () => ({
  parseResourceConstraint: () => ({ resourceType: "video" }),
  classifyResource: () => ({}),
  validateResources: () => ({ verdicts: [] }),
}));

import { PROVIDERS } from "../ai/providers";
import { executeTool } from "../agent/tool-executors";

describe("用户新权限约束：智能体不操作设置", () => {
  it("PROVIDERS 里的每个 provider 都不能通过智能体修改", async () => {
    for (const id of Object.keys(PROVIDERS)) {
      const out = await executeTool("update_settings", { provider: id });
      expect(out.result.ok, `provider=${id} 应被阻止`).toBe(false);
      expect(out.action).toBeUndefined();
    }
  });

  it("不在 PROVIDERS 里的 provider 被拒绝", async () => {
    const out = await executeTool("update_settings", { provider: "not-a-provider" });
    expect(out.result.ok).toBe(false);
    expect(out.result.content).toContain("设置由用户本人");
    expect(out.action).toBeUndefined();
  });

  it("原型链属性不得被当成合法 provider（hasOwn 而非 in）", async () => {
    for (const evil of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const out = await executeTool("update_settings", { provider: evil });
      expect(out.result.ok, `provider=${evil} 必须被拒绝`).toBe(false);
      expect(out.action).toBeUndefined();
    }
  });
});
