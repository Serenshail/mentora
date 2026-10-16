import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* 容器化部署（华为云 CCE/ECS）：产出自包含 server.js（.next/standalone）。
   * Vercel 平台忽略该字段（其自带构建管线），本地 dev 不受影响——同一份代码三场地可用。 */
  output: "standalone",
  /* pg/ioredis 含 Node 原生协议实现，交由 Node 运行时加载，不参与打包（避免 bundle 警告与运行时缺件） */
  serverExternalPackages: ["pg", "ioredis"],
  /* 安全响应头：防点劫/防 MIME 嗅探/强制 HTTPS/收敛权限与来源信息。
   * 不加严格 CSP：应用大量使用内联样式与运行时注入 <style>（PopText），
   * 严格 CSP 会直接打坏 UI；如需 CSP 应改为 nonce 方案并全量回归。 */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
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
