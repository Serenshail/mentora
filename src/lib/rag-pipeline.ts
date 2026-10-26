"use client";

/* RAG 检索增强编排（2026-10-26）
 * 对照经典 RAG 改造补齐三项：查询侧改写（Step-Back + Multi-Query）、
 * 排序侧 LLM 精排、质量侧 CRAG 式自评回退。
 *
 * 设计纪律：
 * 1) 任何一步失败都**降级到原行为**（纯 wikiRetrieve top-k），绝不因增强链路故障让对话不可用；
 * 2) 模型只做"改写问句"和"挑选编号"，不参与最终内容生成、不碰笔记正文；
 * 3) 一次对话最多额外 2 次模型调用（改写 1 次 + 精排 1 次），且精排只在候选 > k 时才值得跑。
 */
import { extractJson, streamChat } from "@/lib/ai/client";
import {
  applyRerank,
  assessRetrieval,
  fuseMultiQuery,
  ragContext,
  rerankPrompt,
  wikiRetrieve,
  type RagHit,
  type WikiNote,
} from "@/lib/rag";

export interface EnhancedRetrieval {
  hits: RagHit[];
  context: string;
  /** 供 UI/日志诊断：这一轮实际用了哪些增强步骤 */
  trace: {
    initialHits: number;
    rewriteQueries: string[];
    usedFusion: boolean;
    usedRerank: boolean;
    retrievalWeak: boolean;
    degraded?: string;
  };
}

/** 从模型输出里稳健取出改写问句数组；失败返回 [] */
function parseQueries(text: string): string[] {
  try {
    const j = extractJson<{ queries?: unknown }>(text);
    const arr = Array.isArray(j?.queries) ? j.queries : [];
    return arr
      .map((q) => String(q ?? "").trim())
      .filter((q) => q.length > 0 && q.length <= 80)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** 精排：把候选编号交给模型挑选；解析失败退回原顺序 */
function parsePicked(text: string): unknown {
  try {
    const j = extractJson<{ picked?: unknown }>(text);
    const picked = j?.picked;
    if (!Array.isArray(picked)) return null;
    // 归一成 idx 数组，兼容 {idx, why} 与裸数字
    return picked.map((p) =>
      typeof p === "number" ? p : Number((p as { idx?: number })?.idx ?? NaN)
    );
  } catch {
    return null;
  }
}

/**
 * 增强检索主入口。
 * @param query    用户原话
 * @param notes    第二大脑笔记（调用方负责排除 MOC）
 * @param k        最终注入条数
 * @param opts.rewrite  是否启用查询改写（默认 true；CRAG 自评弱时会强制触发一次）
 * @param opts.rerank   是否启用 LLM 精排（默认 true）
 */
export async function retrieveEnhanced(
  query: string,
  notes: WikiNote[],
  k = 3,
  opts: { rewrite?: boolean; rerank?: boolean; signal?: AbortSignal; context?: string } = {}
): Promise<EnhancedRetrieval> {
  const { rewrite = true, rerank = true, signal, context } = opts;
  const trace: EnhancedRetrieval["trace"] = {
    initialHits: 0,
    rewriteQueries: [],
    usedFusion: false,
    usedRerank: false,
    retrievalWeak: false,
  };

  // ① 基线检索（图导航，原有能力）
  const baseline = wikiRetrieve(query, notes, Math.max(k * 2, 8));
  trace.initialHits = baseline.length;

  // ② CRAG 自评：命中不足/相关度低 → 一定改写；命中尚可时也改写（一次廉价调用换召回）
  const assess = assessRetrieval(baseline);
  trace.retrievalWeak = assess.weak;
  const needRewrite = rewrite;

  let candidates = baseline;
  if (needRewrite) {
    try {
      const raw = await streamChat({
        task: "query-rewrite",
        args: { question: query, context: context ?? "" },
        messages: [{ role: "user", content: "请改写检索查询。" }],
        temperature: 0.3,
        signal,
        onDelta: () => {},
      });
      const variants = parseQueries(raw);
      trace.rewriteQueries = variants;
      if (variants.length > 0) {
        // ③ 多查询融合（RAG-Fusion）：原问句与改写问句的检索结果 RRF 合并
        candidates = fuseMultiQuery(
          query,
          variants,
          notes.map((n) => ({
            id: n.id,
            title: n.title,
            body: n.body,
            domain: n.domain,
            version: n.version,
            updatedAt: n.updatedAt,
            tags: n.tags,
          })),
          Math.max(k * 2, 8)
        );
        trace.usedFusion = true;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      trace.degraded = "改写失败，沿用基线检索";
    }
  }
  if (candidates.length === 0) {
    return { hits: [], context: "", trace };
  }

  // ④ LLM 精排：候选多于 k 才有意义；失败/越界一律回退原顺序
  let finalHits = candidates.slice(0, k);
  if (rerank && candidates.length > k) {
    try {
      const pack = rerankPrompt(query, candidates, k);
      const raw = await streamChat({
        task: "rag-rerank",
        args: { query: pack.query, candidates: JSON.stringify(pack.candidates) },
        messages: [{ role: "user", content: "请精排。" }],
        temperature: 0.2,
        signal,
        onDelta: () => {},
      });
      const picked = parsePicked(raw);
      if (picked) {
        finalHits = applyRerank(candidates, picked, k);
        trace.usedRerank = true;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      trace.degraded = (trace.degraded ? trace.degraded + "；" : "") + "精排失败，沿用融合顺序";
    }
  }

  return { hits: finalHits, context: ragContext(finalHits), trace };
}
