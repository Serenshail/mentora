# Mentora Obsidian 插件重构 PRD V2.0 — 阶段 0 现状审计报告

**日期：** 2026-11-08
**审计对象：**
- 插件：`D:\zcode\obsidian导航\home-dashboard\`（vault-home v3.1.0，plugin-src 21 文件 8273 行 + test 八层门禁）
- Web/服务端：`D:\zcode\agent\mentora`（V26.2，master=363a01e + tag v26.2.0；Vercel + 腾讯云双环境）
**方法：** 双路只读深度勘察（插件侧 / Web 侧各一独立审计）→ 承重结论逐条 grep 复核（sync FIELDS、Web 端无 todos/habits 实体、open/plan 只读、插件本地 store 路径——全部命中）
**对应 PRD：** 《Mentora Obsidian 插件重构 PRD V2.0》（用户 2026-11-08 提供）
**结论速览：** G1 门禁 **有条件通过** —— 7/8 审计项完成；UI 截图采集待登录态；§10 四项决策待用户确认后才能进入阶段 1（方案冻结）。本报告只读，未改任何代码。

---

## 1. 当前整体架构（两端真实关系）

```text
┌─────────────────────────── Obsidian 插件 vault-home v3.1 ───────────────────────────┐
│                                                                                      │
│  A. 仪表盘（首页.md 代码块渲染，05-render.js 908 行）                                 │
│     ├─ 待办/习惯打卡/快捷入口 ──→ vault _home/data.json（整文件读写，写失败静默）      │
│     ├─ 今日学习卡 ──→ GET /api/open/plan（x-open-token，只读投影，点击仅跳转网页版）    │
│     ├─ 运营数据卡 ──→ GET /api/admin/overview（x-admin-password！个人仪表盘挂管理凭据）│
│     └─ 天气/训记 ──→ open-meteo / 训记 API（只读回填）                                │
│                                                                                      │
│  B. 原生学习台（9a–9g，4398 行）——⚠️ 与服务端零同步的平行实现                          │
│     ├─ 全部学习状态 ──→ vault _home/mentora-store.json（version 2，本地）             │
│     ├─ AI 调用 ──→ mtChat 直连六服务商（BYOK，Key 存插件 data.json）                   │
│     ├─ 提示词/判分/FSRS/extractJson/五模式 ──→ 从 web 端复制粘贴的旧版（已漂移）        │
│     └─ 产物落盘 ──→ Mentora/ 笔记（vault 真文件，创建即落盘 ✓）                        │
│                                                                                      │
│  C. 内嵌网页版 MentoraView（07-view.js，Electron webview persist 分区）               │
│     └─ 真实登录态、完整产品、可写服务端 —— 但这是"网页塞进 Obsidian"                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                    ┌───────────────────▼────────────────────┐
                    │  Mentora 服务端（V26.2）                │
                    │  /api/open/plan  ← 共享单用户 token 只读 │
                    │  /api/admin/*    ← 密码门（插件在用）    │
                    │  /api/sync       ← session cookie 整快照 │
                    │  /api/chat       ← 生产强制登录 + 31 task │
                    │  data/<uid>.json 加密快照 + 10 份 versions│
                    └─────────────────────────────────────────┘
```

**一句话诊断：** 插件现有三条 Mentora 通道互不相通——① 只读 token 投影（无身份）、② 本地平行实现（无服务端）、③ webview 整页（非原生）。PRD V2.0 要求的「原生工作台 + 服务端为权威数据源 + 真实登录」三条都不满足，这正是重构的核心。

---

## 2. 插件源码审计（G1-1）

### 2.1 文件清单（plugin-src，21 文件 8273 行；纯 JS ≈7918）

| 文件 | 行数 | 职责 |
|---|---|---|
| 00-core.js | 135 | 常量/日期工具/图标表/色板（本机时区 ymd） |
| 01-tools.js | 230 | 工具框架（TTL 缓存）+ 天气/训记/Mentora 三工具 |
| 02-xunji.js | 76 | 训记返回双形状宽容解析 |
| 03-data.js | 133 | `_home/data.json` 读写 + 全库 facts 扫描 + 习惯日志 |
| 04-widgets.js | 83 | panel/gear/seg 渲染小件 |
| 05-render.js | 908 | 仪表盘主渲染（renderDashboard 单函数 ≈860 行） |
| 06-dom.js | 37 | CSS 注入（版本命名热替换）+ 全宽标记 |
| 07-view.js | 237 | MentoraView：Electron webview 内嵌网页版 |
| 08-plugin.js | 213 | 基类：生命周期/命令/Ribbon/5 分钟定时/迁移 |
| 09-settings.js | 112 | Obsidian 设置页 |
| 1-dashboard.css | 798 | 仪表盘样式 v7（自建 --t-* 令牌，固定浅色） |
| 9a-mentora-prompts.js | 867 | 全套提示词 + MT_NOW 时区日界 |
| 9b-mentora-seats.js | 285 | 12 人物 + 4 认知工具席 system（逐字复制 prompts） |
| 9c-mentora-runtime.js | 836 | 运行时：providers/mtChat 流式/extractJson/BM25/store/FSRS/掌握状态机/MT_UI/MT_WRITE |
| 9d-mentora-coach.js | 1079 | 学习教练全流程 UI（coachDay 单函数 ≈370 行） |
| 9e-mentora-modules.js | 897 | 读书伙伴 + 人生伙伴 + 应用内设置 |
| 9f-mentora.css | 595 | 学习台样式（#mt-app-root ID 特异性隔离，固定浅色） |
| 9g-mentora-pages.js | 108 | 学习人生页（事件流/里程碑/连续天数） |
| 10-plugin.js | 289 | V3 子类 + MentoraAppView + SettingTab + 大导出面 |
| build.js | 194 | 按序拼接 + 占位注入 + 双产物 hash 一致断言 + --check |
| legacy-migrations/ | 868 | 已执行完的一次性脚本（归档，应删） |

### 2.2 架构要点

- **无模块系统**：build.js 按数组顺序拼接，全局函数跨文件互引；CSS/FSRS 靠构建期字符串占位注入。
- **生命周期**：基类 onload（08）→ V3 子类叠加 mentora 配置与视图注册（10）；命令 8 个、Ribbon 2 个、5 分钟定时清缓存重渲染、`home-dashboard` 代码块处理器、vault modify 监听防抖重渲染。
- **主题适配 = 不适配**：两套 CSS 均为自建固定浅色设计系统（.vh-root / #mt-app-root 各一套令牌），不读 Obsidian `--background/--text-*`，无 dark 适配（grep 无 theme-dark/prefers-color）。**与 PRD 6.2「统一设计 Token」直接冲突。**

### 2.3 Mentora 集成现状（对应 PRD 问题二）

| PRD 检查项 | 现状 |
|---|---|
| 登录与身份认证 | **原生侧无登录**。webview 有真实登录（persist 分区只登一次），但那是网页自身 |
| API 调用与数据加载 | 仅两个只读 GET（open/plan、admin/overview），TTL 缓存 5 分钟 |
| 页面跳转和组件复用 | mentora: 链接全部导向 webview 网页版；原生台与网页版是两套 UI 两套数据 |
| AI 服务调用 | 原生 = BYOK 直连服务商（**绕过正式服务端**，PRD 7.1 冲突）；网页 = 正式通道 |
| 阅读与学习业务 | 原生 = **旧版平行实现**（详见 §5 映射矩阵），已与 Web V25/V26 漂移 |
| 数据保存与同步 | 原生 = 纯本地 vault 文件；网页 = 产品自身同步 |
| 加载/异常/错误恢复 | 原生台较好（state 枚举六态 + busy 秒数 + 写失败 toast + 坏 store 拒绝覆盖）；仪表盘 writeData **静默吞写失败**（03-data.js:112-116） |

---

## 3. Web/服务端审计（G1-2/3/4）

### 3.1 页面路由（15 条）与信息架构

`/`=智能体（AgentHome 全屏对话）· `/learn`（教练+read+life 三 tab，[id] 详情 2057 行）· `/learn/new`（引导）· `/council`（人生伙伴）· `/read/[id]`（阅读系统 V1.0 三栏工作台 2043 行）· `/brain`（第二大脑）· `/settings` · `/membership` · `/login` · `/admin` · `/privacy` · `/terms`；`/life`、`/read` 为重定向壳。
侧栏 NAV（app-shell.tsx:45-50）：Mentora / 学习人生 / 学习 / 人生伙伴（+设置、管理员 /admin）。

### 3.2 API 清单（35 route.ts）

- **`/api/open/plan`**（插件唯一业务入口）：`x-open-token` 共享单凭据 ↔ env `MENTORA_OPEN_TOKEN`，绑定 `MENTORA_OPEN_USER_ID/EMAIL` **单用户**，30/min，**只读**窄投影（day/gate/review 三类任务 + counts），`MENTORA_OPEN_TZ` 修日界。**绝无写路径**（route.ts:16）。
- **核心**：`/api/sync`（GET+POST，session，整快照覆盖+10 份 versions 归档，4.2MB 闸）、`/api/chat`（31 task，NDJSON 流 p/d/h/tc/n/e/end 六事件，生产强制登录，FREE 月度 token 预算→日配额→BYOK 三级闸）、`/api/tasks`（任务运行状态 KV）、`/api/memory`+`/api/reminders`（服务端 KV 长期记忆/定时提醒）、`/api/search`+`/api/fetch-page`（联网，SSRF 守卫）、`/api/linkcheck`（公开）、`/api/track`、`/api/feedback`、`/api/trial-request`、`/api/referral`、`/api/health`。
- **auth 8 个**：注册（激活码一人一码+邀请奖励）/登录（账号级防爆破）/logout/me/profile/改密（sv+1 吊销全端）/重置（管理员发一次性码）/注销（级联删）。
- **admin 8 个**：白名单会话 OR `x-admin-password`（timing-safe）——**插件仪表盘在用此通道**。
- **cron 3 个**：tick（分钟级提醒）/weekly-digest/expiry-reminder。

### 3.3 数据模型（zustand persist v8）

- **云同步集合（sync FIELDS，sync/route.ts:11）**：`goals, knowledge, books, sessions, customPersonas, settings(去 apiKey)`。
- **仅本地**：`agentChat/agentSessions`（主对话历史，换设备即丢——AUDIT-V26.1 C2 已知债）、`folders`。
- **Web 端不存在 todos/习惯实体**（types.ts grep 零命中）——PRD 5.1 中「任务/习惯」的权威来源问题，服务端目前**没有承载物**。
- 实体级并发控制：仅 KnowledgeItem 有 version/updatedAt；**Goal/Book 均无**。
- 服务端存储：`data/<userId>.json` AES-256-GCM+gzip 加密快照，D1/Redis/GitHub 多通道，last-write-wins。

### 3.4 设计系统（UI 审计的 Token 部分）

- globals.css `@theme inline`：bg #f5f5f7 / surface #fff / border 发丝线 rgba(0,0,0,.07) / 墨色阶 ink #1d1d1f·ink-dim·ink-3·faint / accent #5b54e6 / 语义 ok·warn·bad；圆角 18px 档；两层阴影 card/panel/lift/overlay；动效 --ease-spring / --ease-out-quart；`.glass-chrome`（saturate180+blur20，仅侧栏/弹层）；移动几何契约变量；reduced-motion/transparency/contrast 三重退化；时段主题 data-period。
- ui.tsx 组件：Button(5 variant×3 size+loading)/Card/Badge(6 tone)/Input/Textarea/PageHeader/ProgressRing/Empty/Modal(焦点陷阱+bottom sheet)/StatusDot/Skeleton + AgentTrace（独立文件）。

> ⚠️ UI 审计的**截图采集未完成**（G1 要求正式产品各状态截图）：需要登录态浏览器，待补（见 §10-U1）。Token 层面已齐。

---

## 4. 同步审计（G1-6，PRD 第五章对照）

| PRD 要求 | Web 现状 | 插件现状 |
|---|---|---|
| 统一 Sync Manager | auth-client.ts 四链路（bootSync/syncAfterLogin/useAutoPush 2.5s 防抖/useFlushOnHide keepalive）+ pushCloud 串行锁 | 无（工具 TTL 拉取 + 本地文件直写） |
| 增量更新 | **无**（整快照 POST） | 无 |
| 冲突处理 | **时间戳水位 + 静默覆盖**（云端新 3s 即整体覆盖本地，无提示 UI）；仅两条红线（拉取窗口本地改动反推、空快照无覆盖权） | 无（vault 文件靠 Obsidian Sync 文件级合并，data.json 整文件互相覆盖） |
| 版本/ETag | versions 快照 10 份（人工恢复用，非并发控制） | 无 |
| 离线 | 无明确离线态 UI | 原生台天然离线（纯本地）✓ 但无队列 |
| 状态可见 | 连接状态条与数据同步**部分分离** | 工具三态圆点 + store 错误黄条 ✓ |
| 服务端实时能力 | 无 SSE/WS 推送（轮询 /api/health build 探测新版） | 同左 |

**结论：** 服务端现状是「整快照 LWW」，无按实体版本控制。PRD 5.4 的冲突要求（识别→检查版本→按规则处理→必要时提示）在 Web 端也未达标——这是**两端共同的基建缺口**，插件重构若只改插件侧无法满足 PRD。

---

## 5. 功能映射矩阵（PRD §3.2 的 14 项 × Web/插件）

| # | 能力 | Web（V26.2） | 插件原生（v3.1） | 差距定性 |
|---|---|---|---|---|
| 1 | 登录和身份认证 | ✓ 激活码+会话+sv 吊销 | ✗（open-token 单用户共享凭据） | **P0 缺口** |
| 2 | AI 对话 | ✓ 31 task + 23 工具循环 + 记忆/提醒 | △ BYOK 直连旧提示词，无工具循环/无记忆 | **P0 缺口** |
| 3 | 学习教练 | ✓ 计划任务化/阶段重排/迁移门/结业 | △ 旧版平行实现（PLANNER 单级旧版、无 planHistory/任务化） | **需重写为服务端客户端** |
| 4 | 阅读伙伴 | ✓ 阅读系统 V1.0 | △ 旧版单元制 | 同上 |
| 5 | 阅读工作空间 | ✓ read/[id] 三栏 | ✗ 简化单元列表 | 缺 |
| 6 | 认知地图 | ✓ map 四区域+图谱 | ✗ | 缺 |
| 7 | 阅读路线 | ✓ 节点状态机 | ✗ | 缺 |
| 8 | Explain/Connect/Apply | ✓ v25 加权出题+证据化判分 | △ 旧三重验收（举例/迁移/贴合 30/30/40 老口径） | **口径已漂移** |
| 9 | 知识沉淀 | ✓ deposits→第二大脑 | ✓✓ MT_WRITE 落 vault 真笔记（**插件独有优势，保留**） | 插件侧更强 |
| 10 | 数据保存和跨端同步 | ✓（快照 LWW） | ✗ 纯本地 | **P0 缺口** |
| 11 | 加载状态 | ✓ AgentTrace/骨架 | ✓ busy 卡+秒数 | 基本达标 |
| 12 | 错误状态 | ✓ 全局边界+toast | ✓ 六态枚举+坏 store 保护 | 基本达标（writeData 静默失败除外） |
| 13 | 空状态 | ✓ | ✓ 三步欢迎 | 达标 |
| 14 | 用户设置 | ✓ | ✓（含导出/导入/清空） | 达标 |

**漂移实证（为什么平行实现不可继续）**：插件 PLANNER_PHASE 仍是单级旧版（Web 已拆 phase-list/phase-detail 两级）、ASK_COACH 缺 ragCtx、无 V25 节点路线/认知地图、无 V26 任务化与书籍核查——每次 Web 迭代插件都在落后，且无机制收敛。

---

## 6. PRD P0 需求差距分析（G1 通过条件核对）

| PRD P0 项 | 实现依据状态 |
|---|---|
| 工作台：今日概览/任务/学习/习惯/项目摘要 | 插件已有骨架（05-render/9g）；**项目（Projects）模块两端都无实体**——P0 里「项目状态摘要」无数据来源，需定义（可先由 Goal 投影或降级）→ §10-D2 |
| Mentora：登录与账号连接 | **缺口**。需新增插件↔服务端鉴权（§10-D3） |
| Mentora：正式服务入口 | webview 通道已可用（保留为显式备用 ✓ 现设计如此）；原生服务入口需重做 |
| Mentora：核心 AI 对话 | 缺口：原生需接 /api/chat（生产强制登录）→ 依赖 D3；无工具循环/记忆 |
| Mentora：阅读核心流程 | 缺口：旧口径重写，接 Web V25 数据结构（books 云同步集合已含全部新字段） |
| Mentora：学习核心流程 | 缺口：接 Web V26 数据结构（goals 云同步集合已含 planHistory/迁移门等） |
| 数据：账号身份与权限 | 依赖 D3 |
| 数据：任务/学习/阅读同步 | 学习+阅读：goals/books 已在 sync FIELDS ✓（复用 /api/sync 可行）；**任务（todos）：服务端无实体** → §10-D2 |
| 数据：加载/错误/保存状态 | 插件骨架已有，需统一到 PRD 5.3 七态 |
| Obsidian：本地笔记入口/工作区适配/主题 | 已有（MT_WRITE/markFullWidth）；主题适配需重做（读 Obsidian 变量+Mentora Token 映射） |

**硬结论：** P0 全部有实现路径，但 **5 项依赖服务端新增工作**（鉴权通道、todos 归属、可能的实体级版本控制）；「纯插件侧重构」无法达成 P0。

---

## 7. 问题清单与技术债（G1-7，按风险分级）

**P0（阻塞重构目标）**
1. 原生学习台 = 无服务端平行实现，业务规则已与 Web 漂移（§5 实证）——PRD 4.4 第 4/5 条禁令的现状违反本体。
2. 插件无用户身份：open-token 共享单凭据 + admin-password 挂在个人仪表盘（多用户产品下不可发布，凭据一旦泄漏=管理权限）。
3. BYOK 直连绕过正式服务端（配额/计费/审查全失效），与 PRD 7.1 冲突。
4. 整快照 LWW 同步 + 无实体版本：跨端写（PRD 场景 B/E）会静默覆盖，两端都未达标。

**P1（重构中必须修）**
5. 仪表盘 writeData 静默吞写失败（03-data.js:112-116）——用户以为存了其实没存。
6. 提示词/算法双份维护已漂移（PLANNER/ASK_COACH/三重验收），无共享机制；插件是拼接 JS 无 npm/TS 链，共享包需构建链决策（§10-D4）。
7. 「今天」两套口径：仪表盘 ymd 本机时区 vs 学习台 MT_NOW(IANA) vs 服务端 UTC 日界 vs open/plan MENTORA_OPEN_TZ——跨端「今日任务」必然踩坑（PRD 场景 B/E 风险点）。
8. agentSessions 不云同步（AUDIT-V26.1 C2）：PRD 场景 C「其他端验证会话数据」在 Web 端自身都不成立。
9. 时钟 interval 卸载不清理（05-render.js:218-225 挂 defaultView）；collectVaultFacts 每次渲染全库扫描 + mtWikiRetrieve 最多读 400 篇全文无缓存（大库性能）。

**P2（择机）**
10. 死代码/残留：legacy-migrations 868 行、demo provider 死分支（9e:757）、/brain 路由白名单与 data.json 残留引用、双 toast/双图标表/四份 streak 口径互异。
11. mtSeedSampleGoal 打包假数据（用户点击才注入，但 PRD 禁假数据，建议改为按需生成）。
12. 天气默认坐标写死郑州；插件 baseUrl 默认 vercel.app（**大陆无代理不可达**，而腾讯云 http://192.144.181.171 可达——默认值需改或做可达性探测）。
13. 凭据债（沿 PLUGIN-EXECUTION §7）：Vercel 远端 MENTORA_OPEN_TOKEN/ADMIN_PASSWORD 轮换未确认；tokenrhythm 模型 Key 待用户控制台撤销。
14. 测试债：run.js/xunji.js/measure.js 依赖本机 vault 与 Chromium 路径不可移植；test/all.js 头注释「七层」与 README「八层」均过期（实为 9 步 265 断言）。
15. 插件零行为埋点（PLUGIN-EXECUTION §7-6）。

---

## 8. 复用性审计（G1-8）

**直接保留（高价值、兼容目标架构）**
- 07-view.js MentoraView webview 封装（persist 分区/诊断页/路由白名单——踩坑成果，PRD「显式网页备用」正好用它）
- 02-xunji.js 解析、00-core 纯函数、03-data 的 collectVaultFacts/buildHabitLog（改造为 vault 仓储实现）
- 9c 的 mtExtractJson/mtNormVerdict/mtHeuristicVerify/FSRS 包装（算法正确，但**必须改为单一真源**，见 D4）
- 9a/9b 提示词与席位资产（作为数据资源从共享真源生成）
- MT_WRITE 落盘 vault 笔记、坏 store 只读保护、build.js hash 一致断言思路、测试 stub 手法
- 9d/9e 的 UI 交互骨架（busy 卡/状态枚举/确认卡模式）可迁移到新组件层

**必须重写**
- 数据层：data.json 整文件直改 → 按实体仓储 + 显式错误 + 冲突策略；mentora-store 本地平行实现 → 服务端 API 客户端 + 本地缓存/离线队列
- 9c mtChat BYOK 直连 → 服务端 /api/chat 客户端（鉴权按 D3）
- 05-render 全局重渲染 → 卡片组件化细粒度更新
- CSS：两套自建令牌 → Mentora Token 映射层 + Obsidian 变量适配（暗色）

**应删除**
- legacy-migrations/（868 行已执行完）、demo 死分支、/brain 残留、重复 toast/图标/streak 三份、__internals/__mentora 大导出面、migrateToolCfgFromDataFile（一个版本周期后）

---

## 9. 重构风险清单（阶段 0 交付 7）

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | /api/sync 是整快照 LWW，插件接入写路径后与 Web/小程序三方并发写，静默覆盖概率上升 | 高 | 先做实体 updatedAt 水位（服务端小改），插件写前必须拉取合并；冲突提示 UI |
| R2 | 服务端改动（鉴权/todos/版本控制）动到 sync 契约，影响 Web+小程序两端 | 高 | 契约向后兼容设计 + 三端回归脚本（smoke 体系已有 32 个脚本可扩） |
| R3 | /api/chat 生产强制登录：插件原生 AI 必须先解决 D3，否则 P0 的 AI 能力只能继续 BYOK（违反 PRD） | 高 | D3 是第一优先级前置 |
| R4 | 插件构建链若引入 esbuild+TS 共享包，现有「拼接+占位」构建与八层测试全部要改 | 中 | 先评估 D4；短期可用「构建期从 web 源生成插件常量」的代码生成方案过渡 |
| R5 | 插件轮询/TTL + Web 自动推送 → D1/Redis 限流与配额压力（chat 30/0.5rps、sync 60/1rps） | 中 | 插件侧请求合并 + 退避；开/plan 已有 30/min 上限 |
| R6 | versions 快照仅 10 份，插件高频写会加速滚动覆盖用户可恢复点 | 中 | KEEP_VERSIONS 与写频评估；插件写走合并而非整覆盖 |
| R7 | 重构期间 9d/9e 巨型文件与仪表盘并存，双 UI 双数据窗口期用户困惑 | 中 | 按阶段切换 + 功能开关；旧数据迁移脚本 + 只读保护沿用 |
| R8 | 大陆可达性：默认 baseUrl vercel.app 不可达导致「连不上」误判 | 中 | 默认腾讯云端点或端点探测（§7-12） |
| R9 | UI 截图未采集即开发 → 视觉验收（G3）返工 | 中 | 阶段 1 前补齐截图集（含加载/空/错三态） |
| R10 | 凭据泄漏面：admin-password 在插件 data.json（明文落 vault 插件目录） | 高(安全) | 重构后原生侧不再持有 admin 凭据（数据卡移除或改用户级 API） |

---

## 10. 待用户决策事项（PRD G1：未知事项必须记录）

- **D1（多用户 vs 个人专属）**：open/plan 当前绑定单用户。插件若仅自用，可维持简化鉴权；若随产品发布给用户，必须做每用户鉴权（设备令牌）。**推荐：按可发布产品设计（每用户），但 P0 先实现自用账号跑通。**
- **D2（任务/习惯/项目的数据归属）**：Web 端无 todos/habits/projects 实体。选项 A：新增服务端实体进 sync 快照（跨端场景 B/E 可达，需服务端+冲突策略）；B：维持 vault 本地权威（不跨端，PRD 场景 B「Web 端查看任务」不达标）；C：任务进服务端、习惯留 vault。**推荐 A（任务+习惯均进快照，项目暂以 Goal 投影，P0 不新建 Projects 实体）。**
- **D3（插件鉴权方案）**：选项 A：登录换长期设备令牌（新增 /api/auth/device 端点，插件存 data.json，x-device-token 头）；B：webview 登录 + cookie 桥接（脆弱，requestUrl 无 cookie jar）；C：沿用共享 token（不可发布，违反 PRD 7.1）。**推荐 A，复用现有密码与 sv 吊销体系。**
- **D4（共享代码机制）**：选项 A：引入 esbuild+TS，建 packages/shared（提示词/extractJson/判分/FSRS/类型）双端引用——一劳永逸但构建链重做；B：构建期代码生成（web 源 → 插件常量文件），保持拼接架构——低风险但仍是两份产物；C：维持手工同步+对齐测试——继续漂移。**推荐 B 起步（P0 够用），A 列入 P1。**
- **U1（UI 审计截图）**：需登录态采集正式产品各页面默认/加载/空/错五态截图，本审计仅完成 Token 层。建议阶段 1 启动时用探针账号+浏览器自动化补齐（或用户手动提供）。
- **U2（凭据）**：Vercel 远端 token 轮换、tokenrhythm Key 撤销——沿旧债，重构动凭据前须先清。

### 决策记录（2026-11-08 用户已拍板）

| 决策 | 用户选择 | 影响 |
|---|---|---|
| D1 发布范围 | **按可发布产品设计**（每用户鉴权） | 鉴权按多用户实现，P0 先用本人账号跑通 |
| D2 任务/习惯归属 | **都留 vault 本地** | 不新建服务端 todos/habits 实体；跨端由 vault 同步（Obsidian Sync/网盘）承担；**PRD 场景 B 步骤 5「在 Web 端查看任务」与场景 E 步骤 5 的口径相应修订为「另一台装插件的 Obsidian 经 vault 同步可见」**；学习/阅读/AI 会话跨端仍走服务端 |
| D3 插件鉴权 | **登录换长期设备令牌**（新增 /api/auth/device） | 复用密码体系与 sv 吊销；改密全端踢 |
| D4 共享代码机制 | **构建期代码生成**（保持拼接架构） | 生成范围=纯函数/schema/席位元数据；提示词全部服务端化后**不再进插件**，生成面进一步缩小 |

服务端新增工作因此收敛为四件：device-auth 端点、verifyAuth 扩展（sync/chat/memory/reminders 接受设备令牌）、agentSessions 入 sync FIELDS、sync 响应带 updatedAt 基线。详见阶段 1 方案文档 `docs/PLAN-PLUGIN-V2-2026-11-08.md`。

---

## 11. G1 门禁自评

| 审计项 | 状态 | 证据 |
|---|---|---|
| 插件源码审计 | ✅ | §2（21 文件 8273 行逐一定位） |
| 正式 Web 审计 | ✅ | §3.1（15 路由+NAV） |
| API 审计 | ✅ | §3.2（35 路由含 open 全端点、鉴权/限流/读写定性） |
| 数据模型审计 | ✅ | §3.3（persist v8 全实体+迁移链+云同步集合） |
| UI 审计 | ◐ Token ✅ / 截图 ⏳ | §3.4 + §10-U1 |
| 同步审计 | ✅ | §4（含「两端共同缺口」结论） |
| 技术债审计 | ✅ | §7（P0×4 / P1×5 / P2×6 分级） |
| 复用性审计 | ✅ | §8（保留/重写/删除三档） |
| P0 实现依据 | ✅（含 5 项依赖服务端工作的明示） | §6 |
| 未知事项记录 | ✅ | §10（D1-D4 + U1-U2） |

**下一步（待确认后执行）：** 阶段 1「产品与技术方案冻结」——以本审计为输入，产出：功能映射矩阵终版、数据所有权矩阵（依 D2）、同步技术方案（含实体版本控制设计）、鉴权方案（依 D3）、最终目录结构、模块依赖图、开发拆分计划。未获确认前不动任何代码。
