import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE = "mentora_session";

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

  // API、内部资源不走登录墙
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/") || pathname === "/_vercel/insights") return res;

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
