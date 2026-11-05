"use client";

/* 资源处理管线(工程化闭环):
 * 生成 → /api/linkcheck 体检 → 失效/疑似广告的 → 调 RESOURCE_FIX 让模型重新找可访问的替代
 * → 再体检一次 → 仍不合格的直接丢弃。绝不把坏链/广告推给用户。
 * 优化:模块级体检缓存(同一次生成里 refine 与 UI 徽章共用,不重复请求)+ 批量(每请求≤10 URL)
 * + 超时兜底(体检/修复超时就放弃增强,原样返回,绝不拖住生成)。 */

import { streamChat, extractJson } from "@/lib/ai/client";
import type { Resource } from "@/lib/types";

export interface LinkCheck {
  url: string;
  ok: boolean;
  dead: boolean;
  ad: boolean;
  reason: string;
  /** 单集视频且已被平台接口证实存在 */
  video?: boolean;
  /** 平台返回的真实标题/作者（用于覆盖模型编造的标题） */
  title?: string;
  author?: string;
}

/* 体检缓存：旧实现是永不失效的裸 Map——链接恢复/失效后界面一直显示旧结论，
 * 容量也没有上限。加 TTL（30 分钟）+ 容量上限（超限先淘汰最早写入的）。 */
const LINK_TTL_MS = 30 * 60 * 1000;
const LINK_CACHE_MAX = 800;
const linkCache = new Map<string, { c: LinkCheck; at: number }>();
const inflight = new Map<string, Promise<LinkCheck | null>>();

function cacheGet(url: string): LinkCheck | undefined {
  const hit = linkCache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at > LINK_TTL_MS) {
    linkCache.delete(url);
    return undefined;
  }
  return hit.c;
}
function cacheSet(url: string, c: LinkCheck) {
  if (linkCache.size >= LINK_CACHE_MAX) {
    const oldest = linkCache.keys().next().value;
    if (oldest !== undefined) linkCache.delete(oldest);
  }
  linkCache.set(url, { c, at: Date.now() });
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

async function fetchChecks(urls: string[]): Promise<LinkCheck[]> {
  try {
    const res = await fetch("/api/linkcheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: urls.slice(0, 10) }),
    });
    const j = await res.json();
    return (j.results ?? []) as LinkCheck[];
  } catch {
    return [];
  }
}

/** 批量体检(缓存优先,缺失的分块并发拉取);整体 12s 超时,超时部分返回 null 不阻塞 */
export async function checkUrls(urls: string[]): Promise<Map<string, LinkCheck>> {
  const out = new Map<string, LinkCheck>();
  const misses = [...new Set(urls)].filter((u) => u && !cacheGet(u));
  if (misses.length) {
    const chunks: string[][] = [];
    for (let i = 0; i < misses.length; i += 10) chunks.push(misses.slice(i, i + 10));
    const settled = await withTimeout(
      Promise.all(chunks.map((c) => fetchChecks(c))),
      12_000,
      []
    );
    for (const list of settled) for (const c of list) cacheSet(c.url, c);
  }
  for (const u of urls) {
    const c = cacheGet(u);
    if (c) out.set(u, c);
  }
  return out;
}

/** UI 徽章用:缓存命中即返回,否则单条异步补检 */
export function ensureCheck(url: string): Promise<LinkCheck | null> {
  const hit = cacheGet(url);
  if (hit) return Promise.resolve(hit);
  const pend = inflight.get(url);
  if (pend) return pend;
  const p = fetchChecks([url])
    .then((list) => {
      const c = list[0] ?? null;
      if (c) cacheSet(url, c);
      inflight.delete(url);
      return c;
    })
    .catch(() => {
      inflight.delete(url);
      return null;
    });
  inflight.set(url, p);
  return p;
}

function normalizeUrl(u?: string): string | undefined {
  if (!u) return undefined;
  const t = u.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^www\./i.test(t)) return `https://${t}`;
  return t.startsWith("http") ? t : `https://${t}`;
}

/* 模型偶尔把数组包成 {"replacements":[...]} 之类对象——取其中第一个数组值兜底 */
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const val of Object.values(v as Record<string, unknown>)) {
      if (Array.isArray(val)) return val as T[];
    }
  }
  return [];
}

export async function refineResources(resources: Resource[], ctx: string): Promise<Resource[]> {
  const norm = resources.map((r) => ({ ...r, url: normalizeUrl(r.url) }));
  const withUrl = norm.filter((r) => r.url);
  if (!withUrl.length) return norm;

  const checks = await checkUrls(withUrl.map((r) => r.url!));
  const badByUrl = new Map(
    [...checks.values()].filter((c) => c.dead || c.ad).map((c) => [c.url, c])
  );
  if (!badByUrl.size) return norm; // 体检不可用/超时 → 原样返回,不拖生成

  const bad = norm.filter((r) => r.url && badByUrl.has(r.url));
  let reps: Resource[] = [];
  try {
    /* 超时必须同时中止上游：旧实现 20s 赢得竞态后底层 streamChat 仍在跑完，
     * 用户为自己的 BYOK Key 白付一次注定被丢弃的生成。 */
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const full = await streamChat({
        task: "resource-fix",
        args: {
          bad: JSON.stringify(
            bad.map((b) => ({ title: b.title, url: b.url, why: b.why, reason: badByUrl.get(b.url!)?.reason }))
          ),
          ctx,
        },
        messages: [{ role: "user", content: "替换。" }],
        temperature: 0.3,
        signal: ctrl.signal,
        onDelta: () => {},
      });
      if (full) reps = asArray<Resource>(extractJson<unknown>(full));
    } finally {
      clearTimeout(timer);
    }
  } catch {
    reps = [];
  }

  /* 对位校验：RESOURCE_FIX 契约要求返回数组与 bad 等长、按序对应（找不到填 null）。
   * 模型漏项/增项时 reps[ri++] 位置配对会整体错位，错位资源会顶替错误主题展示给用户
   * ——此时弃用全部替代项，坏资源直接丢弃，宁缺毋滥。 */
  if (reps.length !== bad.length) reps = [];

  // 再体检替代项(缓存优先),只保留可访问非广告的
  const repUrls = reps.map((r) => normalizeUrl(r.url)).filter((u): u is string => !!u);
  const repChecks = await checkUrls(repUrls);
  const repOk = new Set([...repChecks.values()].filter((c) => c.ok).map((c) => c.url));

  const out: Resource[] = [];
  let ri = 0;
  // 视频实证结果：用平台真实标题/作者覆盖模型编造的标题，并打上"已验证"标记
  const verifiedByUrl = new Map(
    [...checks.values()].filter((c) => c.ok && c.video).map((c) => [c.url, c])
  );
  const enrich = (r: Resource, url: string, check?: LinkCheck): Resource => {
    const v = check ?? verifiedByUrl.get(url);
    if (!v) return { ...r, url };
    return {
      ...r,
      url,
      title: v.title || r.title,
      author: v.author,
      verified: true,
      kind: r.kind ?? "video",
    };
  };
  for (const r of norm) {
    if (r.url && badByUrl.has(r.url)) {
      const rep = reps[ri++];
      const repUrl = normalizeUrl(rep?.url);
      if (rep && repUrl && repOk.has(repUrl)) out.push(enrich(rep, repUrl, repChecks.get(repUrl)));
      // 否则丢弃这条坏资源(不给用户看坏链)
    } else {
      out.push(r.url ? enrich(r, r.url) : r);
    }
  }
  return out;
}
