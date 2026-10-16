import "server-only";

/* ============================================================
 * 部署环境标识（HW-D-06：Vercel 绑定 env 通用化）
 *
 * 同一镜像可同时跑 Vercel 与华为云（design 决策 3）：
 *  · DEPLOY_ENV 显式优先——容器/CCE 编排注入（production/preview/dev）
 *  · 兜底 VERCEL_ENV——Vercel 平台自动注入，行为与历史一致
 *  · 键隔离（rl//code//loginfail/）、登录强制、cookie secure 均由此驱动
 * ============================================================ */

/** 部署环境标识：DEPLOY_ENV 优先，兜底 VERCEL_ENV，本地缺省 "dev" */
export function deployEnv(): string {
  return process.env.DEPLOY_ENV || process.env.VERCEL_ENV || "dev";
}

/** 是否已部署环境（非本地）：登录强制等判定，语义等价历史 Boolean(VERCEL_ENV) */
export function isDeployed(): boolean {
  return Boolean(process.env.DEPLOY_ENV || process.env.VERCEL_ENV);
}

/** 是否生产部署：cookie secure / 生产发信守卫等判定 */
export function isProdDeploy(): boolean {
  return (process.env.DEPLOY_ENV || process.env.VERCEL_ENV) === "production";
}

/** 构建标识：APP_BUILD_SHA（容器镜像 tag=git sha）优先，兜底 VERCEL_GIT_COMMIT_SHA，缺省 "local" */
export function buildSha(): string {
  return (process.env.APP_BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7);
}