import type { ProviderId } from "@/lib/types";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  baseUrl: string;
  defaultModel: string;
  modelHints: string[];
  keyUrl?: string;
  note?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  demo: {
    id: "demo",
    name: "Demo 演示模式",
    baseUrl: "",
    defaultModel: "demo",
    modelHints: [],
    note: "无需 API Key，内置脚本化响应，用于体验完整流程",
  },
  zai: {
    id: "zai",
    name: "Z.ai (智谱 GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-4.6",
    modelHints: ["glm-4.6", "glm-5.3", "glm-5.3-flash", "glm-4.5-air"],
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    modelHints: ["deepseek-chat", "deepseek-reasoner"],
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2-0905-preview",
    modelHints: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "moonshot-v1-8k"],
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5-mini",
    modelHints: ["gpt-5-mini", "gpt-5", "gpt-4.1", "gpt-4o-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  custom: {
    id: "custom",
    name: "自定义 OpenAI 兼容端点",
    baseUrl: "",
    defaultModel: "",
    modelHints: [],
    note: "填入任意 OpenAI 兼容 base URL（如 OneAPI / Ollama / vLLM）",
  },
};

export interface AIConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
}
