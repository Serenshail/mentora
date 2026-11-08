# Mentora Obsidian 插件重构 V2 — 阶段 1 产品与技术方案（冻结稿）

**日期：** 2026-11-08 ｜ **输入：** `docs/AUDIT-PLUGIN-V2-2026-11-08.md`（阶段 0 审计）+ 用户四项决策（D1 按可发布设计 / D2 任务习惯留 vault 本地 / D3 设备令牌鉴权 / D4 构建期代码生成）
**状态：** 待用户批准冻结。批准前不动代码。

---

## 1. 产品信息架构（P0 实现范围）

```text
vault-home v4「Mentora Personal Workspace」
│
├── 01 个人工作台 Home（默认页，重构 05-render）
│   ├── 今日概览（问候/日期/统计 chips）
│   ├── 今日任务 + 长期任务 + 逾期（vault 本地，D2）
│   ├── 今日学习（服务端 goals 只读投影 + 继续学习按钮）
│   ├── 习惯打卡 + 热力图（vault 本地，D2）
│   ├── 项目状态摘要（P0 = active Goal 投影，不新建 Projects 实体）
│   ├── Mentora 服务入口（四卡 → 原生工作空间）
│   └── 连接/同步状态条（七态，见 §5）
│
├── 02 Mentora 工作空间（原生薄客户端，替代 9d/9e 平行实现）
│   ├── 学习教练（goals 服务端数据：总览/天视图/验收/迁移门/结业）
│   ├── 阅读（books 服务端数据 V25 结构：书架/路线/认知地图/工作台/三重验收/沉淀）
│   ├── AI 对话（/api/chat agent 任务：工具卡/审批卡/多会话）
│   └── 知识（第二大脑入口 + 知识沉淀→vault 落盘，保留 MT_WRITE）
│
├── 03 Obsidian 原生层（不重构，保持现状）
│   ├── vault 笔记/搜索/图谱 = Obsidian 原生
│   └── 网页版备用 MentoraView（07-view.js 原样保留，显式命令进入）
│
└── 04 设置（登录 Mentora 账号 / 设备管理 / 服务商与外观 / 导出备份）
```

**删除项**（对照审计 §8）：9a 提示词全套（服务端化）、9c 的 mtChat/store/BM25、9e demo 死分支、admin 数据卡、legacy-migrations、/brain 残留路由。

---

## 2. P0 功能矩阵（PRD P0 表 → 实现方式）

| PRD P0 | 实现方式 | 依赖 |
|---|---|---|
| 工作台五区块 | M3 重构：组件化卡片，任务/习惯读 vault 仓储，学习读服务端 | M2 |
| 登录与账号连接 | M2：设置页登录表单 → POST /api/auth/device → 令牌存插件设置（password 字段） | M1 |
| 正式服务入口 | 四卡导航进原生工作空间；「在浏览器打开完整版」= MentoraView 备用 | M2 |
| 核心 AI 对话 | M4：/api/chat（task=agent）薄客户端，NDJSON 流渲染，工具卡/审批卡只读展示+确认回传 | M1 |
| 阅读核心流程 | M4：books 服务端数据 V25 结构薄客户端（书架/路线/工作台/验收/沉淀） | M1 |
| 学习核心流程 | M4：goals 服务端数据薄客户端（复用 9d UI 交互骨架，数据层全部换服务端） | M1 |
| 账号身份与权限 | M1 设备令牌体系 | M1 |
| 任务/学习/阅读同步 | 学习+阅读=/api/sync 薄客户端；任务/习惯=vault 本地（D2） | M1/M2 |
| 加载/错误/保存状态 | 七态状态机（§5）+ 现有 busy 卡/确认卡模式 | M2 |
| 本地笔记入口/工作区/主题适配 | 保留现有 + M5 Token 映射与暗色适配 | M5 |

**PRD 口径修订（随 D2 生效，明示备案）**：场景 B 步骤 5「在 Web 端查看任务」→ 修订为「在另一台装插件的 Obsidian 经 vault 同步查看」；学习/阅读/AI 会话的跨端验证（场景 C/D）仍走服务端，不受影响。

---

## 3. 鉴权方案（D3 设备令牌）

