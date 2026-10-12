# Mentora 产品评审报告（对标大厂标准）

日期：2026-10-11 · 基准：master @ be85183（v16.5，99 commits）· 规模：src 全量 TS/TSX 17,090 行，12 页面 / 17 API 路由 / 35 个 "use client" 文件

评审方法：三路深度代码调查（后端架构与安全 / 前端与 UI 设计体系 / 数据模型与工程化），关键安全指控逐条人工复核。线上站点评审当日因本机代理宕机 + `*.vercel.app` 大陆无代理不可达，未能实测 TTFB（这本身就是「大陆可达性」问题的一次现场复现，见 §7）。

一句话总评：**这是一个品味和事故学习能力强于均值、但按大厂标准存在发布阻断级安全硬伤、核心承诺（学习闭环、BYOK、数据安全）在实现层未兑现、且没有任何真实用户信号的产品。** 差距不在功能数量和审美，在四件事：系统性质量纪律、防错架构、数据治理、可达性。

---

## 1. 产品层判断

### 1.1 定位：四个产品拼在一起，每个都到不了「不可替代」
学习教练 + 第二大脑（Obsidian 复刻）+ 读书伙伴 + 人生伙伴/圆桌。大厂立项第一问是"一句话说清你是谁的什么，用户为什么非你不可"。Mentora 的真实不可替代点是**方法论闭环**（引导→计划→六段讲义→验收→FSRS 复习）× **私有数据沉淀**（第二大脑双链网络）——这是 COMMERCIAL.md 自己认定的护城河，方向对。但产品把 60% 的精力摊在广度（12 个页面、五模式读书、16 席 persona、朋友圈时间线），深度全是 30–50 分。大厂标准做法：砍到只剩「一个 aha 场景」——例如"30 天从 JD 反推学会 X，且全程笔记自动沉淀成网络"，其余全部收进二级入口。

### 1.2 核心卖点的实现断层：验收/复习闭环「认识论不兑现」（最实质）
产品圣经（用户的 Obsidian 方法论）承诺的是"独立、严格、公平"的验收与"记忆固化"的复习。实现层四处断裂，等于卖点造假级松动：

- **判分无参照物**：quiz-grade 上下文只有题目+用户答案，不含当日讲义内容（src/app/learn/[id]/page.tsx:707-711）。模型凭自身知识盲判，"结论对但依据错不升级"的规则（src/lib/store.ts:269-271）因此不可靠。
- **复习对掌握状态零影响**：`recordReview`（src/lib/store.ts:661-699）只更新 FSRS 参数，从不写 masteryStatus；六级状态机的 `transferable`/`durable` 两级**无任何代码路径可达**（advanceMastery 封顶 independent，src/lib/store.ts:288）。「复习 4 轮固化」（ACCEPTANCE.md B3）在状态机里没有落点。
- **复习出题与判卷错位**：出题让模型从队列挑（src/lib/ai/prompts.ts:409-415），判卷却只把 `reviewQueue[0]` 的标题+前 150 字发给评分官、不出题目内容（src/app/brain/page.tsx:123-130）；且评分服务异常时**默认通过**（src/app/brain/page.tsx:134-137 `recordReview(id, true)`）——复习通过率可被故障灌水。
- **「即时复习门」是纸门**：`setDayStatus passed` 在迁移题之前就已执行（src/app/learn/[id]/page.tsx:725），迁移题只是"建议先回忆"（:1132-1134），不答照样解锁下一天。
- 文档失实：README.md:20 / ACCEPTANCE.md:26 仍宣称"1/3/7/15"，实际调度器是 FSRS（src/lib/store.ts:39）；`REVIEW_INTERVALS=[1,3,7,14,30]` 是死代码（src/lib/utils.ts:67-98，零调用）。

