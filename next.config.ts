import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* 容器化部署（华为云 CCE/ECS）：仅当 CONTAINER_BUILD=1（Dockerfile 里设）时产出自包含
   * server.js（.next/standalone）。此前写死 output:"standalone" 时注释以为"Vercel 忽略该字段"，
   * 实测 Vercel 构建全绿但 onBuildComplete 的 NFT 追踪会找不到 next-server.js.nft.json 而
   * 整体失败（2026-10-17 三连复现）——因此收进开关，Vercel / 本地 dev 走默认输出。 */
  output: process.env.CONTAINER_BUILD === "1" ? "standalone" : undefined,
  /* pg/ioredis 含 Node 原生协议实现，交由 Node 运行时加载，不参与打包（避免 bundle 警告与运行时缺件） */
  serverExternalPackages: ["pg", "ioredis"],
  /* 安全响应头：防点劫/防 MIME 嗅探/强制 HTTPS/收敛权限与来源信息。
   * 不加严格 CSP：应用大量使用内联样式与运行时注入 <style>（PopText），
   * 严格 CSP 会直接打坏 UI；如需 CSP 应改为 nonce 方案并全量回归。
   * 防嵌（2026-10-17）：X-Frame-Options DENY 换成 CSP frame-ancestors——
   * 唯一放行 Obsidian 的内嵌来源 app://obsidian.md（首页仪表盘插件挂 Mentora 视图），
   * 其余网站仍然嵌不了（frame-ancestors 不含其它 http(s) 来源；XFO 若同时存在会整体压过 CSP，故必须移除）。 */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self' app://obsidian.md;" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