**新增端点**（M1，服务端唯一大改）：
- `POST /api/auth/device` `{email, password, deviceName?}` → 校验复用 login 的 scrypt + 账号锁 + IP 桶 → 签发 `token = base64url(32B 随机)` → 档案 `users/<uid>.json` 增加 `devices: [{id, name, sha256(token), createdAt, lastUsedAt}]`（上限 10 台，超出挤最旧）→ 响应 `{token, user{userId,email,name,plan...}, expiresAt(90天)}`。
- 请求鉴权 helper `verifyAnyAuth(req)`：session cookie（verifySession 原逻辑）→ 否则 `x-device-token` 头 sha256 比对 devices[] 且未过期。P0 接线面：`/api/sync`、`/api/chat`、`/api/memory`、`/api/reminders`。
- 吊销：改密/重置（sv+1）时清空 devices[]（全端踢）；登录失败计入既有 loginfail 机制。
- 插件侧：令牌存插件设置 password 字段（凭据边界沿 README 规则，不写 vault 内容文件）；401 → 清令牌 + 引导重登。

**安全收敛**（审计 R10）：仪表盘 admin 数据卡移除，插件不再持有 x-admin-password；open/plan 卡在 M3 被服务端登录态投影替代后一并下线。

---

## 4. 数据所有权矩阵（终版，依 D2）

| 数据 | 权威来源 | 插件职责 | 同步通道 |
|---|---|---|---|
| 账号/学习(goals)/阅读(books)/第二大脑(knowledge)/圆桌(sessions/personas) | 服务端 data 快照 | 读写 | /api/sync（x-device-token） |
| AI 会话（agentSessions） | 服务端 | 读写 | **M1 加入 sync FIELDS**（顺带修 Web C2 债，Web 端需回归多标签场景） |
| 长期记忆/定时提醒 | 服务端 KV | AI 工具调用展示 | /api/memory、/api/reminders |
| 任务(todos)/习惯打卡/快捷入口/仪表盘布局 | **vault `_home/data.json`**（D2） | 读写 | vault 文件同步（Obsidian Sync/网盘） |
| 原生 Markdown | vault | 读/按确认写入 | vault |
| 知识沉淀落盘 | vault 副本（服务端 knowledge 为源） | 单向导出，写入需确认 | MT_WRITE 保留 |
| UI 偏好/设备令牌 | 插件 data.json | 本地 | — |

---

## 5. 同步技术方案（P0）

**插件 Sync 客户端**（M2 新建 22-infra-sync.js）：
1. 启动/视图打开 → GET /api/sync → 水合进内存 store（字段对齐 Web persist v8 的云同步子集）。
2. 写操作本地先行（乐观更新 UI）→ 2.5s 防抖 POST 全量（与 Web 同协议）→ 失败进入持久化重试队列（vault 缓存文件，防插件重载丢失）。
3. **基线校验降覆盖窗**：POST 响应返回服务端 `{updatedAt}`（M1 小改）；下次 POST 前若 GET 到的服务端 updatedAt ≠ 本地记录基线 → 先拉取合并再推（将 Web 端「3s 水位 + 两条红线」规则在插件端等价实现）。实体级版本控制列 P1。
4. **七态状态机**（PRD 5.3 全集）：loading / synced / pending / syncing / offline / failed / conflict，首页状态条逐字展示；连接状态与数据同步状态分离。
5. 离线：已加载内容可看可标（本地先行入队），AI 调用明确提示需联网；网络恢复自动重放队列。
6. 时区统一：全部「今天」判定收敛到单一 `MT_NOW(tz)`（9a 已有，提为 00-core 唯一实现），默认 Asia/Shanghai 与服务端 MENTORA_OPEN_TZ 对齐——消除审计 P1-7 的四套口径。

---

## 6. 目标目录结构（拼接架构内的分层，依 D4-B）

新代码用新编号段，旧文件迁移完成前并存（构建顺序即依赖顺序，层间禁越级引用写进 README 门禁）：

```text
plugin-src/
├── 00-core.js … 09-settings.js, 10-plugin.js     # host 层（保留；00 收编唯一 ymd/MT_NOW）
├── 07-view.js / 1-dashboard.css / 9f-mentora.css # webview 备用 + 样式（M5 重做样式）
├── 20-infra-api.js      # M2：fetch 封装/NDJSON 流解析/超时重试
├── 21-infra-auth.js     # M2：设备令牌登录/存储/401 处理
├── 22-infra-sync.js     # M2：sync 客户端/七态/离线队列/基线校验
├── 23-infra-vault.js    # M2：data.json 仓储（显式错误/原子写/防抖合并）
├── 30-gen-*.js          # M2：codegen 产物（见 §7）
├── 40-app-*.js          # M3/M4：view-model / 用例编排
├── 50-feature-home.js   # M3：仪表盘组件化（替代 05-render 主体）
├── 51-feature-tasks.js  # M3：任务/习惯卡（vault 仓储）
├── 52-feature-learning.js # M4：教练薄客户端（替代 9d）
├── 53-feature-reading.js  # M4：阅读薄客户端（替代 9e 读书半）
├── 54-feature-ai.js       # M4：AI 对话工作空间（替代 mtChat 路径）
├── 55-feature-knowledge.js# M4：知识入口/沉淀（基于 MT_BRAIN 保留件）
└── 9x（迁移期保留，功能切换后删除）
```

