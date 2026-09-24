import { envStatus } from "@/lib/server/config";

export const runtime = "nodejs";

/* 运维健康检查:必需 env 是否齐、可选通道配置数量、构建版本。不泄露任何密钥/名单内容。 */
export async function GET() {
  const s = envStatus();
  return Response.json(
    {
      ok: s.ok,
      missing: s.missing,
      optionalConfigured: s.presentCount,
      build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
