# M3.1 真实环境验收报告（安全检查 / 工程基线 / 真机测试 / 数据矩阵 / M3 方案）

**日期：** 2026-11-08 ｜ **执行：** ZCode（真机验收会话）｜ **状态：** 除 D3（写入失败注入）外全部场景已执行；完成后暂停，等待 M3.2 批准
**被测版本：** 插件 m2-baseline 后续提交至 45e3fe0（含验收期修复）；服务端 master 64cee78（腾讯云 preview 环境）
**测试拓扑说明（如实申报）：** 真机期间发现 Obsidian requestUrl 直连腾讯云会 `ERR_CONNECTION_TIMED_OUT`（仪表盘今日学习卡同款错误，根因未完全定位；系统代理注册表为关闭状态）。为不阻塞验收，采用 **127.0.0.1:9999 本地中继拓扑**（`test/p3-server.mjs`：Obsidian requestUrl → 真实 HTTP → 本地 Node fetch 直连腾讯云）。这是真实 Obsidian 进程、真实网络栈、真实服务端的完整链路，仅中间多一跳本地转发；直连超时问题单列为遗留 B-1。

---

## 第一部分：安全检查报告

### 1.1 设备令牌传输（检查项 1-3）

| 项 | 结论 |
|---|---|
| 明文传输风险 | **真实存在**：默认 serverBase 与腾讯云现役地址均为 `http://`，令牌在公网明文传输 |
| 已落地的护栏 | 登录区 **http 明文警告**（非 localhost 的 http:// 地址必显橙色警告：「登录令牌将明文传输，可被中间人截获。仅限自测使用；正式使用请改用 HTTPS 域名地址」）——真机截图确认随 serverBase 动态更新 |
| 安全评估结论 | HTTP 公网地址**不得作为正式设备认证地址**（MITM 可截获令牌→读写账号数据+消耗 AI 配额）。当前仅可接受于**本机/自测**；正式发布前置条件 = HTTPS 域名（用户购域名 + Caddy 证书，腾讯云 caddy 已就绪）。mtApi 令牌仅经 `x-device-token` 请求头传输（grep 全仓无 URL 参数/日志/异常文本携带，服务端只存 sha256） |
| 默认/显式地址优先级 | `mtApiBase`: 显式 `serverBase` → 默认腾讯云（空值回落）；webview `mentoraBase`: 显式 `tools.mentora.baseUrl` → 默认腾讯云。**用户 vault 的 data.json 中 tools.mentora.baseUrl 为显式 vercel（旧值）**——源码默认已改腾讯云但显式配置优先，需用户在设置中清空/修改（M3.2 待办） |

### 1.2 DELETE /api/auth/device 权限与吊销范围（检查项 5-6）

- 守卫：`parseDeviceToken`（格式校验）→ 档案 dbGet → sha256 定长 `timingSafeEqual` 逐台比对 → 只吊销**匹配的那台**（`?all=1` 才全清）。无令牌 DELETE → 401（真机复测）。
- 吊销即时性（生产实测两轮）：签发 200 → sync 200 → DELETE 200 → **sync 401（立即）**。
- 幂等：重复 DELETE 返回 ok（remaining=0）。
- 单设备指定吊销（by deviceId）列 P1（后台设备管理页）。

### 1.3 DEPLOY_ENV=preview 全量复核（检查项 7，重新搜索非沿用盘点）

**直读搜索**：`process.env.DEPLOY_ENV / VERCEL_ENV` 在 src/、next.config.ts、Dockerfile 中**只出现在 `src/lib/server/deploy-env.ts`**（4 处读取聚合为 3 个导出）。华为云容器编排（docker-compose.hw.yml / cce-mentora.yaml）显式注入 `DEPLOY_ENV=production`，与腾讯云互不影响。

消费方逐项（grep 带行号证据）：