---

## 7. 代码生成管线（D4-B，范围因提示词服务端化而缩小）

生成器 `mentora/scripts/gen-plugin-shared.mjs` → 产出写插件仓 `plugin-src/30-gen-*.js`（产物提交入库，CI 校验新鲜度，沿 BUILD-HASH 思路）：

| 产物 | 源 | 内容 |
|---|---|---|
| 30-gen-json.js | ai/client.ts extractJson | JSON 提取纯函数（两端同算法） |
| 31-gen-mastery.js | mastery.ts + types | 判分 verdict 枚举/掌握状态机规则/FSRS 参数 |
| 32-gen-seats.js | persona-meta.ts | 16 席位展示元数据（名字/简介/颜色，**不含 system**） |
| 33-gen-schema.js | types.ts | Goal/DayPlan/Chapter/KnowledgeItem/Book 字段形状（JSDoc） |

**提示词不在生成清单内**——原生 AI 走 /api/chat 后由服务端 buildSystem 组装，插件只发 `task + args`（IP 保护同时受益）。旧 9a/9b 在 M4 切换完成后删除。

---

## 8. 模块依赖图

```text
10-plugin(host) → 40-app → 50-55 features → 20-23 infra → [Mentora API | Vault]
                                  ↓
                             30-gen(domain 纯函数，无 IO)
features 禁止直接 fetch / 直接 vault.modify；UI 层禁含业务规则；gen 层禁含 IO 与宿主依赖。
```

---

## 9. 开发拆分计划（阶段 2-6 落地为 M1-M6，每模块按 PRD 10.2 六段交付）

| 里程碑 | 内容 | 门禁 |
|---|---|---|
| **M1 服务端最小集**（1-2 天） | /api/auth/device + verifyAnyAuth 接线（sync/chat/memory/reminders）+ agentSessions 入 FIELDS + sync 响应带 updatedAt | 四门禁绿 + Web/小程序回归不破 + device-auth 单测/e2e + tag 锚点双环境部署 |
| **M2 插件底座**（2-3 天） | codegen 管线 + infra 四件 + 登录 UI + 七态状态机 | 八层测试扩展 + build --check + 凭据扫描 + gen 新鲜度校验 |
| **M3 个人工作台**（2-3 天） | 首页组件化 + 任务/习惯接仓储 + 学习卡接服务端 + 状态条 + 时区统一 | G2 场景 A/E 预演 + 渲染 82 断言迁移 |
| **M4 Mentora 工作空间**（3-5 天） | 学习/阅读/AI 对话/知识四视图薄客户端，逐模块切换即测真数据 | G2 场景 B/C/D + 每模块真实 API 证据 |
| **M5 视觉打磨**（1-2 天） | Token 映射层 + Obsidian 双主题 + 宽度/工作区适配 | G3 同场景截图对照（补 U1 截图集先行） |
| **M6 验收交付**（1-2 天） | G2 A-F 全跑 + G4 稳定性（重载/断网/快速点击/主题切换/长期运行）+ 九件交付文档 | PRD 8.5 十项指标 |

依赖链：U1 截图集与 U2 凭据清理须在 M5 / M1 前分别完成。并发会话纪律：提交前对齐 origin/master、只 add 自己文件。

---

## 10. 与 PRD 的偏差声明（需随本方案一并确认）

1. 场景 B/E 的「其他端」口径修订（§2，D2 后果）。
2. 「项目状态摘要」P0 以 Goal 投影代替独立 Projects 实体（两端现状均无 Projects，PRD P2 前不新建）。
3. PRD 5.4 实体级冲突控制：P0 只做快照基线校验 + 等价水位规则，实体级版本控制列 P1（与 Web 端共同演进，单改插件无意义）。
4. agentSessions 入云同步会改变 Web 端行为（多标签回采风险，AUDIT-V26.1 C3）——M1 需带 Web 回归。

**批准本方案 = 冻结范围，进入 M1。**