### 1.3 信任承诺未兑现
- **BYOK 是死码**：README.md:33/46-48 把"Key 只存你浏览器"当卖点，但全客户端零处发送 `x-mentora-*` 头（已复核：grep 仅 src/app/api/chat/route.ts:78-81 读取侧命中；streamChat src/lib/ai/client.ts:36-47 只带 Content-Type）。设置页的 apiKey 输入框（src/app/settings/page.tsx:465-466）从未接线。**后果**：所有流量都烧部署者 DeepSeek Key，"隐私自主"叙事在数据路径上不成立。
- **"第二大脑"产品，数据安全是前置信任不是功能**：云端单快照 last-write-wins 覆盖写（src/app/api/sync/route.ts:46,66-72）、无历史版本可回滚（D1 原地 UPDATE，src/lib/server/db.ts:147-198；Upstash SET 无版本，:101-103）；多设备同编辑互相抹仓。历史上已发生过两次"数据凭空消失"事故（代码注释自认：src/lib/store.ts:880-882、src/lib/auth-client.ts:68-71,237-241）——修的是竞态，模型没改。**大厂对"笔记/知识库"类产品的一票否决项就是这个。**

### 1.4 最产品级的问题：没有用户，没有信号
真实用户：1（COMMERCIAL.md:11 自述）。无 Analytics，注册→首计划→首次验收→7 日留存的漏斗完全盲（全仓 grep sentry/analytics/datadog 零命中）。当前阶段继续加功能（人生页、朋友圈、认知工具席位）的边际价值≈0；边际价值最高的是：让产品可被目标用户打开（§7 可达性）、跑 10 个真人、看他们卡在哪。大厂 PMF 标准动作：先留存后功能。

### 1.5 Onboarding：方向对，刚起步
三步 onboarding + seedSampleGoal 一键体验（89a038a，2026-10-10）符合"60 秒到 aha"原则，是最近最正确的产品决策。待补：落地页→注册的转化路径没有数据支撑，示例目标完成后没有付费/深化钩子。

---

## 2. UI / 体验设计（对标大厂设计系统）

**做得好的（部分超大厂平均水准）**：设计令牌真实存在且被消费（globals.css:68-87 `@theme inline` 12 色板）；独创时段主题 `html[data-period]`（globals.css:368-372）；动效克制成体系且两处 prefers-reduced-motion 覆盖（globals.css:289-342）；落地页动效工程细节（hero seek 防洪泛三态机 landing.tsx:28-98、PopText 字体/样式加载时序 use-poptext.ts）——多数大厂落地页反而黑屏/抖字体。

**与大厂差距（逐条）**：
1. **令牌渗漏三层**：ui.tsx 的 Button 自己用 `bg-[#1a1a1a]`（ui.tsx:30）而不是 bg-ink；同款墨色复制 ≥14 处无变体抽象（landing.tsx:421、council:540、read/[id]:538、learn/[id]:115、assistant-widget:124/152/191…）；改一次品牌色要 grep 全站。
2. **排版完全脱缰**：`text-[Npx]` 任意字号 188 处（11px×46、13px×34、10.5px×22、12.5px×20、10px×18…），无类型标度；`html{font-size:15.5px}`（globals.css:91）非标准根字号与所有 px 叠乘，rem 体系形同虚设。大厂设计系统第一件套就是 type scale 令牌化。
3. **组件库只有 10 个 primitive**（ui.tsx 共 283 行），无 Dialog/Popover/Tooltip/Tabs 抽象；聊天气泡四处复制。
4. **可访问性硬伤（大厂验收红线）**：全库 `role=` 0 处、aria 属性仅 9 处；**流式 AI 输出（核心体验）0 处 aria-live**——读屏用户完全感知不到回答生成；Modal 无 role="dialog"/aria-modal/焦点陷阱/Esc（ui.tsx:230-270）；图标按钮普遍只有 title 无 aria-label（app-shell.tsx:215-226、note-workspace.tsx:1271-1281）。
5. **触控目标普遍 <44px**：note-workspace 工具栏 p-1.5+size-3.5 ≈26px（:1271-1281）、移动底栏 7–8 列每格 ~40px（app-shell.tsx:296-328）；落地页 hero 擦洗只监听 mousemove（landing.tsx:58），**手机用户看到的是静止帧——核心卖点的动效在移动端完全缺席**。
6. 移动汉堡菜单关闭态用 opacity 隐藏，链接仍在 tab 序（landing.tsx:281-307）；admin 表格是"能看"不是"能用"（min-w-[820px] 横滚，admin/page.tsx:245-246）。
7. reduced-motion 只覆盖 CSS 动画；JS 动画（打字机、PopText、hero 视频）零处 matchMedia。
8. 深色模式无（纯浅色是产品决策，但大厂设计系统要求 token 层支持双模）。