| 消费方 | 用法 | preview 的影响 | 隔离评估 |
|---|---|---|---|
| `auth.ts:77,87` | cookie `secure: isProdDeploy()` | preview≠production → **Secure 不加**（http 浏览器登录保留，这是选 preview 的原因） | 无隔离问题 |
| `chat/route.ts:554` | `enforceLogin = isDeployed()` | **激活**→匿名 AI 调用 401（本次修复目标，真机实证） | — |
| `fetch-page:62` / `search:150` | 登录强制 | 激活（公网匿名联网检索被封） | — |
| `memory:23` / `reminders:26` | `void isDeployed()`（空操作） | 无影响（这两路由本来就无条件鉴权） | — |
| `tasks/route.ts:4` | 仅 import 未使用（**既有死导入**） | 无影响 | 顺手项 |
| `rate-limit.ts:53` | `rl/<env>/` 前缀 | 计数迁入 `rl/preview/` | 限流按环境隔离=设计意图；跨环境攻击面=两套桶（接受，个人规模） |
| `login-guard.ts:23` | `loginfail/<env>/` | 锁定计数迁入 preview | 同上：账号爆破尝试额度跨环境翻倍（8×2），接受并记录 |
| `mail.ts:29` | `code/<env>/` | **死命名空间**——issueCode/verifyCode 无任何调用方（send-code 已删） | 无影响 |
| `reset-code.ts:20` | `reset/<emailHash>` **无 env 前缀** | 管理员发的重置码跨环境可用 ✓（正确） | 无隔离问题 |

**生产命名空间污染检查**：腾讯云所有带 env 前缀的键均在 `*/preview/` 下；Vercel（VERCEL_ENV=production）在 `*/production/` 下；`users/ data/ versions/ licenses/ reset/` 等数据真源无前缀、双环境共享（加密同钥 AUTH_SECRET）。**未发现生产数据落入 preview 命名空间，也未发现跨环境数据串写**。副作用仅限：限流/锁定计数清零一次（可接受）。

### 1.4 其他

- 令牌本地存储：插件 data.json 明文存 token（与 BYOK Key 同级风险，凭据边界规则允许；磁盘风险=本机访问权，文档化）。
- 403 场景说明：插件无自然 403 触发面（服务端 403 仅 AI-UA 拦截，UA 不可由插件设置）；真机用注入服务器 403 验证（见第三部分 B）。

---

## 第二部分：Git 基线信息

| 项 | 值 |
|---|---|
| 仓库 | `D:\zcode\obsidian导航\home-dashboard`（本次 init，独立 git；master 分支） |
| 提交链 | 0fa5a25（M2 全量+验收工具）→ 6a4af83（干净目录重建支持）→ 8538171（CRLF 归一化）→ 690458e（BASELINE.md）→ 45e3fe0（saveSettings 修复，验收期） |
| 基线标签 | **m2-baseline = 690458e** |
| 产物 SHA256 | `fa875e1c…`（fa875e1c77258a884b3fc2c68642c53f20bd0cc07c93b5d89beccf066a88f3cb，vault=工作区双产物一致）；**可复现性已验证**：干净 clone 重建 SHA ≡ 基线（CRLF 归一化 + .gitattributes eol=lf） |
| 版本清单 | Node v24.14.1（构建）/ 22.22.2 托管（测试）；Obsidian 1.15.0（minAppVersion 1.7.2）；构建工具 = 纯 node 脚本零依赖；codegen = mentora `scripts/gen-plugin-shared.mjs` |
| 安装/回滚 | 见 `BASELINE.md`（构建即安装到 vault；回滚 = checkout tag + rebuild，vault 数据文件不受影响） |
| 唯一可运行版本保护 | 产物 gitignore（可重建），构建失败拒绝写盘（语法自检+双产物 hash 一致断言）；vault 侧 main.js 每次构建原子覆盖 |

