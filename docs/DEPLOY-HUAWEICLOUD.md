# Mentora 华为云部署指导（从零复现）

目标：按本文档从零在华为云复现 Mentora 部署并跑通核心流程。全程凭据仅经环境变量/编排配置注入，**任何密钥不入仓**。

架构：`ELB → CCE Autopilot（Next.js standalone 容器，SWR 镜像）→ RDS PostgreSQL（存储真源）+ DCS Redis（限流/验证码/配额）+ ModelArts MaaS（模型）`；备选载体 ECS + docker compose（同一镜像，应用侧零差异）。

双通道设计：所有外部依赖均可配置切换（`AI_PROVIDER` 模型层、`DB_CHANNEL` 存储层、`EMAIL_CHANNEL` 发信层），不配置华为云凭据时应用回退原有通道（Vercel 部署路径不受影响）。

---

## 1. 前置账号与区域

- 华为云账号，建议同区域（示例 `cn-east-3` 贵阳一，可自选）开通：RDS、DCS、SWR、CCE（Autopilot）或 ECS、ModelArts、FunctionGraph、LTS、Cloud Eye/SMN。
- 本地工具：Docker、kubectl（配置 CCE 凭据）、Node.js 20。

## 2. 开通三个数据/模型服务

### 2.1 RDS PostgreSQL（存储真源）

1. RDS → 购买 PostgreSQL 15（入门规格即可，单机，1C2G 起步足够 Demo）。
2. 设置管理员密码；**数据库端口默认 5432**；VPC 与 CCE 同一。
3. 创建数据库 `mentora`（或使用默认 postgres）。
4. 安全组放行：仅放行 CCE 网段/ECS 内网 IP（不要 0.0.0.0/0）。
5. 记录连接串：`postgresql://<user>:<pass>@<内网地址>:5432/<db>` → 即 `DATABASE_URL`。
6. 初始化三表（幂等）：`DATABASE_URL=... node scripts/init-rds-schema.mjs`（见 scripts/init-rds-schema.mjs）。

### 2.2 DCS Redis（限流/验证码/配额跨进程状态）

1. DCS → 购买 Redis 5.0/7.0 基础版（0.5-1GB 足够）。
2. 与 CCE 同 VPC；安全组同上收紧。
3. 记录连接地址 `redis://:<pass>@<内网地址>:6379`（支持 `rediss://` TLS）→ 即 `REDIS_URL`。

> 应用侧限流桶/验证码/配额/登录失败计数的键带 TTL 语义（值内 expiresAt 为行为权威），DCS 原生 TTL 仅做清理。

### 2.3 ModelArts MaaS（模型通道）

1. ModelArts → MaaS（ModelArts Studio）→ 开通服务。
2. 订阅模型（本仓默认 `DeepSeek-V3.1`，OpenAI 兼容端点）→ 创建 API Key。
3. 记录：`MAAS_API_KEY`；如端点地址与内置注册表不同，可设 `MAAS_BASE_URL`（缺省 `https://api.modelarts-maas.com/v1`）。
4. 配额用尽自动回退：`AI_CHEAP_MODEL` 可为判分分级指定更快的便宜模型。

## 3. 镜像构建与推送（SWR）

1. SWR → 创建组织（如 `mentora`）；获取登录指令并执行 `docker login`。
2. 构建推送（tag = git 短 sha，回滚锚点）：

   ```bash
   SWR_REGISTRY=swr.cn-east-3.myhuaweicloud.com/mentora \
     node scripts/deploy-hw-build.mjs all    # build + push + kubectl apply
   # 或分步：build / push / deploy / rollback --tag <sha>
   ```

3. 脚本要求工作区干净（tag 与 git 提交一一对应）；历史 tag 全保留在 SWR（回滚场地）。

## 4. 部署载体

### 4.1 主方案：CCE Autopilot

1. CCE → 购买 Autopilot 集群（同 VPC）。
2. 配置 kubectl 凭据（集群详情 → 连接信息）。
3. 一次性创建凭据 Secret（值全为占位说明，勿提交真实值）：

   ```bash
   kubectl create secret generic mentora-secrets \
     --from-literal=AUTH_SECRET=<32bytes-random> \
     --from-literal=DATABASE_URL=<2.1 记录的连接串> \
     --from-literal=REDIS_URL=<2.2 记录的连接串> \
     --from-literal=MAAS_API_KEY=<2.3 的 Key> \
     --from-literal=CRON_SECRET=<随机串> \
     --from-literal=APP_URL=<https://your-demo-url> \
     --from-literal=ADMIN_PASSWORD=<后台密码> \
     --from-literal=RESEND_API_KEY=<如用 Resend 发信> \
     --from-literal=MAIL_FROM=<noreply@your-domain>
   ```

