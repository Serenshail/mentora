# DEPLOYMENT-V26.2 — 生产部署记录

**日期**：2026-11-07　**提交**：`152275d`（tag `v26.2.0`）　**部署执行**：用户批准（「继续」）后实施

## 1. 部署步骤与验证

### Vercel

| 步骤 | 结果 |
|---|---|
| `git push origin 152275d:master`（快进 4218277→152275d）+ tag v26.2.0 | ✅ GitHub 接收 |
| git 集成自动构建（本次正常触发，无需 CLI 补部署） | ✅ |
| `GET /api/health` | ✅ `{"ok":true,"build":"152275d","channel":{"db":"d1","ai":"deepseek"}}` |
| `/life` 匿名 307 → `/login?next=%2Flife`（中间件守卫，预期） | ✅ |
| `/life` 带探针会话 → RSC flight 携带 `/learn?tab=life`，浏览器水合后跳转（Next 静态页标准 redirect 形态，与 V26.1 一致） | ✅ |
| `scripts/check-f-vercel.mjs`（浏览器级，带代理） | ✅ **学习工作台第三 tab 真实渲染 LifeWorkspace**（学习足迹页头+足迹区在、教练内容不在、`/life`→URL 变为 `/learn?tab=life`）——H1 生产实证；种子条目断言受既诊种子-云同步竞态影响（TEST-REPORT §3.1），条目级证据由腾讯云 F1/F2 补齐 |

### 腾讯云自托管（192.144.181.171）

| 步骤 | 结果 |
|---|---|
| 本地 tar（src + package.json + next.config.ts）→ scp | ✅ |
| 解压到 /opt/mentora + chown + `CONTAINER_BUILD=1 npm run build` | ✅ 构建成功 |
| cp public 与 .next/static 进 standalone + `systemctl restart mentora` | ✅ service active |
| 服务器本地 health | ✅ ok（build:"local" 为 tar 部署预期，代码已验证为新版） |

### 生产冒烟（腾讯云，`SMOKE_BASE=http://192.144.181.171:3000 node scripts/smoke-v26.mjs`）

**8 PASS / 5 FAIL，与 dev 轮完全同构**（详见 TEST-REPORT §3）：D1/D2（书籍核查弹窗）、**F1/F2（学习人生足迹+结果层过滤）**、G（自动滚动）、H（预算文案）、E1（重排入口）全过；A/C/E2=已定性基建问题，B=已立项遗留。F1/F2 在腾讯云生产通过=H1 的条目级生产实证。

## 2. 部署后状态

- 双环境均运行 V26.2 代码；AI 通道 Vercel=deepseek、腾讯云=custom(qwen)。
- 数据层零迁移：persist v8 不变；`Book.verification` / `Goal.planHistory` 为可选字段，旧数据缺省安全。
- 探针 probe-x2 在两环境的实测残留：冒烟种子目标/知识点（脚本固定 id，下轮 reset 会清）；无真实用户受影响。

## 3. 回滚路径

锚点 tag `v26.1.5-isolation`（origin/master 前一版本）。Vercel：`git revert 152275d && git push` 或 Vercel Promote；腾讯云：tar 恢复锚点版 src → 构建 → 重启（详见 [ROLLBACK-V26.2.md](./ROLLBACK-V26.2.md)）。未执行生产回滚演练（本轮未触发回滚需求）。

## 4. 遗留（承接 TEST-REPORT §6）

B2 刷新恢复 <180s 静默回放（P1）、smoke harness 种子竞态与首场景加固、小程序 verification 徽章、英文句级残余误伤、C4 候选确认 UI、H6 路径列表常显。