验收期新增提交（tag 之后）：513d45b（401 自动清账号）、p3-server/p3-cleanup 验收工具、45e3fe0（saveSettings 修复）——均已过 10/10 门禁。

---

## 第三部分：真实 Obsidian 测试报告

**环境**：真实 Obsidian 1.15.0（用户真实 vault「Obsidian Vault」，2121 篇笔记）；真实腾讯云服务端（D1 通道）；一次性探针账号 m3probe@163.com（现场注册、测试后已自删，复核 401）；驱动方式 = Computer Use（UI 自动化）+ 命令面板 + 服务端/文件系统双侧证据。**无任何 Node 桩替代真机步骤**（单元层测试另计）。

### A. 登录（7/7 通过）

| 场景 | 操作 | 预期 | 实际 | 证据 |
|---|---|---|---|---|
| A0 界面 | 打开插件设置 | 账号区+安全警告渲染 | ✓ 账号区/邮箱/密码/登录/服务端地址齐全 | 截图（橙色 http 警告） |
| A1 错误密码 | UI 输入错误密码→登录 | 401 文案、不落账号 | ✓ 按钮恢复、状态行未登录、data.json account=null | 截图 + 文件核对 + 服务端对照 401 |
| A2 登录成功 | UI 正确凭据→登录 | 200、令牌落盘、UI 已登录 | **首次挂死→发现 saveSettings 缺失（见 6.2）→修复后 ✓** | relay POST 200(4583ms) + data.json mtime 19:17 + account 持久化 + 状态行「已登录」 |
| A3 令牌保存 | 检查 data.json | token/email/expiresAt 完整 | ✓ `d1.566e8…`、year、2027-02-06 | 文件读取 |
| A4 重启恢复 | taskkill+重启 Obsidian | 状态从 data.json 恢复 | ✓ 已登录态完整恢复（token/到期/套餐） | 文件 + 设置页截图 |
| A5 退出登录 | UI 点「退出并吊销本机设备」 | Notice+未登录+服务端吊销 | ✓ Notice「已退出，本机设备令牌已吊销」 | 截图 + data.json null |
| A6 当前设备吊销 | curl DELETE 同一令牌→真机拉取 | 401→自动清账号+引导重登 | ✓ relay GET 401(696ms)→account 自动 null | 服务端日志 + 文件 |
| A7 全部设备吊销 | curl 改密（sv+1 清 devices）→旧密码 401→新密码真机重登 | 全端踢+可用性恢复 | ✓ 改密 200 revokedOtherDevices、旧签发 401、新密码重登 200 落盘 | 服务端 + 文件 |

### B. 请求（6/6 通过 + 1 前置拦截）

| 场景 | 操作 | 预期 | 实际 | 证据 |
|---|---|---|---|---|
| requestUrl 真实请求 | 全部命令 | 真实网络往返 | ✓（relay 日志逐条记录方法/路径/状态/耗时） | 日志 12+ 条 |
| 设备令牌请求头 | 登录后请求 | x-device-token 携带且生效 | ✓（服务端 200 依赖该头；401 对照成立） | relay + 服务端 |
| 401 | 吊销后拉取 | 明确失败+自动清账号 | ✓（A6） | 同 A6 |
| 403 | serverBase=/f403→登录 | 失败文案、不落账号 | ✓ inject 日志 `POST /f403/api/auth/device -> 403` + account 未写入 | 日志 + 文件 |
| 5xx | serverBase=/f500→登录 | 失败文案直通 | ✓ **截图 Notice「登录失败：注入故障 500」** | 截图 |
| 超时 | serverBase=/fslow(35s)→登录 | 30s 软超时明确报错 | ✓ **Notice「登录失败：请求超时（30000ms 无响应）」@28s** | a11y 文本捕获 |
| 认证过期 | （A7 覆盖）改密=全端过期 | 401 | ✓ | 同 A7 |
| 前置拦截 | 未登录点拉取 | 引导登录不发包 | ✓ Notice「未登录——先在设置里登录 Mentora 账号」 | 截图 |

