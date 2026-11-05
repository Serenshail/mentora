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
  /** 内容版本：同一知识点多文档时,高版本优先（旧版教材不混入检索） */
  version?: number;
  /** 最近更新时间（ISO）：同版本时越新越优先 */
  updatedAt?: string;
  /** 标签：与查询命中时作为轻量先验加分 */
  tags?: string[];
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

/** 分词缓存：一条消息里的检索链路会多次遍历同一批语料（基线 + 融合 + 图导航），
 *  每次都对每篇标题+正文重分词是纯浪费——笔记内容不变时结果必然相同。
 *  键带 version/updatedAt，改动过的笔记自动失效；超过上限整表清空（够用且不泄漏）。 */
const tokenCache = new Map<string, string[]>();
function cachedTokens(d: RagDoc): string[] {
  const key = `${d.id}|${d.version ?? 0}|${d.updatedAt ?? ""}`;
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const t = tokenize(`${d.title} ${d.title} ${d.body}`); // 标题权重 ×2
  if (tokenCache.size > 5000) tokenCache.clear();
  tokenCache.set(key, t);
  return t;
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

  const docsTokens = docs.map((d) => cachedTokens(d));
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

/** 同一知识点出现多份文档时的裁决：保留 version 更高者；同版本取 updatedAt 更新者。
 *  这样旧版教材/过期笔记不会和新版一起混进检索结果（"冲突了听谁的"= 听更新、版本更高的）。 */
export function dedupeConflicts(docs: RagDoc[]): RagDoc[] {
  const best = new Map<string, RagDoc>();
  for (const d of docs) {
    const key = d.title.trim().toLowerCase();
    const cur = best.get(key);
    if (!cur) { best.set(key, d); continue; }
    const dv = d.version ?? 1, cv = cur.version ?? 1;
    const du = d.updatedAt ?? "", cu = cur.updatedAt ?? "";
    if (dv > cv || (dv === cv && du > cu)) best.set(key, d);
  }
  return [...best.values()];
}

/** 上层统一入口：先做冲突裁决,再 BM25,最后叠加标签/更新度轻量先验重排。
 *  接入嵌入模型后在此切换/混排向量检索,上层无感。 */
export function retrieve(query: string, docs: RagDoc[], k = 3): RagHit[] {
  const clean = dedupeConflicts(docs);
  const hits = bm25Search(query, clean, k * 2);
  const qTokens = new Set(tokenize(query));
  const reranked = hits.map((h) => {
    let score = h.score;
    if ((h.doc.tags ?? []).some((t) => qTokens.has(t.toLowerCase()))) score += 0.5;
    const ts = h.doc.updatedAt ? Date.parse(h.doc.updatedAt) : 0;
    if (ts) score += Math.min(0.3, ts / 1e13); // 越新越优先的微小先验,不压过相关性
    return { ...h, score };
  });
  return reranked.sort((a, b) => b.score - a.score).slice(0, k);
}

/* ========= 向量混排（T-070，HW-M-09）=========
 * BM25 + 向量的 RRF（Reciprocal Rank Fusion）合并。rag.ts 保持客户端可引：
 * 不 import server-only 模块，嵌入函数由服务端调用方注入（见 lib/ai/embedding.ts）。
 * 未注入 / 嵌入失败 → 与现状完全一致的纯 BM25 结果（上层无感回退）。 */

/** RRF 混排纯函数：k=60 为论文标准常数；同 id 跨列表贡献累加 */
export function rrfMerge(bm25Hits: RagHit[], vectorOrder: string[], k = 3, rrfK = 60): RagHit[] {
  const byId = new Map<string, RagHit>();
  const add = (id: string, rank: number) => {
    const hit = bm25Hits.find((h) => h.doc.id === id) ?? byId.get(id);
    if (!hit) return;
    byId.set(id, { ...hit, score: (byId.get(id)?.score ?? 0) + 1 / (rrfK + rank) });
  };
  bm25Hits.forEach((h, i) => add(h.doc.id, i + 1));
  vectorOrder.forEach((id, i) => add(id, i + 1));
  const merged = [...byId.values()];
  /* 打分窗口截断到两个列表并集后统一重排，取前 k */
  return merged.sort((a, b) => b.score - a.score).slice(0, k);
}

/* 余弦相似度（内联：rag.ts 客户端可引，不得 import server-only 模块） */
function cosine(a: number[], b: number[]): number {
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

/** 异步混排入口（服务端检索用）：embed 注入；返回 null / 抛错 → 纯 BM25（行为与 retrieve 一致） */
export async function retrieveAsync(
  query: string,
  docs: RagDoc[],
  k: number,
  embed: (texts: string[]) => Promise<number[][] | null>
): Promise<RagHit[]> {
  const clean = dedupeConflicts(docs);
  const bm25Hits = bm25Search(query, clean, k * 2);
  try {
    const qv = await embed([query]);
    if (qv && qv[0]) {
      const docTexts = bm25Hits.map((h) => `${h.doc.title}\n${h.doc.body.slice(0, 2000)}`);
      const dv = await embed(docTexts);
      if (dv) {
        const vectorOrder = bm25Hits
          .map((h, i) => ({ id: h.doc.id, sim: cosine(qv[0], dv[i]) }))
          .sort((a, b) => b.sim - a.sim)
          .map((x) => x.id);
        return rrfMerge(bm25Hits, vectorOrder, k);
      }
    }
  } catch { /* 嵌入链路任何故障 → 回退 BM25 */ }
  return bm25Hits.sort((a, b) => b.score - a.score).slice(0, k);
}

/* ========= LLMWiki 导航式检索 =========
 * 知识库被视为一张"编译型 wiki"而非散文档堆：检索不是纯相似性匹配,
 * 而是 BM25 种子 → 沿 [[wikilink]] 一出/一进扩展(图导航) → hub/MOC 与标签加权。
 * 链接越密的知识网络检索越准——这是随使用复利的护城河。 */
export interface WikiNote {
  id: string;
  title: string;
  body: string;
  domain?: string;
  links?: string[];
  tags?: string[];
  version?: number;
  updatedAt?: string;
}

export function wikiRetrieve(query: string, notes: WikiNote[], k = 3): RagHit[] {
  const clean = dedupeConflicts(
    notes.map((n) => ({
      id: n.id, title: n.title, body: n.body, domain: n.domain,
      version: n.version, updatedAt: n.updatedAt, tags: n.tags,
    }))
  );
  const byId = new Map(clean.map((n) => [n.id, n]));
  const linksOf = new Map(notes.map((n) => [n.id, n.links ?? []]));
  const seeds = bm25Search(query, clean, k * 2);
  const scores = new Map<string, number>();
  for (const s of seeds) scores.set(s.doc.id, s.score);

  // 反向链接索引（谁链向我）
  const reverse = new Map<string, string[]>();
  for (const n of notes) {
    for (const l of n.links ?? []) {
      const arr = reverse.get(l) ?? [];
      arr.push(n.id);
      reverse.set(l, arr);
    }
  }
  // 图导航：种子的一跳邻居(出链 0.5 / 入链 0.4 衰减)进入候选
  for (const s of seeds) {
    const n = byId.get(s.doc.id);
    if (!n) continue;
    for (const l of linksOf.get(n.id) ?? []) scores.set(l, Math.max(scores.get(l) ?? 0, s.score * 0.5));
    for (const r of reverse.get(n.id) ?? []) scores.set(r, Math.max(scores.get(r) ?? 0, s.score * 0.4));
  }

  const qTokens = new Set(tokenize(query));
  /* 图导航会把出链/入链 id 写进 scores，但这些 id 不保证仍在 clean 里
   * （MOC 被调用方过滤、dedupeConflicts 淘汰的旧版仍留在 reverse 索引）。
   * 旧实现用 byId.get(id)! 非空断言，拿到 undefined 后读 tags 直接 TypeError，
   * 常规笔记内容就能把整条检索链路打崩。这里直接跳过不在 byId 的候选。 */
  const ranked: RagHit[] = [];
  for (const [id, score] of scores) {
    const n = byId.get(id);
    if (!n) continue;
    let s = score;
    if ((n.tags ?? []).includes("MOC")) s += 0.3; // hub/目录页加权
    if ((n.tags ?? []).some((t) => qTokens.has(t.toLowerCase()))) s += 0.5;
    const ts = n.updatedAt ? Date.parse(n.updatedAt) : 0;
    if (ts) s += Math.min(0.3, ts / 1e13);
    ranked.push({
      doc: { id: n.id, title: n.title, body: n.body, domain: n.domain, version: n.version, updatedAt: n.updatedAt, tags: n.tags },
      score: s,
    });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, k);
}

/* ========= 上下文构建（回答质量的第一道闸，2026-10-26 重构）=========
 * 旧实现「每篇只取正文前 220 字、总上限 1200」有两个硬伤：
 *   ① 长笔记的关键定义/结论常在后半段，被腰斩后模型只能看到开头 → 回答空洞；
 *   ② 注入的是原始片段堆叠，模型分不清哪条是定义、哪条是边界、哪条是例子。
 * 新做法：
 *   ① 按 Markdown 结构切块（标题段/代码块/列表/普通段），不再机械截断；
 *   ② 按与问题的相关度给每块打分，只取最相关的块，并保留它所属的小标题作上下文；
 *   ③ 输出带来源标注，让模型知道「这句依据来自哪篇笔记的哪一节」。 */

export interface ContextChunk {
  title: string;
  heading: string;
  text: string;
  score: number;
}

/** 把一篇笔记切成结构块：按 ## 标题分段，代码块整体保留，超长段落再按句切开 */
export function splitIntoChunks(doc: RagDoc): ContextChunk[] {
  const body = doc.body.replace(/\r\n/g, "\n");
  const lines = body.split("\n");
  const chunks: ContextChunk[] = [];
  let heading = "";
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) chunks.push({ title: doc.title, heading: heading || doc.title, text, score: 0 });
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      // 代码块闭合时立刻成块，避免和后面正文混在一起
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flush();
      heading = h[2].trim();
      continue;
    }
    if (!line.trim() && buf.length > 0) {
      // 空行 = 段落边界；但短段落先攒着，避免碎片过多
      if (buf.join("").length > 80) flush();
      continue;
    }
    buf.push(line);
  }
  flush();

  // 超长块按句切开（每块 ≤ 400 字），保证单块可读且不丢信息
  const out: ContextChunk[] = [];
  for (const c of chunks) {
    if (c.text.length <= 400) {
      out.push(c);
      continue;
    }
    const sentences = c.text.split(/(?<=[。！？.!?；;])\s*/);
    let acc = "";
    for (const s of sentences) {
      if (acc.length + s.length > 400 && acc) {
        out.push({ ...c, text: acc.trim() });
        acc = "";
      }
      acc += s;
    }
    if (acc.trim()) out.push({ ...c, text: acc.trim() });
  }
  return out;
}

