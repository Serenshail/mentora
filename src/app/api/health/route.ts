import { envStatus } from "@/lib/server/config";
import { buildSha } from "@/lib/server/deploy-env";
import { dbChannel } from "@/lib/server/db";
import { serverConfig } from "@/lib/server/ai-config";

export const runtime = "nodejs";

/* 运维健康检查:必需 env 是否齐、可选通道配置数量、构建版本、双通道展示。不泄露任何密钥/名单内容。 */
export async function GET() {
  const s = envStatus();
  return Response.json(
    {
      ok: s.ok,
      missing: s.missing,
      optionalConfigured: s.presentCount,
      build: buildSha(),
      channel: { db: dbChannel(), ai: serverConfig().provider },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
