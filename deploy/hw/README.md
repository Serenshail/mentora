# Mentora 华为云一键部署脚本包（用户本机执行）

> 背景：开发沙箱无法直连华为云网络，所有开通/部署操作由本脚本包在你的本机
> PowerShell 中执行。与 `docs/DEPLOY-HUAWEICLOUD.md` 一一对应，每步自动记录
> 日志到 `docs/evidence/logs/`（比赛证据）。**凭据一律交互输入，绝不入仓。**

## 执行顺序（在仓库根打开 PowerShell，依次运行）

```powershell
# Step1 工具检查与安装（node/git/docker/kubectl/hcloud，缺啥装啥）
powershell -ExecutionPolicy Bypass -File deploy\hw\step1-install-tools.ps1

# Step2 开通云资源（AK/SK → VPC/安全组/RDS/DCS/SWR/CCE Autopilot；MaaS 项已可跳过）
#   耗时最长（RDS+DCS 异步创建约 15-30 分钟，可挂着干别的）
powershell -ExecutionPolicy Bypass -File deploy\hw\step2-open-cloud.ps1

# Step3 镜像构建与推送 SWR（tag=git 短 sha；可选本地容器冒烟 = T-031）
powershell -ExecutionPolicy Bypass -File deploy\hw\step3-build-push.ps1

# Step4 RDS 建表与存量迁移（三表 DDL → 密文透传迁移 → 对账 → 抽样解密校验）
powershell -ExecutionPolicy Bypass -File deploy\hw\step4-init-migrate.ps1

# Step5 CCE 部署与验证（Secret → 滚动部署 → ELB → /api/health 双通道确认）
powershell -ExecutionPolicy Bypass -File deploy\hw\step5-deploy-verify.ps1
```

每一步都可安全重跑：已存在的资源直接复用；Secret 用 `--dry-run=client` 幂等更新。

## 前置条件

- 华为云账号已实名（报名比赛用同一账号）；账号内确保有按需付费额度
- 本机管理员网络可访问华为云（正常家庭/办公网络即可）
- 仓库 `.env.local` 存在且含 `AUTH_SECRET`（迁移加密一致性契约）

## 人工配合项（CLI 不开放，脚本会暂停等待）

| 项 | 位置 | 产出 |
| --- | --- | --- |
| AK/SK | 控制台右上角"我的凭证"→ 访问密钥 | step2 输入 |
| 模型 API Key（自备 OpenAI 兼容端点；当前通道=custom，见 .env.example） | 你自己的模型服务商控制台 | step5 输入 CUSTOM_API_KEY |
| RDS 公网白名单 | RDS → 连接管理（step2 有提醒） | 放行本机出口 IP |
| （可选）FunctionGraph 发信中继 | 见 `deploy/functiongraph-cron.md` | 暂缓不影响主链路 |

## 回滚（≤10 分钟纪律）

```powershell
node scripts/deploy-hw-build.mjs rollback --tag <旧tag>   # 精确切回指定镜像
kubectl rollout undo deployment/mentora                   # 或回滚上一 ReplicaSet
```

## 费用提示（比赛期按需，结束后释放）

RDS `rds.pg.n1.large.2`（2C4G）+ DCS 1GB 单机 + CCE Autopilot 按量 Pod + ELB 5Mbit 带宽。
RDS 公网 EIP 仅迁移期使用，迁移完可在控制台解绑；不用 DCS 时可降配或删实例（通道自动回退）。

## 红线

- AK/SK、数据库密码、MaaS Key 只在交互窗口输入，任何情况下不写入仓库文件
- `deploy/hw/hw-resources.ps1`（step2 生成）仅含资源 ID/地址，已加入 `.gitignore`
- 日志文件若出现凭据请删除后再归档；`docs/evidence/logs/` 只提交脱敏日志