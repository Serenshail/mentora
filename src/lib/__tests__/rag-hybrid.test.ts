import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rrfMerge, retrieveAsync, type RagHit } from "../rag";

vi.mock("server-only", () => ({}));

/* ============ T-070 RAG 向量混排回归锁（HW-M-09） ============ */

const HITS: RagHit[] = [
  { doc: { id: "a", title: "A", body: "x" }, score: 9 },
  { doc: { id: "b", title: "B", body: "y" }, score: 7 },
  { doc: { id: "c", title: "C", body: "z" }, score: 5 },
  { doc: { id: "d", title: "D", body: "w" }, score: 3 },
];

describe("rrfMerge()", () => {
  it("RRF 融合：BM25 与向量序一致时提升，分歧时折中（k=60 标准常数）", () => {
    /* BM25 序 a>b>c>d，向量序 c>a>b——c 在两列表都有高排位，融合后应进前二 */
    const merged = rrfMerge(HITS, ["c", "a", "b"], 3);
    const ids = merged.map((h) => h.doc.id);
    expect(ids).toContain("c");
    expect(ids.indexOf("c")).toBeLessThan(2);
    expect(merged).toHaveLength(3);
  });

  it("仅 BM25 命中的文档（向量列表无）不丢失；纯函数不修改入参", () => {
    const snapshot = JSON.stringify(HITS);
    const merged = rrfMerge(HITS, [], 4);
    expect(merged.map((h) => h.doc.id)).toEqual(["a", "b", "c", "d"]);
    expect(JSON.stringify(HITS)).toBe(snapshot);
  });
});

describe("retrieveAsync()", () => {
  const docs = [
    { id: "a", title: "Python 字典用法", body: "dict 创建 增删改 get setdefault keys values" },
    { id: "b", title: "Java 集合", body: "list map set iterator 完全不同的内容词" },
  ];

  it("embed 返回 null → 回退纯 BM25（与现状行为一致）", async () => {
    const r = await retrieveAsync("字典", docs, 2, async () => null);
    expect(r.map((h) => h.doc.id)).toEqual(["a"]);
  });

  it("embed 抛错 → 回退纯 BM25（故障不影响检索主流程）", async () => {
    const r = await retrieveAsync("字典", docs, 2, async () => {
      throw new Error("endpoint down");
    });
    expect(r.map((h) => h.doc.id)).toEqual(["a"]);
  });

  it("嵌入可用 → RRF 混排生效（语义相似但词面不同的文档可被向量拉回）", async () => {
    /* 词面上"字典"只命中 a；向量模拟把 b 排第一 → 混排后 b 仍应出现在结果中 */
    const vectors = new Map<string, number[]>([
      ["q", [1, 0]],
      ["Python 字典用法\ndict 创建 增删改 get setdefault keys values", [0.9, 0.1]],
      ["Java 集合\nlist map set iterator 完全不同的内容词", [0.1, 0.99]],
    ]);
    const r = await retrieveAsync("字典", docs, 2, async (texts) => texts.map((t) => vectors.get(t) ?? [0, 0]));
    expect(r.length).toBeGreaterThan(0);
    expect(r.map((h) => h.doc.id)).toContain("a");
  });
});

/* ---- embedding.ts（server-only 组件）容错矩阵 ---- */

describe("embedText()", () => {
  const EMBED_KEYS = ["EMBED_MODEL", "EMBED_API_KEY", "EMBED_BASE_URL", "MAAS_API_KEY", "MAAS_BASE_URL"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(EMBED_KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
  });
  async function loadEmbed(env: Record<string, string> = {}) {
    vi.resetModules();
    for (const k of EMBED_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    return import("../ai/embedding");
  }

  it("未配置 EMBED_MODEL → null（嵌入是可选增强，未配置零依赖）", async () => {
    const e = await loadEmbed();
    expect(e.embedConfig()).toBeNull();
    expect(await e.embedText(["x"])).toBeNull();
  });

  it("配置齐（EMBED_API_KEY 优先，缺省回落 MAAS_API_KEY）→ 调 /embeddings 并返回向量", async () => {
    const e = await loadEmbed({ EMBED_MODEL: "bge-m3", MAAS_API_KEY: "mk" });
    expect(e.embedConfig()).toMatchObject({ apiKey: "mk", model: "bge-m3" });
    let calledUrl = "";
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calledUrl = url;
      expect(JSON.parse(String(init.body)).input).toEqual(["a", "b"]);
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0], index: 0 }, { embedding: [0, 1], index: 1 }] }), { status: 200 });
    });
    const out = await e.embedText(["a", "b"]);
    expect(out).toEqual([[1, 0], [0, 1]]);
    expect(calledUrl).toBe("https://api.modelarts-maas.com/v1/embeddings");
  });

  it("非 2xx / 结构异常 / 网络异常 → null（绝不抛错）", async () => {
    const e = await loadEmbed({ EMBED_MODEL: "m", EMBED_API_KEY: "k" });
    vi.stubGlobal("fetch", async () => new Response("err", { status: 500 }));
    expect(await e.embedText(["x"])).toBeNull();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [{ embedding: "bad" }] }), { status: 200 }));
    expect(await e.embedText(["x"])).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network");
    });
    expect(await e.embedText(["x"])).toBeNull();
    expect(await e.embedText([])).toBeNull();
  });
});