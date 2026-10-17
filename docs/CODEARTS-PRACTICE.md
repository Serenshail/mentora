# 从想法到应用：Mentora × 华为云 CodeArts 实践全记录

> 本文是赛题任务 1 的核心交付：如实记录本项目如何以华为云 CodeArts 智能体完成"想法 → 应用"全过程。
> 纪律：**不伪造任何证据**（HW-U-04）。凡本环境无法实操的环节（需真实云资源），文中如实标注"待部署后补证"。

## 一、过程总览

五个环节按规范流程（spec-driven）推进，每个任务一次 git 提交（HW-P-01），提交信息格式 `[环节-功能点] 描述`，可按提交历史逐条回溯（HW-U-03）：

| 环节 | 产物 / 证据 | 代码仓锚点 |
| --- | --- | --- |
| 1. 需求理解 | `spec.md`（794 行，51 条 EARS 需求）+ `design.md`（706 行，7 项决策）+ `tasks.md`（45 任务） | `.codeartsdoer/specs/huawei_cloud_upgrade/` |
| 2. 代码生成 | 20+ 个 `[codegen-*]`/`[deploy-*]` 提交（双通道存储层、MaaS 模型层、健康检查、发信双轨、RAG 混排…） | `git log --oneline` |
| 3. 项目构建 | Dockerfile（standalone 双阶段）+ SWR 推送脚本 + CCE/ECS 编排清单 + 本机 CI 五道门禁记录 | `Dockerfile`、`scripts/deploy-hw-build.mjs`、`deploy/` |
| 4. 问题修复 | 6 个真实问题及修复实录（见下文第四节） | 对应 fix 提交 |
| 5. 部署上线 | 编排/迁移/定时/可观测配置全部入库；实操演练（真实环境）待补 | `docs/DEPLOY-HUAWEICLOUD.md` |

## 二、需求理解环节

以 CodeArts 智能体完成需求规格设计（spec-requirement-agent）：

- 输入：赛题原文（基于华为云产品打造 AI 创新应用）+ Mentora 既有代码库。
- 产出：51 条 EARS 格式需求（HW-* 编号），覆盖双通道架构（HW-M/T/S/D/V/O/C/P/U 十族）、20 项华为云替代判定全景表（spec §0.4）、38 条既有验收沿用红线（HW-P-03：改造不得劣化现状）。
- 关键决策（design.md）：镜像 tag = git 短 sha（回滚锚点）；`DB_CHANNEL`/`AI_PROVIDER`/`EMAIL_CHANNEL` 三层通道全部配置切换、代码零改动；凭据永不入仓。

**可出示证据**：spec/design/tasks 三文档；评审对话记录（智能体会话）。

## 三、代码生成环节（节选故事线）

存储层双通道是最大改造：db.ts 从单一通道改造为 `DB_CHANNEL` 显式路由（`huawei` 模式前缀分流——限流/验证码/配额/登录失败计数走 DCS，用户/数据/版本/事件走 RDS；缺省 auto 保持 Upstash→D1→GitHub 历史优先级）。

- 模型层：注册表新增 `maas` ProviderId，`AI_PROVIDER=maas` 部署默认，`MAAS_BASE_URL` 可覆盖。
- 每个功能点一次提交、一次门禁（tsc + lint + test + build）。新增单测 33 条（ai-config 13 / db-channel 18 / chat-usage 4 → 后续 mail 8 / rag 8 / stats，累计 81 passed）。

**可出示证据**：提交历史（`9e9b0f5`→`46eb8cc` 等 20+ 提交）；测试运行记录（见 evidence）。

## 四、问题修复环节（真实问题实录）

改造过程中真实发生、真实修复的 13 个问题（前 6 条为代码期，后 7 条为实操期）：

