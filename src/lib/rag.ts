/* ============================================================
 * RAG 检索第一步：词法检索（BM25 简化版，中文按二元组切词）
 * —— 不需要任何额外 API Key，本地即可跑；
 * 向量检索（embedding）留有同名接口：配置嵌入模型后可无缝升级，
 * 检索结果统一走 retrieve()，上层对话无感。
 * ============================================================ */

export interface RagDoc {
  id: string;
  title: string;
  body: string;
  domain?: string;
}

export interface RagHit {
  doc: RagDoc;
  score: number;
}

/** 中文二元组 + 英文单词的极简分词 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const ascii = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  tokens.push(...ascii);
  const cjk = text.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
  if (cjk.length === 1) tokens.push(cjk);
  return tokens;
}

/** BM25（k1=1.5, b=0.75） */
export function bm25Search(
  query: string,
  docs: RagDoc[],
  k = 3,
  opts: { k1?: number; b?: number } = {}
): RagHit[] {
  if (docs.length === 0) return [];
  const { k1 = 1.5, b = 0.75 } = opts;

  const docsTokens = docs.map((d) => tokenize(`${d.title} ${d.title} ${d.body}`)); // 标题权重 ×2
  const avgLen = docsTokens.reduce((a, t) => a + t.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const tokens of docsTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length;
  const qTokens = [...new Set(tokenize(query))];

  const scored = docs.map((doc, i) => {
    const tokens = docsTokens[i];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const len = tokens.length;
    let score = 0;
    for (const qt of qTokens) {
      const f = tf.get(qt);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(qt) ?? 0) + 0.5) / ((df.get(qt) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { doc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** 上层统一入口：现在走 BM25；接入嵌入模型后这里切换/混排向量检索 */
export function retrieve(query: string, docs: RagDoc[], k = 3): RagHit[] {
  return bm25Search(query, docs, k);
}

/** 把检索结果压成可注入提示词的上下文块 */
export function ragContext(hits: RagHit[], maxChars = 1200): string {
  let out = "";
  for (const h of hits) {
    const block = `《${h.doc.title}》${h.doc.body.replace(/\[\[|\]\]/g, "").slice(0, 220)}`;
    if (out.length + block.length > maxChars) break;
    out += (out ? "\n" : "") + `- ${block}`;
  }
  return out;
}
