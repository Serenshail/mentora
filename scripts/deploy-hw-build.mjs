#!/usr/bin/env node
/* ============================================================
 * SWR 镜像构建推送 + CCE 部署 / 回滚（T-032，回滚锚点见 design 决策 1）
 *
 * 镜像 tag = `git rev-parse --short HEAD`，与 git 提交一一对应；
 * 历史 tag 全部保留在 SWR，回滚即切回上一 tag（≤10 分钟纪律，HW-D-04）。
 * 仓库内 deploy/cce-mentora.yaml 保持占位符，绝不写入环境相关值；
 * deploy 时在内存替换镜像 tag 与 APP_BUILD_SHA 后经 stdin 交给 kubectl。
 *
 * 前置（一次性，凭据不入仓）：
 *   docker login <SWR_REGISTRY>          # SWR 控制台"生成临时指令"
 *   kubectl create secret generic mentora-secrets ...   # 见 deploy/cce-mentora.yaml 头部
 *
 * 用法：
 *   SWR_REGISTRY=swr.cn-east-3.myhuaweicloud.com/mentora \
 *     node scripts/deploy-hw-build.mjs build          # docker build（tag=git 短 sha + latest）
 *   ... push                                          # docker push 两个 tag
 *   ... deploy                                        # kubectl apply + 滚动升级等待
 *   ... rollback                                      # kubectl rollout undo（上一版本）
 *   ... rollback --tag <short-sha>                    # 精确切回指定历史 tag
 *   ... all                                           # build + push + deploy
 * 环境变量：SWR_REGISTRY（必填）、IMAGE_REPO（默认 mentora）、
 *           KUBE_NAMESPACE（默认 default）、--allow-dirty（跳过工作区清洁检查）
 * ============================================================ */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "deploy", "cce-mentora.yaml");
const REGISTRY = process.env.SWR_REGISTRY;
const REPO = process.env.IMAGE_REPO || "mentora";
const NAMESPACE = process.env.KUBE_NAMESPACE || "default";
const ALLOW_DIRTY = process.argv.includes("--allow-dirty");

if (!REGISTRY) {
  console.error("缺少 SWR_REGISTRY 环境变量，例如：swr.cn-east-3.myhuaweicloud.com/mentora");
  process.exit(1);
}
const IMAGE = `${REGISTRY}/${REPO}`;

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`命令失败（exit=${r.status}）：${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function gitShortSha() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error("无法读取 git 提交（是否在仓库内？）");
    process.exit(1);
  }
  return r.stdout.trim();
}

/* tag 可追溯性前提：工作区干净（HEAD 即镜像内容）。脏区默认中止。 */
function assertCleanTree() {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  const dirty = r.status !== 0 || r.stdout.trim().length > 0;
  if (dirty && !ALLOW_DIRTY) {
    console.error("工作区存在未提交变更：镜像 tag 将无法对应源码。先提交，或加 --allow-dirty 强制继续。");
    process.exit(1);
  }
  if (dirty) console.warn("警告：--allow-dirty 已跳过清洁检查，当前 tag 不完全对应已提交源码。");
}

/* deploy/rollback --tag 共用：内存替换占位符后经 stdin apply，仓库文件保持原样 */
function kubectlApplyTag(tag) {
  const manifest = readFileSync(MANIFEST, "utf8")
    .replaceAll("\r\n", "\n") /* git autocrlf 行尾归一，保证替换命中 */
    .replaceAll("mentora/mentora:PLACEHOLDER", `${REPO}:${tag}`)
    .replaceAll("APP_BUILD_SHA\n              value: PLACEHOLDER", `APP_BUILD_SHA\n              value: ${tag}`);
  if (manifest.includes("PLACEHOLDER")) {
    console.error("清单仍含未替换的 PLACEHOLDER，替换规则与 deploy/cce-mentora.yaml 不一致，中止。");
    process.exit(1);
  }
  run("kubectl", ["apply", "-n", NAMESPACE, "-f", "-"], { input: manifest });
  run("kubectl", ["-n", NAMESPACE, "rollout", "status", "deployment/mentora", "--timeout=5m"]);
}

const [cmd] = process.argv.filter((a) => !a.startsWith("--") && a !== process.argv[0] && !a.endsWith("deploy-hw-build.mjs"));

switch (cmd) {
  case "build": {
    assertCleanTree();
    const sha = gitShortSha();
    run("docker", ["build", "-t", `${IMAGE}:${sha}`, "-t", `${IMAGE}:latest`, ROOT]);
    console.log(`已构建 ${IMAGE}:${sha}（+ latest）`);
    break;
  }
  case "push": {
    const sha = gitShortSha();
    run("docker", ["push", `${IMAGE}:${sha}`]);
    run("docker", ["push", `${IMAGE}:latest`]);
    console.log(`已推送 SWR：${IMAGE}:${sha}（历史 tag 全保留，可作回滚锚点）`);
    break;
  }
  case "deploy": {
    assertCleanTree();
    kubectlApplyTag(gitShortSha());
    break;
  }
  case "rollback": {
    const i = process.argv.indexOf("--tag");
    if (i > -1 && process.argv[i + 1]) {
      const tag = process.argv[i + 1];
      console.log(`切回指定历史 tag：${tag}`);
      kubectlApplyTag(tag);
    } else {
      console.log("rollout undo 至上一 ReplicaSet");
      run("kubectl", ["-n", NAMESPACE, "rollout", "undo", "deployment/mentora"]);
      run("kubectl", ["-n", NAMESPACE, "rollout", "status", "deployment/mentora", "--timeout=5m"]);
    }
    break;
  }
  case "all": {
    assertCleanTree();
    const sha = gitShortSha();
    run("docker", ["build", "-t", `${IMAGE}:${sha}`, "-t", `${IMAGE}:latest`, ROOT]);
    run("docker", ["push", `${IMAGE}:${sha}`]);
    run("docker", ["push", `${IMAGE}:latest`]);
    kubectlApplyTag(sha);
    break;
  }
  default:
    console.log("用法：node scripts/deploy-hw-build.mjs <build|push|deploy|rollback [--tag <sha>]|all> [--allow-dirty]");
    process.exit(1);
}