---

## 3. 前端工程

**发布阻断级**：
- **learn/[id]/page.tsx:230 条件性 useState**——位于 `if (!hydrated) return`（:213）和 `if (!goal)`（:214-223）两个提前 return 之后，钩子数量随渲染变化 = React #310 白屏隐患。讽刺：提交 8697b91 的信息写着"踩坑 #9 第三次踩"，同日修复了总览页的同款问题，本页同模式仍未修——证明**教训没有系统化拦截（见 §6 lint 门禁缺失），只靠人肉记性**。

**大厂标准差距**：
- ESLint 实测 19 errors + 36 warnings 常亮：graph-view.tsx 渲染期读 ref ×5（:504/575/584）+ immutability（:346）= React Compiler 对该文件不可开启；`set-state-in-effect` ×5。
- 巨型文件：note-workspace.tsx 1,616 行、learn/[id] 1,217、store.ts 1,015（七域一个 create，未切 slice）——大厂惯例 >400 行必拆。
- 整树客户端化：35 个 "use client"，Server Component 仅 layout.tsx；`key={pathname}` 每导航 remount 整页换入场动画（app-shell.tsx:290）；`/` 在 auth 检查期纯白屏无骨架（page.tsx:19）。
- 性能：767 篇笔记全量 DOM 渲染无虚拟滚动（note-workspace.tsx:943），搜索每次击键全库 title+body 子串扫（:378-386）；`next/image` 0 处、二维码原图 327KB+124KB 直出（public/）、hero.mp4 792KB `preload="auto"` 无条件加载（landing.tsx:87）；`next/dynamic` 全站 0 次（mammoth/turndown 的 await import 做对了，doc-import.ts:14-24）；framer-motion 是死依赖（package.json 有、代码 0 用）。
- apiKey 明文进 localStorage persist（store.ts:892 含 settings 全量；仅推云时剔除 auth-client.ts:140）。
- 亮点：strict TS + **0 个 any**（罕见）、0 TODO、几乎每个坑都有根因注释——注释文化是大厂水准。

---

## 4. 后端与架构

**做得好的**：存储抽象收口干净（dbGet/dbPut/dbList/dbDelete 四原语三通道同 key 同加密，src/lib/server/db.ts）；流式上游 45s 超时+分级重试+首字节前幂等（api/chat/route.ts:166-216）；提示词 IP 保护三层（prompts.ts:10 server-only + args 服务端组装 + seats.test.ts 静态扫描）；会话 4096 事故后的 cookie 纪律（login/me/profile 三处一致）；安全响应头矩阵（next.config.ts:6-26）。