1. **Turbopack 构建受限**：开发沙箱网络策略禁止访问 127.0.0.1 内部端口，`next build`（Turbopack）报 `Sandbox Network Error`。修复：本环境以 `next build --webpack` 验证产物编译，CI/本机仍保留默认构建（等效产物，问题与载体相关而非代码相关）。
2. **vitest 不解析 `@/` 别名**：新增测试无法导入。修复：lib 下新建测试统一相对导入 `../server/db`；服务端模块 `import "server-only"` 用 `vi.mock("server-only", () => ({}))` 豁免。
3. **模块级常量固化**：db.ts 通道常量在 import 时固化，单测无法模拟不同 env。修复：`vi.resetModules()` + 动态 `import()` 每场景重载，形成 18 条通道路由回归锁。
4. **CRLF 行尾破坏字符串替换**：deploy-hw-build.mjs 的清单占位符替换在 Windows checkout（autocrlf）下 `\n` 不命中 `\r\n`，替换静默残留。修复：读取后先 `.replaceAll("\r\n", "\n")` 归一。问题由"残留 PLACEHOLDER 校验器"当场拦下（校验器设计即为此类问题兜底）。
5. **pg 数组参数类型不匹配**：`= ANY($1::text[])` 传 JS 数组与 rdsQuery 参数签名冲突。修复：改为 `IN ($1..$5)` 展开参数，与 D1 侧 SQL 语义对齐。
6. **git 提交后接管道静默失败**：Windows git-bash 下 `git commit ... | tail` 偶发吞掉提交。修复：提交命令不接管道，add/commit 分步执行并回读 `git log` 确认。
7. **RDS 创建 DBS.280241 存储类型非法**：脚本预设 `volume.type=ULTRAHIGH` 在 cn-east-3/PG15 已不存在（区域枚举更名 GPSSD2/CLOUDSSD/ESSD），5 次重跑同因失败。修复：创建前 `ListStorageTypes`/`ListFlavors` 预查询取合法值，规格不匹配自动降级备选（`3f5de6a`；根因由运行日志 `step2-20261017-012924.log` 定位）。
8. **KooCLI 7.x 参数体系全量适配**：旧 `--ak/--sk` 报错且**退出码 0 假成功**（`9e0d9a7`）；交互确认在非交互管道被拒、且 `--password/--mode` 与系统参数同名撞车——改走 `--cli-jsonInput` 分层 JSON 临时文件（`531b29d`）；JSON 前混打印提示行破坏 `ConvertFrom-Json`——改为从首个 `{`/`[` 截起解析（`7430742`）；回显脱敏防凭据进日志（`bd43c7f`）。
9. **SWR 推送 manifest 解析失败**：Docker 29/buildx 默认附加 provenance attestation（OCI manifest list），SWR 个人版解析报 `fail to parse 'manifest.json'`。修复：`buildx build --provenance=false --sbom=false --push` 直推（`783c079`）。
10. **容器内 npm ci ERESOLVE**：vitest@5 peerOptional 要求 `@types/node@^22||>=24`，项目锁 ^20——本机 node24 的 npm 解析宽松通过，容器 node:20 触发冲突。修复：Dockerfile `npm ci --legacy-peer-deps`（仅影响镜像构建，`7e6c175`）。
11. **Docker Hub 拉取被墙**：registry-1.docker.io DNS 污染（解析至 69.171.x）。修复：Dockerfile `ARG NODE_IMAGE` 抽象基础镜像，构建传 `docker.m.daocloud.io/library/node:20-alpine` 加速源，默认值不变（`7e6c175`）。
12. **PowerShell 5.1 编码陷阱×2**：UTF-8 无 BOM 中文脚本被按 GBK 解析致语法错；`Set-Content -Encoding UTF8` 写出的 BOM 令 docker config.json 解析失败（push 无认证头）。修复：单 BOM 规范 + `[IO.File]::WriteAllText` 无 BOM 重写 + 每脚本过 PSParser 语法校验（`e35eee7`）。
13. **DCS 批删参数结构与版本差异**：`DeleteInstance` operation 不存在（需 `BatchDeleteInstances`）；body 字段为单数 `instance_id` 且 KooCLI 支持数组 KV 语法 `--instances.1=<id>`（实操日志归档）。

**可出示证据**：上述每条对应提交/文件/运行日志（`docs/evidence/logs/` 已归档 15 份，全部脱敏扫描）。

## 五、项目构建与部署上线环节

- 构建：双阶段 Dockerfile（builder 跑 `npm ci && npm run build`，运行层 non-root 用户 + standalone 产物）；SWR 推送以 git 短 sha 打 tag（回滚锚点，历史 tag 全保留）。
- 编排：CCE Autopilot 清单（Deployment 滚动升级 maxUnavailable=0 + ELB Service + HPA min1）；ECS 备选 docker compose（同一镜像零差异）。
- 部署后配套：FunctionGraph 定时触发器（周报，fail-closed）、LTS 日志字段检索表、Cloud Eye/SMN 告警、迁移与回滚 SOP——全部入库为可复现文档。

**已实操验证（真实环境，2026-10-17）**：

| 项 | 结果 | 锚点 |
| --- | --- | --- |
| 镜像构建+推送 SWR | ✅ `mentora/mentora:81f9e91`+`latest` 双 tag，67.8MB，OCI manifest 验证通过 | `783c079` |
| 容器冒烟 T-031 | ✅ 容器启动 + `/api/health` 200（通道健康自检正确反映未注入状态） | `783c079` |
| 模型通道切换实证 | ✅ `AI_PROVIDER=custom`（tokenrhythm/qwen3.8-flash）调用 HTTP 200/1.5s/usage 正常 | `verify-model.mjs` |
| RDS/DCS 全链路演练 | ✅ 创建→就绪→删除实测通过（按需开关架构验证，含规格预查询幂等重跑） | 日志归档 |
| VPC/SWR 组织/SWR 登录 | ✅ 网络骨架与凭证链打通 | 日志归档 |

**待部署窗口补证（如实标注）**：CCE 集群常驻部署耗时（HW-D-02）、大陆直连验证（HW-D-05）、回滚演练 ≤10 分钟实测（HW-D-04）、迁移校验报告（HW-T-04）——脚本与链路已就绪，待按 PRD 方案 A 演示窗口执行后归档 `docs/evidence/`。CCE 服务授权确认已确认无 CLI/API 通道（KooCLI 全命令集核查），须控制台单击，已记入 PRD §8 开放问题。

## 六、证据索引

见 [`docs/evidence/INDEX.md`](evidence/INDEX.md)：每项证据 ↔ git 提交 sha ↔ 验收条目对照；已有证据与待补证据分列。