### C. 同步（8/8 通过）

| 场景 | 操作 | 预期 | 实际 | 证据 |
|---|---|---|---|---|
| C1 首次同步 | 登录后拉取（探针空快照） | synced+基线 | ✓ relay GET 200 | relay 日志 |
| C2 远端更新 | curl 推 1 goal→真机拉取 | Notice 显示 goals=1 | ✓ **截图「拉取成功/synced/基线 11:20:39/goals=1」** | 截图（Notice 全文） |
| C3 连续修改 | curl v2(2 goals)→拉取 | 拉到最新 | ✓ GET 200 | relay 日志 |
| C4 快速重复修改 | 连续 3 次 curl 推送→拉取 | 最终态一致、无错误 | ✓ v3a/b/c 全 200 + GET 200 | 日志 |
| C5 插件推送 | 真机「推送本机学习数据」两击确认 | POST+服务端核对 | ✓ relay POST 200(3902ms)；curl GET 确认 updatedAt 推进、goals=1（本机 store 首目标） | 日志 + 服务端 GET |
| C6 断网 | kill relay→推送 | offline+队列落盘 | ✓ 队列文件 1184B（queuedAt + 完整 goals 载荷） | 文件系统 |
| C7 恢复+重放 | 重启 relay→「重放离线队列」 | POST 成功+队列清空 | ✓ relay POST 200(4517ms) + 队列回到 cleared | 日志 + 文件 |
| C8 冲突 | curl 推冲突数据→插件不 pull 直接推 | 远端前进检测→LWW+版本存档 | ✓ head GET 检测→POST 覆盖（LWW）→ versions 7→8（冲突版本可恢复） | 日志 + 服务端 |
| C9 重启恢复 | 多次重启后拉取/推送 | 状态与功能正常 | ✓（4 次重启后均验证） | 日志 |

### D. Vault（3/5 通过，2 项如实申报）

| 场景 | 操作 | 预期 | 实际 | 证据 |
|---|---|---|---|---|
| D1 读取真实 data.json | 打开首页（预览渲染） | 真实数据渲染 | ✓ **截图：真实待办（长期4/短期13）/习惯/2121篇笔记/295标签/W44 焦点文案** | 截图 |
| D2 写入真实数据 | 登录流程触发 saveData | 落盘 | ✓ data.json mtime Oct25→**Nov8 19:17**（两周来首次落盘，正是 saveSettings 修复的验证） | mtime + 内容 |
| D3 写入失败 | 只读文件→UI 触发写 | **未执行**——CUA 平台在多轮重启后持续 surface_replaced，无法继续 UI 驱动；且现有 writeData 为静默失败（审计 P1-5 遗留，M3.2 接 MT_VAULT 显式结果时一并修+测） | ⏳ 申报未执行 | — |
| D4 重复/并发写入 | 验收期间 saveData 触发 10+ 次（多次 serverBase 变更/登录/退出/重启） | 文件始终合法 JSON | ✓ 每次读取均合法、无交叠损坏 | 文件解析 |
| D5 用户已有数据保护 | 坏 store 只读保护 | 不在真实 vault 制造损坏 | ✓ 机制由 30/30 infra 断言+代码审查覆盖（`_saveBlocked` 拒写）；真实 vault 未注入损坏（保护用户数据优先） | 单测 |

### 6.2 真机发现并修复的缺陷（验收直接产出）

