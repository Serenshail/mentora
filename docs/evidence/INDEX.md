# 证据索引（HW-U-03 / HW-U-04：只归档真实记录，缺失项如实标注）

对照：验收条目（spec.md HW-*）↔ 证据形态 ↔ git 锚点。**状态**：✅ 已有 ｜ ⏳ 待真实环境补证（配置/脚本已就绪）。

## 需求理解环节

| 状态 | 证据 | 锚点 |
| --- | --- | --- |
| ✅ | 需求规格 spec.md（51 条 EARS） | `.codeartsdoer/specs/huawei_cloud_upgrade/spec.md` |
| ✅ | 实现方案 design.md（7 项决策） | 同目录 `design.md` |
| ✅ | 任务规划 tasks.md（45 任务 M0-M7） | 同目录 `tasks.md` |

## 代码生成环节

| 状态 | 证据 | git 锚点 |
| --- | --- | --- |
| ✅ | 存储层双通道（RDS/DCS/DB_CHANNEL 路由） | `53fcbcb` `2d74a42` `cdec0e6` `e8d882b` |
| ✅ | 模型层 MaaS 通道 + 配置抽取 | `42708e2` `f7b7efe` `a2162ee` |
| ✅ | 健康检查版本/通道展示 | `9e9b0f5` |
| ✅ | 发信双轨 EMAIL_CHANNEL | `637c715` |
| ✅ | RAG 向量混排（回退 BM25） | `46eb8cc` |
| ✅ | 漏斗聚合管理端点 | `73f34a7` |
| ✅ | 单测：改造期 81 passed → 2026-10-27 本地 `vitest run` **144 passed / 7 skipped**（7 条为 e2e.local，需 `E2E=1` 与本地 dev server） | 本文件同目录 `ci-gates.md`（⏳ 归档云端 CI 运行输出；本地数字来自实测，非 CI 留档） |

## 项目构建环节

| 状态 | 证据 | git 锚点 |
| --- | --- | --- |
| ✅ | standalone Dockerfile + .dockerignore（基础镜像 ARG 化支持加速源） | `9b334b2` `7e6c175` |
| ✅ | SWR 推送脚本（tag=git 短 sha） | `afc34bd` |
| ✅ | CCE/ECS 编排清单 | `ab5cb38` |
| ✅ | **镜像推送 SWR 实测成功**（81f9e91/latest 双 tag，67.8MB，OCI manifest 验证） | `783c079` |
| ✅ | **本地容器冒烟 T-031**（/api/health 200，通道自检正确） | `783c079` |
| ✅ | **模型通道切换实证**（custom/tokenrhythm 调用 200/1.5s） | `verify-model.mjs` |

## 问题修复环节

| 状态 | 证据 | 锚点 |
| --- | --- | --- |
| ✅ | 13 个真实问题与修复实录（代码期 6 + 实操期 7） | `docs/CODEARTS-PRACTICE.md` 第四节 |

## 部署上线环节（实操期：开通→验证→删除全链路已演练）

| 状态 | 证据 | 说明 |
| --- | --- | --- |
| ✅ | RDS/DCS 创建→就绪→删除全链路实测（规格预查询/幂等重跑） | `docs/evidence/logs/` 实有 **14 份**（step1×3 + step2×11，脱敏） |
| ✅ | VPC/SWR 组织/凭证链打通 | 同上 |
| ✅ | 沙箱↔华为云 API 直连可行性论证（服务域名白名单内，9 种端点实测） | 会话记录+日志 |
| ⏳ | HW-D-02 首次部署耗时记录 | 按 PRD 方案 A 演示窗口执行后归档 `first-deploy.md` |
| ⏳ | HW-D-05 大陆直连验证 | 同上归档 `mainland-access.md` |
| ⏳ | HW-D-04 回滚演练 ≤10min | 归档 `rollback.md` |
| ⏳ | HW-T-04 迁移校验报告 | 归档 `migration-report.md` |
| ⏳ | HW-D-07 周报触发三场景 | 归档 `cron-trigger.md` |
| ⏳ | HW-V-01 LTS 检索验证 | 归档 `lts-search.md` |
| ⏳ | HW-V-03 Cloud Eye 告警可达 | 归档 `cloudeye-alert.md` |
| ⏳ | HW-O-01 Gitee 镜像 + secret 扫描 | 归档 `opensource-check.md`（待用户提供 Gitee 仓库） |
| ⏳ | HW-O-04 演示素材 OBS 链接 | 回填 README |
| ⏳ | HW-C-02 eval 质量对比（MaaS vs 旧服务商） | 归档 `eval-compare.md` |
| ⏳ | HW-P-04 CodeArts 流水线/扫描留档 | 归档 `codearts-pipeline.md` |
| ✅ | CCE 服务授权（2026-10-20 控制台单击完成，三委托 `cce_admin_trust`/`cce_cluster_agency`/`CCENodeAgency` 已建） | 无 CLI/API 通道，PRD §8；集群创建与部署仍待演示窗口（`CceClusterId` 目前为空） |