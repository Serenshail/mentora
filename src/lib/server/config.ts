import "server-only";

/* 12-Factor: config in env + logs as event streams.
 * envStatus: 启动/健康检查时校验必需 env,缺失即报( fail-fast ),可选 env 只报数量不报内容(防泄露)。
 * logEvent: 结构化 JSON 日志写 stdout,由执行环境(Vercel)路由/存储。 */

const REQUIRED = ["AUTH_SECRET"];
const OPTIONAL = [
  "DEEPSEEK_API_KEY", "ZAI_API_KEY", "MOONSHOT_API_KEY", "OPENAI_API_KEY", "CUSTOM_API_KEY",
  /* 华为云 MaaS（部署默认模型通道，AI_PROVIDER=maas 显式指定） */
  "MAAS_API_KEY", "MAAS_BASE_URL",
  "GITHUB_DB_TOKEN", "GITHUB_DB_REPO", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_D1_API_TOKEN",
  "ADMIN_PASSWORD", "GITHUB_TOKEN",
  /* 判分分级：quiz-grade/review-grade/verify-score 走此快模型（BYOK 不受影响） */
  "AI_CHEAP_MODEL",
  /* 复习召回：Cron 鉴权 + 发信 + 站点链接 */
  "CRON_SECRET", "RESEND_API_KEY", "MAIL_FROM", "APP_URL",
  /* 注册邀请码通道 */
  "INVITE_CODE",
];

export function envStatus() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  const presentCount = OPTIONAL.filter((k) => !!process.env[k]).length;
  return { ok: missing.length === 0, missing, presentCount };
}

export function logEvent(ev: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...ev }));
}