4. 应用清单（Deployment + ELB Service + HPA 最小 1 实例）：

   ```bash
   kubectl apply -f deploy/cce-mentora.yaml
   ```

   清单内镜像为占位符，由 `deploy-hw-build.mjs deploy` 在内存替换后 apply；手工部署时自行替换镜像 tag。
5. 滚动升级策略：`maxUnavailable: 0 / maxSurge: 1`（demo 不中断）；探针 `/api/health`。

### 4.2 备选方案：ECS + docker compose

1. ECS（2C4G 起，Ubuntu 22.04）安装 Docker；同安全组访问 RDS/DCS。
2. 上传 `deploy/docker-compose.hw.yml`；同目录放 `.env.hw`（键见 §5；**勿入仓**）。
3. `IMAGE=<swr镜像:sha> docker compose -f deploy/docker-compose.hw.yml up -d`。

## 5. 环境变量注入清单（契约）

敏感项走 Secret/`.env.hw`；非敏感项已在编排清单固化：

| 变量 | 必需 | 说明 |
| --- | --- | --- |
| AUTH_SECRET | ✅ | 数据加密密钥（AES-256-GCM 派生源），迁移前后必须一致 |
| DATABASE_URL | 华为云通道 | RDS PostgreSQL 连接串 |
| REDIS_URL | 华为云通道 | DCS Redis 连接串 |
| MAAS_API_KEY | MaaS 通道 | ModelArts MaaS API Key |
| MAAS_BASE_URL | - | 缺省内置 MaaS 注册表地址 |
| CRON_SECRET | ✅ | 周报触发 Bearer（fail-closed） |
| APP_URL | ✅ | 对外 Demo URL（发信链接等使用） |
| ADMIN_PASSWORD / ADMIN_EMAILS | - | 后台密码 / 管理员白名单 |
| RESEND_API_KEY / MAIL_FROM | - | Resend 发信通道 |
| DEPLOY_ENV=production | 固化 | 部署环境标识 |
| DB_CHANNEL=huawei | 固化 | 存储通道：huawei / auto / upstash / d1 / github |
| AI_PROVIDER=maas | 固化 | 模型通道：maas / deepseek / zai / moonshot / openai / custom |
| APP_BUILD_SHA | 部署时 | git 短 sha（脚本注入，/api/health 展示） |

完整可选清单见 `.env.example`。

## 6. 定时任务（周报）

FunctionGraph 定时触发器（北京周一 09:00 → Bearer CRON_SECRET 调用周报端点，应用侧零改动）：见 `deploy/functiongraph-cron.md`。`vercel.json` crons 保留（Vercel 旧入口双载体）。

## 7. 可观测性

LTS 日志采集（容器 stdout 单行 JSON → LTS 字段检索）与 Cloud Eye/SMN 告警：见 `deploy/observability-hw.md`。

## 8. 存量数据迁移（可选：从旧通道迁入）

```bash
# 1) 初始化三表（§2.1 第 6 步）
# 2) 迁移（密钥预检 → 密文透传 UPSERT → 对账 → 抽样解密校验 → 报告）
GITHUB_DB_REPO=<owner/repo> GITHUB_DB_TOKEN=<pat> \
DATABASE_URL=<rds-url> AUTH_SECRET=<same-as-prod> \
  node scripts/migrate-to-rds.mjs
# 校验失败非 0 退出：主通道保持旧通道；全绿后再切换
```

切换主通道：部署环境设 `DB_CHANNEL=huawei`（env 变更，无代码变更），`/api/health` 应显示 `channel.db=huawei`。旧通道数据保留不删（回退场地）。

## 9. 验证清单

1. `https://<demo-url>/api/health` → `ok:true`、`channel.db=huawei`、`channel.ai=maas`、`build=<git 短 sha>`（非 local）。
2. 未登录访问落地页：四模块特性可见（大陆无代理网络验证，HW-D-05）。
3. 冒烟：注册/登录/引导→计划/每日课程/验收判分/复习同步，数据读写经 RDS/DCS。
4. 跨进程一致性：验证码/限流/配额在多实例（HPA 扩容）下生效。

## 10. 回滚（≤10 分钟纪律）

```bash
# 方式一：上一 ReplicaSet
kubectl -n default rollout undo deployment/mentora
# 方式二：精确切回指定镜像 tag（SWR 历史 tag 全保留）
SWR_REGISTRY=... node scripts/deploy-hw-build.mjs rollback --tag <short-sha>
```

env 与镜像解耦：通道切换只改 env（Secret 编辑后 `kubectl rollout restart deployment/mentora`），不重建镜像。

## 11. 可选：CDN 加速（ICP 备案域名完成后）

未备案则跳过（大陆直连可达即为满足）。配置路径：CDN → 添加域名（备案域名）→ 源站 = ELB IP/Demo 域名 → 缓存规则：`/_next/static/*` 长缓存、API 路径回源不缓存 → 验证首屏加载与 API 可用性。