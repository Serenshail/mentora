# 华为云可观测性：LTS 日志采集 + Cloud Eye 监控告警（T-044/045，HW-V-01/03）

## 一、LTS 日志采集（容器 stdout → LTS）

### 采集链路

- **CCE Autopilot（主方案）**：容器 stdout/stderr 由 CCE 与 LTS 的集成默认采集（集群关联 LTS 日志组/日志流；控制台"日志中心"开启上报即可，无需安装组件）。
- **ECS（备选）**：安装 ICAgent/UniAgent → 采集 `/var/lib/docker/containers/**/*.log`（json-file 驱动，deploy/docker-compose.hw.yml 已限转 20MB×5）→ 上报 LTS。

### 日志格式（代码现状，检索依据）

应用所有运维日志经 `logEvent` 输出**单行 JSON**（src/lib/server/config.ts:31-33）：

```json
{"ts":"2026-10-16T12:00:00.000Z","ev":"admin","msg":"stats","by":"admin-password"}
{"ts":"...","route":"chat","task":"quiz-grade","error":"..."}
{"ts":"...","route":"chat-usage","task":"...","provider":"maas","model":"DeepSeek-V3.1","byok":0,"prompt_tokens":123,"completion_tokens":456}
```

### 检索验证（T-044 验收，留痕 docs/evidence/lts-search.md）

部署版产生一次对话（含一次上游失败）后，在 LTS 日志流中按字段检索：

| 检索目标 | LTS 查询示例 |
| --- | --- |
| 模型用量（按 provider） | `"route":"chat-usage" AND "provider":"maas"` |
| Token 消耗 | `"route":"chat-usage"` → 展开 `prompt_tokens`/`completion_tokens` 字段聚合 |
| 上游错误 | `"route":"chat" AND "error":*` |
| 限流/降级 | `"route":"ratelimit"` 或按具体事件字段 |

### 纪律（存量，部署后复核）

- 日志**不含密钥**（API Key/CRON_SECRET/SESSION 不打日志）、**不含会话原文**（只记 task 枚举、错误消息与 token 计量）。
- 若 LTS 检索发现敏感值在位，立即按事故处理并回溯 logEvent 调用点。

## 二、Cloud Eye 基础监控 + 告警（T-045）

### 指标可见性

- **CCE Autopilot**：工作负载 CPU/内存/实例状态指标自动上报 Cloud Eye（集群"监控"页与 Cloud Eye"容器视图"均可看）。
- **ECS**：基础指标（CPU/内存/网络）随云监控 Agent 自动上报。
- 应用层健康：`/api/health` 已含通道与版本信息（T-034），可作 ELB 健康检查路径。

### 告警规则（演示时段可达作者）

1. Cloud Eye → 告警 → 创建告警规则：
   - 资源：mentora Deployment/ECS 实例
   - 触发条件（建议）：CPU > 85% 持续 5 分钟；内存 > 85% 持续 5 分钟；实例数 < 1（可用性）
   - 通知对象：SMN 主题（订阅作者手机号/邮箱，演示时段保持可达）
2. ELB 健康检查：监听器开启对 3000 端口 `/api/health` 的健康检查（异常实例自动摘除）。
3. 验证留痕：压测/手动制造一次高负载或重启实例，确认 SMN 通知可达，归档 `docs/evidence/cloudeye-alert.md`。