1. **【重大·既有】`saveSettings` 被调用 5 处但从未定义**（9e 应用内设置页 / 10-plugin BYOK 与账号区 / 21-infra-auth ×3）：所有插件设置只活在内存——**data.json 自 10-25 起两周未落盘**；登录成功路径 TypeError 挂死按钮（真机抓到「登录中…」6 分钟不恢复）。修复=基类补 `saveSettings(){saveData(this.settings)}`（45e3fe0）+ 真机复测全链路通。**影响面回溯**：应用内设置页的保存自 10 月起就没真正落过盘。
2. **【产品】登录可无限挂起**：Obsidian requestUrl 直连腾讯云超时（`net::ERR_CONNECTION_TIMED_OUT`，仪表盘同款）；且挂起时 30s 软超时在首次实测中未按时触发（渲染器计时器冻结嫌疑）。已落 mtApi 30s 软超时（复测 @28s 生效）；**直连超时根因**列 M3.2 必查（TUN/防火墙/网络栈排查）。
3. **【平台】CUA 自动化在 Obsidian 独立设置窗口反复开合后 surface 引用失稳**——非产品问题，验收方法学记录：重启 Obsidian 可复位。

---

## 第四部分：M3 数据所有权矩阵

| 数据 | 权威来源 | 读取方式 | 写入方式 | 冲突策略 |
|---|---|---|---|---|
| 任务(todos) | **Obsidian Vault** `_home/data.json`（D2 决策：vault 本地） | MT_VAULT read（显式三态） | MT_VAULT 防抖合并写+显式错误 toast；**禁静默** | vault 文件级同步（Obsidian Sync/网盘）；整文件覆盖风险由防抖+失败提示缓解，字段级合并 P1 |
| 习惯(habits) | **Vault** `_home/data.json`（manual+log；推送/周报/训记为派生不落盘） | 同上 | 同上（自动项不写回防膨胀） | 同上 |
| 学习计划(goals) | **Mentora 服务端** data 快照 | MT_SYNC pull（设备令牌）+ 本地投影 | MT_SYNC push（2.5s 防抖+两击确认于调试命令；正式 UI 走服务端规则） | 基线水位（服务端 updatedAt）+ 远端前进 onRemoteAhead 合并 + versions 存档兜底；P0=LWW，实体级 P1 |
| 阅读进度(books) | **服务端**（同 goals 通道） | MT_SYNC pull | MT_SYNC push | 同 goals |
| 项目 | **P0=active Goal 投影**（不新建实体，D2 决策） | 服务端 goals 只读投影 | 无（P0 只读） | 随 goals |
| Markdown | **Obsidian Vault** | 原生读取（不托管） | 用户确认后 MT_WRITE（重名自增） | 文件冲突保护（不覆盖既有笔记） |
| AI 会话(agentSessions) | 服务端（已入 sync FIELDS） | MT_SYNC | MT_SYNC | 同 goals |
| 知识沉淀落盘 | 服务端 knowledge 为源 | MT_BRAIN 索引 | 单向导出、写入需确认 | vault 副本与服务端允许暂时不一致（导出即可） |
| UI 偏好/设备令牌 | 插件 data.json | 内存 | saveSettings（已修复） | 单设备无冲突 |

**明确排除**：不得假定 todos/habits 由 MT_VAULT 之外的通道管理；学习/阅读不得回落 `_home/mentora-store.json` 直改（M4 起该文件仅作迁移源）。

---

## 第五部分：M3 个人工作台实施方案

### 1. 首页组件架构（拼接架构内的分层，编号段即层）

```
05-render.js 拆为（保持数据兼容，迁移期并存）：
  50-feature-home.js      页面骨架：吸顶导航/hero/状态条/卡片容器（细粒度重渲染注册表）
  51-feature-tasks.js     待办卡（读写 23-infra-vault data.json 仓储；显式失败 toast）
  52-feature-habits.js    习惯卡（同上；打卡写 log+防抖）
  53-feature-learning.js  今日学习卡（登录态=MT_SYNC goals 本地投影；未登录=open/plan 后备→引导登录）
  54-feature-projects.js  项目总览（active Goal 投影，只读）
  55-feature-services.js  Mentora 服务入口（学习/阅读/AI/知识 四卡+网页版备用）
  56-feature-statusbar.js 七态同步状态条（连接与数据同步分离）
时区统一：00-core ymd() 收敛到 MT_NOW(settings.mentora.timeZone)（消除四套口径）
```

