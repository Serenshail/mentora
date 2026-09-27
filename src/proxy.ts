import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rateLimit } from "@/lib/server/rate-limit";

const COOKIE = "mentora_session";

/* 已知 AI 抓取/训练机器人 UA：直接拒（礼貌机器人遵守 robots，恶意机器人靠这层+限流+鉴权叠加） */
const AI_SCRAPER_UA =
  /(gptbot|chatgpt-user|oai-searchbot|ccbot|perplexitybot|claudebot|anthropic-ai|google-extended|applebot-extended|meta-externalagent|bytespider|cohere-ai|diffbot|youbot|scrapy|python-requests|go-http-client)/i;

function clientIpOf(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/* 以下路径无需登录即可访问；其余全部重定向到登录页 */
const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/register",
  "/admin", // 自带独立密码门（v9.3），不走登录墙，否则和登录页互踢
  "/_next",
  "/fonts",
  "/hero.mp4",
  "/hero-poster.jpg",
  "/favicon.ico",
  "/icon.png",
  "/robots.txt",
  "/sitemap.xml",
]);

function isPublic(path: string) {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith("/_next/")) return true;
  if (path.startsWith("/fonts/")) return true;
  if (path.startsWith("/personas/")) return true;
  /* PopText 资产：首页/登录页大字标的 css+js，拦了这两页的文字就渲染不出来 */
  if (path.startsWith("/poptext/")) return true;
  if (path.endsWith(".jpg") || path.endsWith(".png") || path.endsWith(".webp") || path.endsWith(".mp4") || path.endsWith(".svg") || path.endsWith(".ico")) return true;
  return false;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const res = NextResponse.next();

  // 全站禁止搜索引擎/AI 爬虫索引
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");

  // CORS：允许外部后台管理系统跨域调用 admin/health API（凭 x-admin-password 头鉴权）。
  // 默认放开来源（密钥在请求头而非 cookie，故跨域读响应仍需持有密码）；可用 ADMIN_CORS_ORIGINS 收紧。
  if (pathname.startsWith("/api/admin") || pathname === "/api/health") {
    const origin = req.headers.get("origin");
    const cfg = process.env.ADMIN_CORS_ORIGINS;
    const allow = cfg ? cfg.split(",").map((s) => s.trim()).includes(origin ?? "") : true;
    const cors: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
      "Access-Control-Max-Age": "600",
    };
    if (allow && origin) {
      cors["Access-Control-Allow-Origin"] = origin;
      cors["Vary"] = "Origin";
    }
    if (req.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: cors });
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  }

  // 防火墙第 1 层：已知 AI 抓取/训练机器人 UA 直接拒（静态资源也不给，防整站镜像）
  const ua = req.headers.get("user-agent") ?? "";
  if (AI_SCRAPER_UA.test(ua)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 防火墙第 2 层：全站 /api 每 IP 限流，防批量扒取/DoS（各路由另有更严的专项限流）
  if (pathname.startsWith("/api/")) {
    // admin 接口专项限流：外部后台走密码鉴权，严打爆破（30 次/分/IP）
    if (pathname.startsWith("/api/admin")) {
      if (!rateLimit(`admin:${clientIpOf(req)}`, { capacity: 30, refillPerSec: 0.5 })) {
        return NextResponse.json({ error: "请求过于频繁" }, { status: 429 });
      }
    }
    if (!rateLimit(`api:${clientIpOf(req)}`, { capacity: 120, refillPerSec: 2 })) {
      return NextResponse.json({ error: "请求过于频繁" }, { status: 429 });
    }
  }

  // API 一律 no-store：用户数据/会话信息绝不进任何缓存或中间层
  if (pathname.startsWith("/api/")) {
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return res;
  }
  // 内部资源不走登录墙
  if (pathname.startsWith("/_next/") || pathname === "/_vercel/insights") return res;

  // 静态资源、公开页面放行
  if (isPublic(pathname)) return res;

  // 未登录则全部重定向到登录页（参数名与 app-shell/登录页一致用 next，登录完回原页）
  const hasSession = req.cookies.get(COOKIE)?.value;
  if (!hasSession) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }

  return res;
}

export const config = {
  matcher: ["/:path*"],
};
