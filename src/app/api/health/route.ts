import { envStatus } from "@/lib/server/config";
import { buildSha } from "@/lib/server/deploy-env";

export const runtime = "nodejs";

/* 运维健康检查:必需 env 是否齐、可选通道配置数量、构建版本。不泄露任何密钥/名单内容。 */
export async function GET() {
  const s = envStatus();
  return Response.json(
    {
      ok: s.ok,
      missing: s.missing,
      optionalConfigured: s.presentCount,
      build: buildSha(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