### 2. 首页信息优先级（自上而下）
① 状态条（同步/账号异常最优先可见）→ ② 今日焦点摘要（问候+统计 chips，真实数据）→ ③ 今日任务（逾期置顶）→ ④ 今日学习（继续学习直达）→ ⑤ 习惯打卡 → ⑥ 项目总览 → ⑦ 服务入口 → ⑧ 快捷入口/文件索引（折叠）。原则：**个人工作台为核心，Mentora 服务深度嵌入**；删除「知识库分析仪表盘」残留定位。

### 3. 任务模块交互
勾选=乐观更新 UI→防抖写→失败 toast+内存保留；快速添加（⚡重要/📅截止保留）；逾期橙齿；排序规则不变（v7）。新增：与今日学习卡联动的「来自 Mentora 的今日任务」分区（只读，点击跳原生学习台）。

### 4. 习惯模块交互
打卡圈点击→乐观+防抖写；热力图/连续/本周统计维持；训记/推送/周报派生项保持只读。

### 5. 今日学习卡设计
登录态：本地投影 goals（active day/gate/review 三类，规则=open/plan route 同款+MT_NOW 时区）→「继续学习」直达原生学习台对应 day；未登录：引导卡（登录按钮直达设置账号区）。数据经 MT_SYNC（登录后自动 pull）。

### 6. 同步状态条设计
七态文案映射：loading 加载中/synced 已同步 HH:mm/pending 待同步/syncing 同步中/offline 离线（队列 N 条）/failed 失败（错误+重试钮）/conflict 冲突（P1）。点击展开：账号/服务端/基线/队列明细。

### 7. 统一设计 Token 方案
Mentora Web globals.css 令牌 → 插件 CSS 变量映射层（--mt-bg/--mt-ink/--mt-accent/--radius/--shadow 两层），Obsidian 暗色主题下读 `--background-modifier-*` 反推暗色档；迁移期与现有 --t-* 并存，逐卡切换。

### 8. 视觉对照方案
G3：同场景并排截图（Web 1440 vs 插件全宽 6 档宽度沿用 measure.js 门禁），每 P0 卡片出 默认/加载/空/错/交互 五态对照表；截图集存 test/shots-m3/。

### 9. 开发拆分（M3.2 起，每步 10/10 门禁+真机抽查）
T1 时区统一+数据层接 MT_VAULT（修 writeData 静默失败）→ T2 状态条+骨架组件化 → T3 任务/习惯卡迁移 → T4 今日学习卡（投影+登录联动）→ T5 项目/服务入口 → T6 视觉 Token+对照 → T7 G2 场景 A/E 全跑+文档。

### 10. 自动化测试清单
- run.js 渲染断言 82 条迁移到新结构（等价改写，数量不减）
- infra 层新增：投影计算（open/plan 同款规则×时区）夹具、状态条七态映射、MT_VAULT 写失败 toast 路径、ymd/MT_NOW 统一断言
- 真机抽查脚本化：test/p3-server.mjs（故障注入+中继）转正式验收工具；debug 四命令保留
- gen 新鲜度+漂移断言沿用

---

## 第六部分：交付报告（六段）

### 1. 实际实现内容
- 安全：mtApi 30s 软超时；登录区 http 明文警告（动态随 serverBase）；401 统一自动清账号+队列保留+引导重登；调试四命令（状态/拉取/推送两击/重放）作为真机验收与后续诊断工具。
- 工程：插件仓 git init + m2-baseline 标签 + BASELINE.md（SHA/版本/安装/回滚）+ 干净目录可复现构建（种子 manifest + CRLF 归一化 + .gitattributes）。
- 真机验收驱动：故障注入+中继服务器（test/p3-server.mjs）、探针账号全生命周期管理（注册→测试→自删）。
- **真机抓出并修复**：基类 `saveSettings` 缺失（重大既有 bug）。