**硬伤（上线即事故级；全部经人工复核或代码直读）**：
1. **服务端 AI Key 有公开外泄通道**：`x-mentora-baseurl` 头无白名单（api/chat/route.ts:80 + :115-116）；发 `x-mentora-provider: deepseek`（不带 key）→ 服务端把 env DEEPSEEK_API_KEY 装上（:91-92）→ `Authorization: Bearer <key>` POST 到攻击者 URL（:180-192）。等于提款机：可盗烧 Key。
2. **AI 配额可绕过且 /api/chat 不需要登录**：配额判定只看 `x-mentora-key` 头存在性（route.ts:266），发一个假头即无限烧服务端 Key；未登录按 IP 计（route.ts:268），换 IP 即重置。
3. **生产后台密码明文躺在仓库**：scripts/cleanup-probe-accounts.mjs:4 硬编码 `"Mentora@2026"`（已与 .env.local 实际值比对一致）。仓库虽已私有，但任何协作者/再公开/备份泄露 = `/api/admin/users` 全量用户邮箱可读可删。需改密+删脚本+加 git 历史检查。
4. **注册验证码在生产是静默旁路**：无 RESEND_API_KEY 时 devCode 直接返回响应体（api/auth/send-code/route.ts:34-35）——当前生产未配 Key，等于任何人注册任意邮箱零门槛。
5. **无忘记密码/重置路径**：auth 路由只有 login/register/change-password(需旧密码)/logout。密码丢了=账号永久锁死（用户数据唯一副本在其中）。大厂 SaaS 底线功能缺失。
6. **会话不可吊销**：无状态 HMAC 30 天硬到期（src/lib/auth.ts:62-71），改密只重签当前设备（change-password/route.ts:19-21 注释自认），登出不作废 token。无服务端版本号/吊销表。
7. **限流与验证码全在进程内存，Serverless 下形同软限**：令牌桶每实例独立（src/lib/rate-limit.ts:3-5 注释自认）、验证码内存 Map 跨 isolate 失效（src/lib/server/mail.ts:13；:4-5 "多实例概率极低"是错误判断——Vercel 每请求可能新 isolate，验码失败是常态风险）。**爆破防线结论：换 IP 即可无限爆破任意账号，无账号维度锁定/验证码阶梯；/api/admin/overview GET 无专项限流。**
8. **AUTH_SECRET 一钥三用**：会话 HMAC（auth.ts:15）+ 全库数据加密密钥派生（db.ts:19-23 scrypt(AUTH_SECRET,"mentora-db-v1")）；一个秘密泄露 = 会话伪造+数据解密双杀；无密钥分离/轮换设计。
9. /api/sync POST 零体积校验 + 服务端 gunzipSync（sync/route.ts:53-55）：压缩炸弹/超大仓直通（对比 /api/chat 有 1MB 闸 route.ts:254）。
10. D1 分块写无事务（db.ts:147-198）：主行+块逐条 upsert，中途失败撕裂状态。
11. 管理鉴权逻辑复制两份（api/admin/overview/route.ts:14-31 vs src/lib/server/admin-auth.ts:18-31）——漂移风险；管理员邮箱白名单硬编码进前端 bundle（src/lib/admin-emails.ts:6 被 app-shell.tsx:25 客户端 import）。
12. 迁移脚本 Redis 版目录写死 `["users","sync"]`（scripts/migrate-to-redis.mjs:43），现行 key 是 `data/`（sync/route.ts:26）——若按计划启用 Upstash，**全部用户云数据漏迁**（对照 D1 脚本用对了 ["users","data"]）。

**及格线差距**：zod 只护 AI 输出不护 API 输入（20 个端点全部手工 `String(body.x ?? "")` 解析）；无 CSRF 显式防御（SameSite=Lax 隐式挡表单式）；错误格式无错误码/trace ID；scrypt 参数未固化、密码下限 6 位；/api/health 不探活任何依赖（health/route.ts:6-17，存储挂了仍显绿）；Upstash 通道用阻塞式 `KEYS`（db.ts:105-109，注释却写"SCAN"，言行不一）；admin overview 全表 N+1 点查（:72-102）；quota 键永不清理（quota.ts:10-11，无界增长）。

---

## 5. 架构与技术选型总评（vs 大厂形态）

当前形态是**「客户端优先的本地单文件应用 + KV 快照云同步」原型架构**；大厂成熟产品形态是**「服务端真源 + 行级增量同步」**。差距具体化为：

| 维度 | Mentora 现状 | 大厂标准形态 | 差距性质 |
|---|---|---|---|
| 数据真源 | 浏览器 localStorage，云=整仓快照镜像 | Postgres 服务端真源，字段级 CRUD | 架构级 |
| 同步 | LWW 全量覆盖，冲突=互相抹除 | 增量 diff/CRDT/OT + 冲突 UI | 架构级 |
| 备份 | 云端单副本覆盖写，历史不可回滚 | PITR/快照/副本 | 一票否决级 |
| 认证 | 自研 scrypt+HMAC cookie | 托管身份（Clerk/Auth0/自建会话表可吊销） | 纵深级 |
| 查询能力 | KV 点查 + 客户端全量解密 | SQL 索引/聚合/分页 | 架构级 |
| 定时/队列 | 无（vercel.json 无 cron；复习提醒纯客户端） | 任务队列+推送触达 | 功能级 |
| 密钥治理 | 单一 AUTH_SECRET 多用 | KMS/密钥分级/轮换 | 安全级 |