/** 给块打分：词法命中 + 小标题命中加权；返回排序后的块 */
function scoreChunks(chunks: ContextChunk[], query: string): ContextChunk[] {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return chunks;
  return chunks
    .map((c) => {
      const bodyTokens = tokenize(c.text);
      const headTokens = tokenize(c.heading);
      let hit = 0;
      for (const t of bodyTokens) if (qTokens.has(t)) hit += 1;
      for (const t of headTokens) if (qTokens.has(t)) hit += 3; // 小标题命中更值钱
      // 归一到「每百字命中数」，避免长块靠体量取胜
      const score = (hit / Math.max(1, c.text.length)) * 100;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * 构建高质量注入上下文：结构化选段 + 来源标注。
 * @param maxChars 总字符预算（默认 2600——比旧版 1200 大一倍多，但用的是相关段落而非流水账）
 */
export function buildContext(hits: RagHit[], query: string, maxChars = 2600): string {
  if (hits.length === 0) return "";
  const blocks: string[] = [];
  let used = 0;
  for (const h of hits) {
    const chunks = scoreChunks(splitIntoChunks(h.doc), query);
    // 每篇最多贡献 3 块，且至少保留得分最高的一块（哪怕 0 分，也比空着强）
    const picked = chunks.slice(0, 3);
    if (picked.length === 0) continue;
    const merged = picked
      .map((c) => (c.heading && c.heading !== h.doc.title ? `（${c.heading}）${c.text}` : c.text))
      .join("\n");
    const block = `【${h.doc.title}】\n${merged}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used;
      if (room > 200) blocks.push(block.slice(0, room) + "…");
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return blocks.join("\n\n");
}

/** 把检索结果压成可注入提示词的上下文块（旧接口，保留兼容；新代码用 buildContext） */
export function ragContext(hits: RagHit[], maxChars = 1200): string {
  let out = "";
  for (const h of hits) {
    const block = `《${h.doc.title}》${h.doc.body.replace(/\[\[|\]\]/g, "").slice(0, 220)}`;
    if (out.length + block.length > maxChars) break;
    out += (out ? "\n" : "") + `- ${block}`;
  }
  return out;
}

/* ========= 检索增强三件套（对照经典 RAG 改造方法，2026-10-26）=========
 * 图片里的四个改造方向里，我们原本只有「向量混排」。这里补齐性价比最高的三项：
 *   ① 查询侧：Step-Back + Multi-Query 改写（解决"问得模糊"）
 *   ② 排序侧：LLM 精排 top-N → top-k（替代只有标签加分的伪 ReRank）
 *   ③ 质量侧：CRAG 式自评——检索不足时改写重检，而不是硬塞空上下文
 * 三者都是纯函数/注入式，不 import server-only，调用方决定是否启用。 */

/** 多查询融合：把原始问句与改写问句各自的检索结果按 RRF 合并（RAG-Fusion 的最小实现） */
export function fuseMultiQuery(
  query: string,
  variants: string[],
  docs: RagDoc[],
  k = 8
): RagHit[] {
  const queries = [query, ...variants].filter((q) => q && q.trim());
  const lists = queries.map((q) => bm25Search(q, docs, k * 2));
  const byId = new Map<string, RagHit>();
  lists.forEach((hits) => {
    hits.forEach((h, rank) => {
      const prev = byId.get(h.doc.id);
      const gain = 1 / (60 + rank + 1);
      byId.set(h.doc.id, { doc: h.doc, score: (prev?.score ?? 0) + gain });
    });
  });
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** 检索质量自评（CRAG 的轻量版）：不调模型，只看"命中数与分数是否够看"。
 *  用途：判定要不要触发一次改写重检，避免把"其实没检索到"伪装成"已参考笔记"。 */
export function assessRetrieval(hits: RagHit[], opts: { minHits?: number; minTopScore?: number } = {}) {
  const { minHits = 2, minTopScore = 1.2 } = opts;
  const top = hits[0]?.score ?? 0;
  const weak = hits.length < minHits || top < minTopScore;
  return { weak, reason: weak ? (hits.length < minHits ? "命中不足" : "相关度不够") : "" };
}

/** 精排提示词（LLM ReRank）：只让模型做"选与排序 + 一句理由"，不许改写笔记内容。
 *  返回给调用方拼进 /api/chat 的 args，task=rag-rerank。 */
export function rerankPrompt(query: string, hits: RagHit[], k = 3) {
  const candidates = hits.map((h, i) => ({
    idx: i + 1,
    title: h.doc.title,
    excerpt: h.doc.body.replace(/\[\[|\]\]/g, "").slice(0, 300),
  }));
  return {
    instructions:
      "按与用户问题的实际帮助程度排序，只保留最相关的 " +
      k +
      " 条；宁缺毋滥，全部不相关就返回空数组。只输出 JSON。",
    query,
    candidates,
  };
}

/** 解析精排结果；失败/越界一律回退到原始顺序（绝不因精排异常丢结果） */
export function applyRerank(hits: RagHit[], ranked: unknown, k = 3): RagHit[] {
  if (!Array.isArray(ranked)) return hits.slice(0, k);
  const picked: RagHit[] = [];
  for (const item of ranked) {
    const idx = typeof item === "number" ? item : Number((item as { idx?: number })?.idx);
    if (!Number.isInteger(idx) || idx < 1 || idx > hits.length) continue;
    const hit = hits[idx - 1];
    if (hit && !picked.includes(hit)) picked.push(hit);
    if (picked.length >= k) break;
  }
  return picked.length > 0 ? picked : hits.slice(0, k);
}
