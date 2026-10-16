import "server-only";
import { PROVIDERS, type AIConfig } from "../ai/providers";
import { assertSafePublicUrl } from "./url-guard";

/* 请求头最小结构（兼容 NextRequest，避免依赖 next/server 以便单测） */
interface HeaderLike {
  headers: { get(name: string): string | null };
}

/* ============================================================
 * 模型配置解析（v17 安全重构；v19 从 chat/route.ts 抽出以便单测）
 *
 * 旧版的洞：客户端头可以拼出"服务端 Key + 攻击者 baseUrl"的组合
 * （provider=deepseek 不带 key → env Key 装上车，baseurl 头无白名单 →
 * Bearer <部署者 Key> 直接发给攻击者 URL）——公开提款机。
 *
 * 新版铁律：**Key 与 baseUrl 必须同源**，不存在任何混配路径：
 *  · BYOK：客户端给了自己的 Key。baseUrl 只来自①内置服务商表（服务端常量）
 *    或②custom 端点（必须过 url-guard：公网 https + DNS 解析取证）。
 *    外发的 Authorization 里只有用户自己的 Key，泄的是他自己。
 *  · 服务端模式：客户端没给 Key。provider/baseUrl/model **全部来自 env**，
 *    客户端头一概无视。未配置任何 Key → 演示脚本（不花钱，不登录也能玩）。
 *
 * 双通道（HW-M-08）：AI_PROVIDER=maas 显式指定华为云 MaaS 为部署默认；
 * 不设置时按 envKeys 遍历兜底（旧服务商并存，行为与历史一致）；
 * 切换 env 即切通道，无需代码变更，旧通道不被移除或劣化。
 * ============================================================ */

export type ErrRes = { error: string; status: number };

function envKeys(): Record<string, string> {
  return {
    zai: process.env.ZAI_API_KEY || "",
    deepseek: process.env.DEEPSEEK_API_KEY || "",
    moonshot: process.env.MOONSHOT_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || "",
    maas: process.env.MAAS_API_KEY || "",
  };
}

export function resolveByok(req: HeaderLike, userKey: string): Promise<AIConfig | ErrRes> | AIConfig | ErrRes {
  const header = (n: string) => req.headers.get(n) || "";
  const provider = header("x-mentora-provider");
  const model = header("x-mentora-model");

  if (provider === "custom") {
    // custom 端点唯一允许客户端指定 baseUrl 的地方——必须过出网守卫（禁 https 之外/内网/元数据）
    const raw = header("x-mentora-baseurl");
    return (async () => {
      const guard = await assertSafePublicUrl(raw, { allowHttp: false });
      if (!guard.ok) return { error: `自定义端点不可用：${guard.reason}（需为公网 HTTPS 地址）`, status: 400 } satisfies ErrRes;
      if (!model) return { error: "自定义端点请同时填写模型名", status: 400 } satisfies ErrRes;
      return { provider: "custom", baseUrl: raw, apiKey: userKey, model } satisfies AIConfig;
    })();
  }

  if (provider && provider !== "demo" && provider in PROVIDERS) {
    const info = PROVIDERS[provider as keyof typeof PROVIDERS];
    return { provider: info.id, baseUrl: info.baseUrl, apiKey: userKey, model: model || info.defaultModel };
  }
  return { error: "已提供 API Key，但没有选择对应的服务商", status: 400 };
}

export function serverConfig(): AIConfig {
  const keys = envKeys();
  const envProvider = process.env.AI_PROVIDER || "";
  let provider = "";
  let apiKey = "";
  let baseUrl = "";
  if (envProvider === "custom" && process.env.AI_BASE_URL) {
    provider = "custom";
    baseUrl = process.env.AI_BASE_URL;
    apiKey = process.env.CUSTOM_API_KEY || "";
  } else if (envProvider === "maas" && process.env.MAAS_API_KEY && process.env.MAAS_BASE_URL) {
    // MaaS 专属/Region 端点可覆盖；缺省走注册表内置地址；Key 缺失不得进此分支（保持遍历兜底，不劣化）
    provider = "maas";
    baseUrl = process.env.MAAS_BASE_URL;
    apiKey = process.env.MAAS_API_KEY || "";
  } else if (envProvider && keys[envProvider]) {
    provider = envProvider;
    apiKey = keys[envProvider];
  } else {
    for (const [p, k] of Object.entries(keys)) {
      if (k) { provider = p; apiKey = k; break; }
    }
  }
  if (!provider || !apiKey) return { provider: "demo", baseUrl: "", apiKey: "", model: "demo" };
  const info = PROVIDERS[provider as keyof typeof PROVIDERS] ?? PROVIDERS.demo;
  const model = process.env.AI_MODEL || info.defaultModel;
  if (!model) return { provider: "demo", baseUrl: "", apiKey: "", model: "demo" };
  return { provider: info.id, baseUrl: baseUrl || info.baseUrl, apiKey, model };
}