不是要现在全部重写——而是**清醒知道：上真用户量之前，KV 快照架构每多一个用户就多一份"数据丢失诉讼风险"**。v2 路线（README:105 提到 Postgres）应提前为 P1，而不是等付费用户出现。

---

## 6. 工程成熟度（测试/CI/发布/观测）

- 测试：6 文件 28 用例，CI 实跑 21——**全部是纯函数/静态扫描**；最关键的 store 状态机（unlockNext/advanceMastery/masteryFromQuiz）、persist 迁移、auth/db/quota/sync **零覆盖**；无组件测试（testing-library 未装）。e2e 门禁（"AI 链路改动全绿才部署"）靠人自觉，无钩子强制。
- **persist migrate 是死代码**：skipHydration 绕过了 rehydrate，注册的 migrate（store.ts:895-918）实际不执行；真正生效的是 setStoreUser 内联版（:966 起）——两套迁移已漂移（persist 版多 linkify、单分支 early-return 不叠加）。无迁移测试。
- CI（.github/workflows/ci.yml 21 行）：install（`npm install` 非 `npm ci`，lockfile 不被尊重）→ tsc → vitest。**不跑 lint**（19 errors 常亮的直接原因）、不跑 build（可构建性只有 Vercel 侧验证）。
- 发布：单通道 Vercel、无 preview 策略文档、**0 个 git tag、无 CHANGELOG、无回滚程序**、master 领先 origin 2 个提交（评审当日）。
- 观测：logEvent 仅 /api/chat 三处落 stdout（route.ts:196/214/303）；admin 用 console.log 打印管理员身份；无 Sentry/OTel/Analytics/告警；token 计量全仓零实现（grep usage/prompt_tokens 无）——成本只有按次配额。
- 文档失实三处：README.md:32 说"Upstash 主通道"，db.ts:10 注明生产主通道实为 D1；1/3/7/15 vs FSRS；ENGINEERING.md:75 "13 用例"过期（现 28）。**ACCEPTANCE.md 是人肉清单却写得像实测报告**——大厂文档纪律要求区分"已自动化"与"人工抽查"。

---

## 7. 合规、商业化与触达（"真正落地"缺什么）

- **法律三件套全无**：无隐私政策、无用户协议、无数据处理/删除承诺页（全仓 grep privacy/terms 仅命中 prompts 语境词）。收集邮箱+IP 行为日志，收款前这是硬前置。
- **支付/兑换码/退款：0 实现**；COMMERCIAL.md:17/25 全是计划。
- **数据合规风险**：邮箱明文入档（静态 AES，密钥与会话同源）；无"忘记密码"意味着用户对自己数据的访问权可能无法行使。
- **大陆可达性 = 当前获客的第一物理障碍**：`*.vercel.app` 大陆直连不可达（无代理用户打不开；评审当日本机代理宕机、直连超时 000，现场复现）。COMMERCIAL.md:10/19 自己列为欠账。**不解决这个，产品改进的观众数是零。**
- 触达链路缺失：无邮件复习提醒/召回（Resend 仅注册验证码用）；`/life` 朋友圈是站内内容，不是触达。

---

## 8. 「每一个观点」的不足点清单（按修复优先级）

**P0 —— 修完之前不该再推广一个用户（安全与数据生命线，8 项）**
1. 堵 /api/chat 头注入外泄：baseUrl 白名单 + provider/key 匹配校验（chat/route.ts:80,91-92,115-121）。
2. 配额判定改为"校验 Key 归属"或先收登录墙；/api/chat 加登录要求（chat/route.ts:247-277,266）。
3. 改生产 ADMIN_PASSWORD，删 scripts/cleanup-probe-accounts.mjs 明文，脚本出仓；加 secret 扫描入 CI。
4. 配 RESEND_API_KEY 并让 send-code 在生产**拒绝**降级返回 devCode（send-code/route.ts:34-35 按 VERCEL_ENV 分流）。
5. 云端数据多版本化（D1 加历史表/快照键带时间戳保留 N 版）+ sync POST 体积闸；备份是这个产品的第一信任资产。
6. 忘记密码/重置链路（验证码已有基础设施，补 purpose=reset）。
7. 会话加版本号实现可吊销（users 档案里存 tokenVersion，改密/登出/注销全局失效）。
8. 大陆可达性决策：自定义域名+ICP 或 Cloudflare 系域名——没有可达性，其余全部改进的受益人数为 1。

