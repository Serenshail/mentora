import "server-only";

/* ============================================================
 * 部署环境标识（HW-D-06：Vercel 绑定 env 通用化）
 *
 * 同一镜像可同时跑 Vercel 与华为云（design 决策 3）：
 *  · DEPLOY_ENV 显式优先——容器/CCE 编排注入（production/preview/dev）
 *  · 兜底 VERCEL_ENV——Vercel 平台自动注入，行为与历史一致
 *  · 键隔离（rl//code//loginfail/）、登录强制、cookie secure 均由此驱动
 * ============================================================ */

/* DEPLOY_ENV/VERCEL_ENV 是自由格式字符串：配错值（如 "prod"）会让 secure cookie 等
 * 安全属性静默 fail-open——非法取值告警一次（每进程一次，避免热路径刷日志） */
const LEGAL_DEPLOY_ENVS = new Set(["production", "preview", "dev", "development"]);
let envWarned = false;
function warnIllegalEnv(): void {
  if (envWarned) return;
  envWarned = true;
  const v = process.env.DEPLOY_ENV || process.env.VERCEL_ENV || "";
  if (v && !LEGAL_DEPLOY_ENVS.has(v)) {
    console.warn(`[deploy-env] DEPLOY_ENV/VERCEL_ENV="${v}" 不在 production/preview/dev 内，secure cookie 等按非生产处理，请修正拼写`);
  }
}

/** 部署环境标识：DEPLOY_ENV 优先，兜底 VERCEL_ENV，本地缺省 "dev" */
export function deployEnv(): string {
  warnIllegalEnv();
  return process.env.DEPLOY_ENV || process.env.VERCEL_ENV || "dev";
}

/** 是否已部署环境（非本地）：登录强制等判定，语义等价历史 Boolean(VERCEL_ENV) */
export function isDeployed(): boolean {
  warnIllegalEnv();
  return Boolean(process.env.DEPLOY_ENV || process.env.VERCEL_ENV);
}

/** 是否生产部署：cookie secure / 生产发信守卫等判定 */
export function isProdDeploy(): boolean {
  warnIllegalEnv();
  return (process.env.DEPLOY_ENV || process.env.VERCEL_ENV) === "production";
}

/** 构建标识：APP_BUILD_SHA（容器镜像 tag=git sha）优先，兜底 VERCEL_GIT_COMMIT_SHA，缺省 "local" */
export function buildSha(): string {
  return (process.env.APP_BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7);
}