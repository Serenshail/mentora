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
}

const linkCache = new Map<string, LinkCheck>();
const inflight = new Map<string, Promise<LinkCheck | null>>();

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
  const misses = [...new Set(urls)].filter((u) => u && !linkCache.has(u));
  if (misses.length) {
    const chunks: string[][] = [];
    for (let i = 0; i < misses.length; i += 10) chunks.push(misses.slice(i, i + 10));
    const settled = await withTimeout(
      Promise.all(chunks.map((c) => fetchChecks(c))),
      12_000,
      []
    );
    for (const list of settled) for (const c of list) linkCache.set(c.url, c);
  }
  for (const u of urls) {
    const c = linkCache.get(u);
    if (c) out.set(u, c);
  }
  return out;
}

/** UI 徽章用:缓存命中即返回,否则单条异步补检 */
export function ensureCheck(url: string): Promise<LinkCheck | null> {
  const hit = linkCache.get(url);
  if (hit) return Promise.resolve(hit);
  const pend = inflight.get(url);
  if (pend) return pend;
  const p = fetchChecks([url])
    .then((list) => {
      const c = list[0] ?? null;
      if (c) linkCache.set(url, c);
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
    const full = await withTimeout(
      streamChat({
        task: "resource-fix",
        args: {
          bad: JSON.stringify(
            bad.map((b) => ({ title: b.title, url: b.url, why: b.why, reason: badByUrl.get(b.url!)?.reason }))
          ),
          ctx,
        },
        messages: [{ role: "user", content: "替换。" }],
        temperature: 0.3,
        onDelta: () => {},
      }),
      20_000,
      ""
    );
    if (full) reps = asArray<Resource>(extractJson<unknown>(full));
  } catch {
    reps = [];
  }

  // 再体检替代项(缓存优先),只保留可访问非广告的
  const repUrls = reps.map((r) => normalizeUrl(r.url)).filter((u): u is string => !!u);
  const repChecks = await checkUrls(repUrls);
  const repOk = new Set([...repChecks.values()].filter((c) => c.ok).map((c) => c.url));

  const out: Resource[] = [];
  let ri = 0;
  for (const r of norm) {
    if (r.url && badByUrl.has(r.url)) {
      const rep = reps[ri++];
      const repUrl = normalizeUrl(rep?.url);
      if (rep && repUrl && repOk.has(repUrl)) out.push({ ...rep, url: repUrl });
      // 否则丢弃这条坏资源(不给用户看坏链)
    } else {
      out.push(r);
    }
  }
  return out;
}
