import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { clientIp, rateLimit, rateLimitPersistent } from "@/lib/server/rate-limit";
import { withBudget } from "@/lib/server/db";

const COOKIE = "mentora_session";

/* 已知 AI 抓取/训练机器人 UA：直接拒（礼貌机器人遵守 robots，恶意机器人靠这层+限流+鉴权叠加） */
const AI_SCRAPER_UA =
  /(gptbot|chatgpt-user|oai-searchbot|ccbot|perplexitybot|claudebot|anthropic-ai|google-extended|applebot-extended|meta-externalagent|bytespider|cohere-ai|diffbot|youbot|scrapy|python-requests|go-http-client)/i;

/* 以下「精确路径」无需登录即可访问；其余全部重定向到登录页。
 * 静态资产（/_next 构建产物、/fonts、/personas、/poptext、各类图片/媒体）统一由
 * 下方 isPublic 的「前缀 / 扩展名」规则放行，不在此逐条列举——历史上这里曾重复
 * 列举 /_next、/fonts、/hero.mp4、/favicon.ico 等，均已被前缀/扩展名规则完全覆盖，
 * 纯属冗余；后续想收紧静态资源策略时很容易改错位置却以为已生效。 */
const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/register",
  /* 登录页底部向未登录用户展示「隐私政策 · 用户协议」链接（login-form.tsx）：
   * 这两页必须免登录可读，否则点击即被登录墙 302 弹回，形成「入口→弹回」死循环，
   * 且本地模式（无 session cookie）用户永远读不到，合规审核也不通过。 */
  "/privacy",
  "/terms",
  "/admin", // 自带独立密码门（v9.3），不走登录墙，否则和登录页互踢
  "/robots.txt",
  "/sitemap.xml",
]);

function isPublic(path: string) {
  if (PUBLIC_PATHS.has(path)) return true;
  /* /_next/ 由 proxy 主干更早处的 `pathname.startsWith("/_next/")` 直接放行，
   * 这里不再重复判断：放行逻辑只留一处，改动可预期。 */
  if (path.startsWith("/fonts")) return true;
  if (path.startsWith("/personas/")) return true;
  /* PopText 资产：首页/登录页大字标的 css+js，拦了这两页的文字就渲染不出来 */
  if (path.startsWith("/poptext/")) return true;
  if (path.endsWith(".jpg") || path.endsWith(".png") || path.endsWith(".webp") || path.endsWith(".mp4") || path.endsWith(".svg") || path.endsWith(".ico")) return true;
  return false;
}

/* async：admin 专项桶走跨实例持久桶（见下），Next 16 的 proxy 本身运行在 Node.js
 * 运行时且支持 async（middleware.js 的 errorHandledHandler 会 await 处理器）。 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const res = NextResponse.next();

  // 全站禁止搜索引擎/AI 爬虫索引
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");

  // CORS：允许外部后台管理系统跨域调用 admin API（凭 x-admin-password 头鉴权）。
  // admin：默认放开来源（密钥在请求头而非 cookie，故跨域读响应仍需持有密码）；可用 ADMIN_CORS_ORIGINS 收紧。
  // health：无鉴权，响应能读出部署画像（缺哪个 env=哪个子系统降级）——与 admin 共用
  // 「未配置即全放」会让任意跨域 JS 免费拿到画像，故只在显式配置来源时才反射。
  const isAdminApi = pathname.startsWith("/api/admin");
  if (isAdminApi || pathname === "/api/health") {
    const origin = req.headers.get("origin");
    const cfg = process.env.ADMIN_CORS_ORIGINS;
    const allow = cfg
      ? cfg.split(",").map((s) => s.trim()).includes(origin ?? "")
      : isAdminApi;
    const cors: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
    /* 与全站错误契约一致返回 JSON {error}：调用方（auth-client 等）按 res.json() 解析，
     * 旧的纯文本 "Forbidden" 会让统一解析路径抛 SyntaxError，真实原因（UA 被拦）
     * 完全丢失。黑名单含 python-requests/go-http-client/scrapy 等通用库 UA——
     * 自托管用户自己的脚本/探针用这些库接入即命中，必须给出可行动的中文提示。 */
    return NextResponse.json({ error: "拒绝访问（当前客户端被识别为自动化抓取工具）" }, { status: 403 });
  }

  // 防火墙第 2 层：全站 /api 每 IP 限流，防批量扒取/DoS（各路由另有更严的专项限流）
  if (pathname.startsWith("/api/")) {
    /* admin 接口专项限流：外部后台走密码鉴权，严打爆破（30 次/分/IP）。
     * 必须用跨实例持久桶：进程内桶在 Vercel 多实例/isolate 回收下每实例独立计数，
     * 实际放行 ≈ 30×N 次/分/IP 且冷启动清零，admin 密码爆破防线形同虚设。
     * admin 流量极低（人工后台操作），每请求一次 KV 读写的成本可忽略。 */
    if (pathname.startsWith("/api/admin")) {
      /* 键必须与路由级桶区分（overview/stats 用 `admin:<ip>` 且容量 10/分）：
       * 共用键会让两个不同 capacity/refill 的调用互相改同一桶，把路由预算砍半。
       * withBudget：KV 变慢/故障时降级放行（与 chat 同口径），绝不让后台首字节
       * 卡在限流读写上——限流失效好过后台不可用。 */
      const ok = await withBudget(
        rateLimitPersistent(`admin:fw:${clientIp(req)}`, { capacity: 30, refillPerSec: 0.5 }),
        true,
        1200
      );
      if (!ok) {
        return NextResponse.json({ error: "请求过于频繁" }, { status: 429 });
      }
    }
    /* 全站粗粒度层刻意留在进程内：它只是防单实例被同 IP 打满的粗筛（高价值路由
     * 各自的 rateLimitPersistent 才是跨实例真防线）。改成持久桶等于给每个 /api
     * 请求加一次 KV 读写，写放大撞 D1 日配额、且 KV 抖动会拖慢全部 API——不划算。 */
    if (!rateLimit(`api:${clientIp(req)}`, { capacity: 120, refillPerSec: 2 })) {
      return NextResponse.json({ error: "请求过于频繁" }, { status: 429 });
    }
  }

  // API 一律 no-store：用户数据/会话信息绝不进任何缓存或中间层
  if (pathname.startsWith("/api/")) {
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return res;
  }
  // 内部资源不走登录墙（/_vercel/insights 死特判已删：项目未启用 Vercel Analytics，
  // 统计走自有漏斗出口 /api/track，见 admin/stats 注释）
  if (pathname.startsWith("/_next/")) return res;

  // 静态资源、公开页面放行
  if (isPublic(pathname)) return res;

  // 未登录则全部重定向到登录页（参数名与 app-shell/登录页一致用 next，登录完回原页。
  // 必须带上 query：brain ?note=&tab=、learn ?focus=1&day=N 等深链状态都在 search 里）
  const hasSession = req.cookies.get(COOKIE)?.value;
  if (!hasSession) {
    const login = new URL("/login", req.url);
    login.searchParams.set("next", pathname + req.nextUrl.search);
    return NextResponse.redirect(login);
  }

  return res;
}

export const config = {
  matcher: ["/:path*"],
};
