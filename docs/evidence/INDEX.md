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
| ✅ | 单测 81 passed / 7 skipped（vitest 输出） | 本文件同目录 `ci-gates.md`（⏳ 归档运行输出） |

## 项目构建环节

| 状态 | 证据 | git 锚点 |
| --- | --- | --- |
| ✅ | standalone Dockerfile + .dockerignore | `9b334b2` |
| ✅ | SWR 推送脚本（tag=git 短 sha） | `afc34bd` |
| ✅ | CCE/ECS 编排清单 | `ab5cb38` |

## 问题修复环节

| 状态 | 证据 | 锚点 |
| --- | --- | --- |
| ✅ | 6 个真实问题与修复实录 | `docs/CODEARTS-PRACTICE.md` 第四节 |

## 部署上线环节

| 状态 | 证据 | 说明 |
| --- | --- | --- |
| ⏳ | HW-D-02 首次部署耗时记录 | 执行 T-035 后归档 `first-deploy.md` |
| ⏳ | HW-D-05 大陆直连验证 | 执行 T-035 后归档 `mainland-access.md` |
| ⏳ | HW-D-04 回滚演练 ≤10min | 执行 T-036 后归档 `rollback.md` |
| ⏳ | HW-T-04 迁移校验报告 | 执行 T-052 后归档 `migration-report.md` |
| ⏳ | HW-D-07 周报触发三场景 | 执行 T-041 后归档 `cron-trigger.md` |
| ⏳ | HW-V-01 LTS 检索验证 | 执行 T-044 后归档 `lts-search.md` |
| ⏳ | HW-V-03 Cloud Eye 告警可达 | 执行 T-045 后归档 `cloudeye-alert.md` |
| ⏳ | HW-O-01 Gitee 镜像 + secret 扫描 | 执行 T-065 后归档 `opensource-check.md` |
| ⏳ | HW-O-04 演示素材 OBS 链接 | 执行 T-068 后回填 README |
| ⏳ | HW-C-02 eval 质量对比（MaaS vs 旧服务商） | 执行 T-080 后归档 `eval-compare.md` |
| ⏳ | HW-P-04 CodeArts 流水线/扫描留档 | 执行 T-067 后归档 `codearts-pipeline.md` |