**P1 —— 核心体验与质量纪律（12 项）**
9. 修 learn/[id]:230 条件性 Hook；ESLint 入 CI 门禁（19 errors 清零后再上 `--max-warnings 0`）。
10. 验收闭环补参照物：quiz-grade 注入当日讲义/知识点内容；复习判卷把题目原文带上；废除"异常默认通过"（brain/page.tsx:136）。
11. 复习→掌握状态机接线（transferable/durable 可达），迁移题真门（不答不解锁或明确降级路径）。
12. CI 改 `npm ci` + 加 build 验证；git tag + CHANGELOG。
13. Sentry + Vercel Analytics 接入（先有漏斗数据再谈增长）。
14. token 计量（上游 usage 透传+落 logEvent），成本可见才有定价。
15. 限流/验证码出进程：Upstash Ratelimit/D1 表存桶与码。
16. 登录加账号维度防护（失败计数→验证码阶梯→临时锁定）。
17. API 输入 zod 化（20 端点）；管理鉴权收口到 admin-auth.ts 单实现。
18. 767 篇列表虚拟滚动；hero.mp4 改 `preload="metadata"`+poster 先行、二维码图片压缩、上 next/image。
19. 类型标度令牌化：188 处 text-[Npx] 收敛到 8-10 档；bg-[#1a1a1a] 收成 Button variant。
20. Modal/Dialog 补焦点陷阱+role+Esc；流式输出加 aria-live；触控目标 ≥44px；hero 动效加 pointer 事件版。

**P2 —— 体系升级（数据架构、合规、增长）**
21. 迁移到服务端真源（Turso/Neon Postgres + 行级同步 + 冲突 UI），localStorage 退位为缓存。
22. AUTH_SECRET 拆分为会话密钥/数据加密密钥，建立轮换；BYOK 二选一：真接线（发 x-mentora-* 并校验）或从 README 撤下该卖点。
23. 隐私政策/用户协议/数据删除承诺三页；数据导出格式契约。
24. persist migrate 死代码清理：单套迁移实现+迁移测试。
25. 级联删除从字符串匹配改引用关系（goalId 外键语义）；updateGoal 改 topic 加护栏。
26. 组件测试（关键交互）+ prompt 评测 golden set（防"改一个 prompt 坏一条链路"）。
27. cron 复习提醒邮件；兑换码最简收款。
28. 文档纠偏（README 存储通道/FSRS/用例数）；ACCEPTANCE 标注人肉 vs 自动化。
29. 砍功能勇气：人生页/圆桌/认知工具席降级为实验区，把资源收给教练闭环——产品广度的每一分都是深度的欠账。

---

## 附：与大厂差距的本质（五句）
1. 大厂先建"不会输"的系统（门禁、观测、备份、吊销），再谈体验；Mentora 是事故驱动补洞，洞补得漂亮，但同类坑三次复踩证明纪律未系统化。
2. 大厂的安全是纵深（网关+应用+数据三层）；Mentora 的安全是散点（限流/头/黑名单各管各），一处旁路（chat 头注入）就穿透全部。
3. 大厂卖"承诺"必须先有"实现+测试+度量"三件套；Mentora 目前 BYOK、1/3/7/15 固化、复习门三处是文案先行。
4. 大厂产品评审第一页是用户与数据；Mentora 评审第一页只能写"真实用户：1"。
5. 差距不在品味（时段主题、动效纪律、根因注释、0 any 都超均值），在工程与产品治理的**系统性**——这恰好是可以照清单补的部分。
