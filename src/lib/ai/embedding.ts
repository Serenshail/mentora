import "server-only";

/* ============================================================
 * 嵌入向量（T-070，HW-M-09）：华为云 MaaS 嵌入端点（OpenAI 兼容 /embeddings）
 *
 * 服务端专用（server-only）：嵌入凭据绝不下发浏览器。
 * 容错契约：未配置（缺 EMBED_MODEL 或任何 Key）→ null；
 * 网络失败 / 非 2xx / 响应结构异常 → null。调用方（RAG 混排）据此回退纯 BM25。
 * 本仓当前 RAG 链路在浏览器本地执行（wikiRetrieve/BM25），本模块为服务端
 * 检索就绪组件：服务端化检索时以 retrieveAsync(..., { embed: embedText }) 接入。
 * ============================================================ */

export interface EmbedConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function embedConfig(): EmbedConfig | null {
  const model = process.env.EMBED_MODEL?.trim();
  if (!model) return null;
  const apiKey = (process.env.EMBED_API_KEY || process.env.MAAS_API_KEY || "").trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.EMBED_BASE_URL || process.env.MAAS_BASE_URL || "https://api.modelarts-maas.com/v1").replace(/\/+$/, "");
  return { apiKey, baseUrl, model };
}

/** 批量嵌入。任何失败返回 null（绝不抛错——嵌入是增强项，故障不能影响主流程）。 */
export async function embedText(texts: string[]): Promise<number[][] | null> {
  const cfg = embedConfig();
  if (!cfg || texts.length === 0) return null;
  try {
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { embedding?: unknown; index?: number }[] };
    if (!Array.isArray(j.data) || j.data.length !== texts.length) return null;
    const out: number[][] = [];
    for (const d of j.data) {
      if (!Array.isArray(d.embedding) || typeof d.embedding[0] !== "number") return null;
      out.push(d.embedding);
    }
    return out;
  } catch {
    return null;
  }
}

/** 余弦相似度（向量混排用） */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}