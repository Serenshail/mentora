import { NextRequest } from "next/server";
import { assertSafePublicUrl, checkUrlShape } from "@/lib/server/url-guard";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { verifySession } from "@/lib/server/auth";
import { isDeployed } from "@/lib/server/deploy-env";

export const runtime = "nodejs";

/* 公网页面正文读取（agent read_url 工具的后端）。
 * 复用 linkcheck 的 SSRF 纪律并加码：
 *  - 入口与每一跳重定向都过 assertSafePublicUrl（DNS 解析全公网）；
 *  - 总超时 8s、响应体 200KB 硬上限、Content-Type 白名单（HTML/纯文本）；
 *  - 不回传内网状态码；每用户 ≈30 次/天持久限流。
 * 返回去标签正文（≤8KB）与页面标题，供模型阅读引用。 */

const TOTAL_TIMEOUT_MS = 8_000;
const MAX_BYTES = 200_000;
const MAX_REDIRECTS = 4;
/* 浏览器伪装头（参考实现同款纪律）：很多站点对非浏览器 UA/缺 Accept-Language 直接 403。
 * 仅用于读取公开网页。 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Referer: "https://www.google.com/",
};
const OK_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown"];

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = decodeEntities((titleMatch?.[1] || "").trim()).slice(0, 120);
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 8000);
  return { title, text };
}

export async function POST(req: NextRequest) {
  const session = await verifySession();
  if (isDeployed() && !session) {
    return Response.json({ error: "登录后即可使用网页阅读" }, { status: 401 });
  }
  const ok = await rateLimitPersistent(`fetchpage:${session?.email || clientIp(req)}`, {
    capacity: 30,
    refillPerSec: 30 / 86_400,
  });
  if (!ok) {
    return Response.json({ error: "今日网页读取次数已用完，明天恢复。" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const raw = String(body.url ?? "").trim();
  if (!raw) return Response.json({ error: "缺少 url" }, { status: 400 });

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  try {
    let current = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const shaped = checkUrlShape(current, { allowHttp: true });
      const guard = await assertSafePublicUrl(current, { allowHttp: true });
      if (!shaped || !guard.ok) {
        return Response.json({ error: guard.reason || "地址不受支持" }, { status: 400 });
      }
      const res = await fetch(shaped.toString(), {
        headers: BROWSER_HEADERS,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())),
      });
      /* 重定向逐跳复检（linkcheck 同款纪律）：跨域丢弃一切凭据头（本来也没有） */
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return Response.json({ error: "重定向缺少目标" }, { status: 502 });
        current = new URL(loc, shaped.toString()).toString();
        continue;
      }
      if (!res.ok) {
        return Response.json({ error: `页面返回 ${res.status}` }, { status: 502 });
      }
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!OK_TYPES.some((t) => type === t || (t === "text/plain" && type.startsWith("text/")))) {
        return Response.json({ error: `不支持的页面类型：${type || "未知"}` }, { status: 415 });
      }
      /* 流式读取、到 200KB 即断流：不能用 arrayBuffer() 整包缓冲后再截断——
       * 超时只封读取时长、封不住流量，快速 CDN 的大文件能在 8s 窗口内灌入
       * 数百 MB 打爆内存（自托管单进程 OOM / Vercel 函数超限被杀）。
       * 截断语义不变：仍取前 MAX_BYTES 字节、非致命 UTF-8 解码。 */
      const reader = res.body?.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        try {
          while (total < MAX_BYTES) {
            const { done, value } = await reader.read();
            if (done || !value || value.length === 0) break;
            const room = MAX_BYTES - total;
            if (value.length > room) {
              parts.push(value.subarray(0, room));
              total = MAX_BYTES;
            } else {
              parts.push(value);
              total += value.length;
            }
          }
        } finally {
          /* 到限/读完/中途出错都断开底层连接：后续到达的字节不进内存 */
          reader.cancel().catch(() => {});
        }
      }
      const sliced = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        sliced.set(p, offset);
        offset += p.length;
      }
      const html = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
      const { title, text } = extractText(html);
      if (!text) return Response.json({ error: "页面没有可读正文" }, { status: 422 });
      return Response.json({ title, text, url: shaped.toString() });
    }
    return Response.json({ error: "重定向次数过多" }, { status: 508 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "网络错误";
    /* 不区分内网失败细节：统一报"无法读取"，不向调用方泄露内网探测结果 */
    return Response.json({ error: `无法读取该页面（${msg.slice(0, 80)}）` }, { status: 502 });
  }
}
