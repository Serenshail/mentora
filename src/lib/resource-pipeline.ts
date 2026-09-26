"use client";

/* 资源处理管线(工程化闭环):
 * 生成 → /api/linkcheck 体检 → 失效/疑似广告的 → 调 RESOURCE_FIX 让模型重新找可访问的替代
 * → 再体检一次 → 仍不合格的直接丢弃。绝不把坏链/广告推给用户。
 * 任何一步失败都降级(宁可少给,不给错的)。 */

import { streamChat, extractJson } from "@/lib/ai/client";
import type { Resource } from "@/lib/types";

interface Check {
  url: string;
  ok: boolean;
  dead: boolean;
  ad: boolean;
  reason: string;
}

async function check(urls: string[]): Promise<Check[]> {
  if (!urls.length) return [];
  try {
    const res = await fetch("/api/linkcheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: urls.slice(0, 10) }),
    });
    const j = await res.json();
    return (j.results ?? []) as Check[];
  } catch {
    return []; // 体检不可用时不误杀,原样返回
  }
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
  // 先规范化 URL(补协议),再体检
  const norm = resources.map((r) => ({ ...r, url: normalizeUrl(r.url) }));
  const withUrl = norm.filter((r) => r.url);
  if (!withUrl.length) return norm;

  const checks = await check(withUrl.map((r) => r.url!));
  const badByUrl = new Map(checks.filter((c) => c.dead || c.ad).map((c) => [c.url, c]));
  if (!badByUrl.size) return norm;

  const bad = norm.filter((r) => r.url && badByUrl.has(r.url));
  let reps: Resource[] = [];
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
      onDelta: () => {},
    });
    reps = asArray<Resource>(extractJson<unknown>(full));
  } catch {
    reps = [];
  }

  // 再体检替代项,只保留可访问非广告的
  const repOk = new Set((await check(reps.map((r) => normalizeUrl(r.url)!).filter(Boolean))).filter((c) => c.ok).map((c) => c.url));

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