### 2. 修改文件清单
插件仓：08-plugin.js（saveSettings+调试命令+http 警告挂载点）、20-infra-api.js（超时）、22-infra-sync.js（401 处理）、10-plugin.js（账号区警告+调试命令）、test/{infra.js,plugin.js,mtview-preview.js,mtview-shot.js,all.js,p3-server.mjs(新),p3-cleanup 脚本}、BASELINE.md、.gitignore、.gitattributes、plugin-src/manifest.base.json。
mentora 仓：src/lib/server/device-auth.ts 等 M1 补丁已在上轮；本轮新增 scripts/gen-plugin-shared.mjs 相关无改动；CHANGELOG 未动（M3.1 属验收轮）。

### 3. 功能证据
- 十层门禁 10/10（每提交后全跑）；device-auth 单测 30/30。
- 真机 26 个场景：A 7/7、B 6/6+前置拦截、C 8/8、D 3/5（D3 未执行、D5 以单测代真机——均如实申报）；关键截图：登录成功态/已登录恢复/退出 Notice/拉取成功(goals=1)/500 注入文案/超时文案/http 安全警告/真实仪表盘渲染。
- 服务端+文件系统双通道证据贯穿（relay 日志 12+ 条、data.json mtime/内容、队列文件生命周期、versions 7→8）。
- 真机抓出并修复重大既有 bug ×1（saveSettings），复现并定位网络层问题 ×1（直连超时）。

### 4. 验收结果
- A/B/C：**通过**。D：**部分通过**（D3 未执行：CUA 平台阻断；已列入 M3.2 T1）。
- 完成标准核对：安全问题已解决（护栏+评估+DEPLOY_ENV 复核）✓；真实 Obsidian 关键链路通过（登录/请求/同步全链路）✓；工程基线建立 ✓；数据所有权明确 ✓。
- 申报：无模拟冒充真机；无部分标全部；未执行任何生产破坏性操作（探针自删为既有纪律；用户 vault 仅 saveData 正常写入+已恢复配置）。

### 5. 遗留问题
1. **B-1 直连超时根因**：Obsidian requestUrl→腾讯云 `ERR_CONNECTION_TIMED_OUT`（relay 拓扑绕开）；M3.2 必查（TUN/防火墙/Electron 网络栈），未定位前插件直连模式在部分网络不可用。
2. D3 写失败注入未真机执行（M3.2 T1 与 writeData 显式化一并补）。
3. 用户 vault 的显式 `tools.mentora.baseUrl=vercel` 需用户手动清空/改腾讯云（显式配置优先于默认）。
4. 正式使用前置：HTTPS 域名（购域名+Caddy 证书）；HTTP 仅限自测。
5. C.5 推送把用户本机 store 数据写入了探针账号（探针已删，无残留）；正式推送 UI（M3.2/M4）需明确的账号-数据一致性提示。
6. 提交作者邮箱规范化等 git 卫生项沿用现状（本仓 user 已配 haow9508-ctrl）。

### 6. 风险说明
- saveSettings 修复改变了「设置不落盘」的既有行为——用户过往内存态设置（若有未落盘差异）会在下次变更时一次性落盘，属修复预期。
- 401 自动清账号：令牌意外失效时本地账号被清（数据在服务端+队列保留），重登即恢复——已按 PRD 7.1 语义实现。
- 中继拓扑仅用于验收；生产插件仍直连 serverBase。relay 工具（test/p3-server.mjs）保留为验收资产，不进构建产物。
- 本报告基于 2026-11-08 快照；探针账号已删、测试服务器已停、用户配置已恢复（serverBase 空=默认，account 空=未登录——与验收前一致）。

**M3.1 终止。等待 M3.2 批准后开工。**
