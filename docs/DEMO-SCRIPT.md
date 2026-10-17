# Mentora 演示脚本（录屏/答辩通用）

> 两种演示路径：A. 华为云公网 URL（PRD 方案 A 演示窗口期）B. 本地 Docker 容器（任何时刻可用，已验证）。
> 配套：`ARCHITECTURE-HUAWEI.md`（技术叙事）、`DEPLOY-HUAWEICLOUD.md`（部署 SOP）。

## 一、本地 Docker 演示路径（推荐日常使用，≤3 分钟准备）

前置：Docker Desktop 运行中（鲸鱼图标常驻）；仓库根目录。

```text
# 1. 起容器（镜像已在本地/SWR）
docker rm -f mentora-demo 2>nul
docker run -d --name mentora-demo -p 3000:3000 ^
  -e AI_PROVIDER=custom ^
  -e AI_BASE_URL=https://tokenrhythm.studio/v1 ^
  -e AI_MODEL=qwen3.8-flash ^
  -e CUSTOM_API_KEY=<你的Key，从记事本粘贴> ^
  -e AUTH_SECRET=<与 .env.local 一致> ^
  swr.cn-east-3.myhuaweicloud.com/mentora/mentora:81f9e91

# 2. 健康自检（通道应显示 db:github ai:custom）
curl http://localhost:3000/api/health

# 3. 浏览器打开 http://localhost:3000 演示
# 4. 收尾
docker rm -f mentora-demo
```

> 已验证：同镜像冒烟 `/api/health` 返回 200（docs/evidence/logs，2026-10-17）。
> 数据通道保持 github（零成本）；演示华为云线时改 `-e DB_CHANNEL=rds -e DATABASE_URL=...`（需 RDS 窗口）。

## 二、录屏分镜（总时长 5-7 分钟）

| # | 分镜 | 内容要点 | 时长 |
| --- | --- | --- | --- |
| 1 | 开场 | 一句话定位：「想学什么，说一声」——AI 教练式学习产品；四模块巡礼（目标/教练/读书/复习） | 30s |
| 2 | 核心闭环 | 建学习目标→AI 定计划→提交作业→AI 判分带讲义→复习排期（真实交互，不剪快进） | 90s |
| 3 | AI 对话实测 | 教练对话演示；**提示：qwen3.8-flash 为推理模型，首字延迟 1-2 秒属正常**（思维链先输出）；备选换 glm-5.1（非思维链）消除等待感 | 60s |
| 4 | 技术叙事 | 打开 `docs/ARCHITECTURE-HUAWEI.md` 三主线：模型可插拔（六通道环境变量切换）/存储双通道（DB_CHANNEL）/RAG 混排检索（BM25⊕向量 RRF，失败回退） | 90s |
| 5 | 工程证据 | `git log --oneline` 36+ 提交追溯；CI 五道门禁；`/api/health` 通道自检；SWR 镜像页截图（81f9e91 可回滚锚点） | 60s |
| 6 | 华为云线证据 | （窗口期拍摄）CCE 工作负载页 + RDS 实例页 + 大陆公网 URL 实测；或（纯免费版）实操日志归档+部署脚本走读 | 60s |
| 7 | 收尾 | CodeArts 五环节实践文档 + 13 个真实问题修复实录一句话总结 | 30s |

## 三、华为云公网演示路径（窗口期，参考 DEPLOY-HUAWEICLOUD.md）

1. 充值 + CCE 控制台授权（PRD §8 两项前置）
2. RDS/DCS 重建（脚本自动 15-25 分钟）→ Secret → 建集群 → 部署 → health 验证（全脚本化）
3. 录屏第 6 分镜：ELB 公网 IP 直连实测 + CCE/RDS 控制台页
4. 演示完毕：全套删除 → 确认 0 计费 → 归档关停日志

## 四、防翻车清单

| 风险 | 对策 |
| --- | --- |
| qwen3.8-flash 首字慢 | 演示前换 glm-5.1（改 `AI_MODEL` 重启容器）；或演示话术主动说明"推理模型，先思考后回答" |
| 网络波动 tokenrhythm 不可达 | AI 层有演示模式兜底（不白屏）；提前 10 分钟跑 `verify-model.mjs` 预检 |
| 思维链静默期观感 | 引导语："模型正在思考"（前端已有 reasoning 提示态） |
| 数据隐私 | 演示用测试账号；数据库内无真实用户信息 |
| Key 轮换 | 比赛结束后轮换 tokenrhythm Key；删除桌面 download.csv 与 hw-secrets.txt |