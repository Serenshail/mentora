import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ai-config.ts 是服务端模块（import "server-only"），在 vitest 里需要豁免该护栏 */
vi.mock("server-only", () => ({}));

import { PROVIDERS } from "../ai/providers";
import { resolveByok, serverConfig } from "../server/ai-config";

/* ============ 模型层双通道回归锁（HW-M-01/03/08） ============
 * maas 为部署默认显式通道；旧服务商并存不受影响；
 * 切换 env 即切通道，无需代码变更；无任何 Key 时演示模式兜底。 */

const ENV_KEYS = [
  "AI_PROVIDER", "AI_BASE_URL", "AI_MODEL",
  "MAAS_API_KEY", "MAAS_BASE_URL",
  "DEEPSEEK_API_KEY", "ZAI_API_KEY", "MOONSHOT_API_KEY", "OPENAI_API_KEY", "CUSTOM_API_KEY",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function fakeReq(headers: Record<string, string>): Parameters<typeof resolveByok>[0] {
  return { headers: new Headers(headers) };
}

describe("serverConfig：maas 显式通道（部署默认路径）", () => {
  it("AI_PROVIDER=maas + MAAS_API_KEY → 走注册表 baseUrl 与默认模型", () => {
    process.env.AI_PROVIDER = "maas";
    process.env.MAAS_API_KEY = "test-key";
    const cfg = serverConfig();
    expect(cfg.provider).toBe("maas");
    expect(cfg.baseUrl).toBe("https://api.modelarts-maas.com/v1");
    expect(cfg.model).toBe("DeepSeek-V3.1");
  });

  it("MAAS_BASE_URL 可覆盖端点（Region/专属）", () => {
    process.env.AI_PROVIDER = "maas";
    process.env.MAAS_API_KEY = "test-key";
    process.env.MAAS_BASE_URL = "https://maas.example.cn/v1";
    const cfg = serverConfig();
    expect(cfg.provider).toBe("maas");
    expect(cfg.baseUrl).toBe("https://maas.example.cn/v1");
  });

  it("AI_MODEL 可覆盖默认模型", () => {
    process.env.AI_PROVIDER = "maas";
    process.env.MAAS_API_KEY = "test-key";
    process.env.AI_MODEL = "DeepSeek-R1";
    expect(serverConfig().model).toBe("DeepSeek-R1");
  });

  it("AI_PROVIDER=maas 但 MAAS_API_KEY 缺失 → 遍历兜底旧服务商（不劣化）", () => {
    process.env.AI_PROVIDER = "maas";
    process.env.DEEPSEEK_API_KEY = "ds-key";
    const cfg = serverConfig();
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("MAAS_BASE_URL 无 Key 单独存在 → 不得误配（仍遍历兜底）", () => {
    process.env.AI_PROVIDER = "maas";
    process.env.MAAS_BASE_URL = "https://maas.example.cn/v1";
    process.env.DEEPSEEK_API_KEY = "ds-key";
    const cfg = serverConfig();
    expect(cfg.provider).toBe("deepseek");
    expect(cfg.baseUrl).toBe("https://api.deepseek.com/v1");
  });
});

describe("serverConfig：遍历兜底与演示模式（旧行为不变）", () => {
  it("不设 AI_PROVIDER、只设 MAAS_API_KEY → 遍历命中 maas", () => {
    process.env.MAAS_API_KEY = "test-key";
    const cfg = serverConfig();
    expect(cfg.provider).toBe("maas");
  });

  it("不设 AI_PROVIDER、只设旧服务商 Key → 行为与历史一致", () => {
    process.env.DEEPSEEK_API_KEY = "ds-key";
    const cfg = serverConfig();
    expect(cfg.provider).toBe("deepseek");
  });

  it("全部未配置 → 演示模式（HW-M-05）", () => {
    const cfg = serverConfig();
    expect(cfg).toEqual({ provider: "demo", baseUrl: "", apiKey: "", model: "demo" });
  });

  it("custom 显式端点路径不受 maas 引入影响（custom 无默认模型，须配 AI_MODEL，缺即回 demo 为历史语义）", () => {
    process.env.AI_PROVIDER = "custom";
    process.env.AI_BASE_URL = "https://llm.example.com/v1";
    process.env.CUSTOM_API_KEY = "ck";
    const noModel = serverConfig();
    expect(noModel.provider).toBe("demo");
    process.env.AI_MODEL = "my-model";
    const cfg = serverConfig();
    expect(cfg.provider).toBe("custom");
    expect(cfg.baseUrl).toBe("https://llm.example.com/v1");
    expect(cfg.model).toBe("my-model");
  });
});

describe("resolveByok：BYOK maas 请求（Key 与 baseUrl 同源铁律）", () => {
  it("x-mentora-provider=maas → 注册表 baseUrl，客户端 Key 装车", () => {
    const r = resolveByok(fakeReq({ "x-mentora-provider": "maas", "x-mentora-model": "DeepSeek-R1" }), "user-key") as Exclude<
      ReturnType<typeof resolveByok>,
      Promise<unknown>
    >;
    if ("error" in r) throw new Error(r.error);
    expect(r.provider).toBe("maas");
    expect(r.baseUrl).toBe("https://api.modelarts-maas.com/v1");
    expect(r.apiKey).toBe("user-key");
    expect(r.model).toBe("DeepSeek-R1");
  });

  it("未传 model → 用注册表 defaultModel", () => {
    const r = resolveByok(fakeReq({ "x-mentora-provider": "maas" }), "user-key") as Exclude<
      ReturnType<typeof resolveByok>,
      Promise<unknown>
    >;
    if ("error" in r) throw new Error(r.error);
    expect(r.model).toBe("DeepSeek-V3.1");
  });
});

describe("PROVIDERS 注册表：maas 增补后旧服务商零劣化（HW-M-03）", () => {
  it("旧服务商条目完整保留", () => {
    for (const id of ["demo", "zai", "deepseek", "moonshot", "openai", "custom"] as const) {
      expect(PROVIDERS[id], `缺失旧服务商 ${id}`).toBeDefined();
    }
    expect(PROVIDERS.deepseek.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(PROVIDERS.openai.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("maas 条目契约完整（baseUrl/model/keyUrl）", () => {
    const m = PROVIDERS.maas;
    expect(m.baseUrl).toMatch(/^https:\/\/api\.modelarts-maas\.com\/v1\/?$/);
    expect(m.defaultModel.length).toBeGreaterThan(0);
    expect(m.modelHints.length).toBeGreaterThan(0);
    expect(m.keyUrl).toContain("huaweicloud.com");
  });
});