# CHANGELOG

版本史此前散在 git log 与 Obsidian 项目志（v1→v16.5 见 `git log`，仓库首个带 tag 的版本是本文件记录的 v17）。

## v26.0 — 2026-11-07（升级 PRD V1.0 P0：知识迁移层 + 误解接线 + 四级判定 + 整本结业）

先审计后开发（PRD 第十步流程）：审计报告逐条带文件行号交付，P0 五项按真实缺口实施，零重复实现。

- **G1 知识迁移（本次升级核心）**：reading-transfer-gen/grade——按用户最初目标生成真实场景应用任务（非选择题；文学/哲学出思想比较型）→ 独立作答 → 三级判定（used_correct/used_wrong/naming_only，区分会用与只会复述）→ book.transfers 记录；used_correct 联动 practice 沉淀+学习证据；**有已掌握节点即可迁移，不必等读完**
- **G2 误解接线**（修死数据）：判分器顺带提取 misconception → learning.misconceptions（新增 clarified 语义）；重考通过即同概念澄清，右栏「已澄清」徽章
- **G3 四级判定**（对齐 PRD 3.5）：level 加 ungradable——歧义/离题不许当 partial 放水、不计入通过、UI「换题重考」
- **G4 整本结业**：reading-graduation——结业笔记（能力描述/核心认知/仍不足/迁移结果）→ 存第二大脑进复习队列；nextSteps 仅建议
- **G5 收敛纪律**（PRD 3.4）：五模式通用约束加硬禁令——已理解即收敛/无证据不宣称掌握/脱离书籍要标注
- **G6 基础识别**（补 PRD 7.1）：ReadingGoal.background + 目标卡「你的基础」输入 + 策略调度基础纪律——三场景 C1 由 FAIL 转 PASS 的关键

验证：单测 242 绿（+9）；真模型 e2e 15 条全绿（+3 迁移/结业）；UI 冒烟 24 项 ALL PASS（本地+腾讯云+Vercel 三轮）；**三场景端到端（PRD 第八章）腾讯云生产 12/12 PASS**（A 商业 5/5 迁移判定 used_wrong 有牙不放水 / B 零基础 5/5 / C 深度 2/2 调度理由命中用户基础）。同批修 e2e helper bug（t=h 思考心跳混入正文致假红）+ 讲义按通道跳过（qwen>300s 模型能力边界）。提交 f77c5e1，tag v26.0；腾讯云 tar 部署 + Vercel CLI（build=f77c5e1）双站生产冒烟通过。

## v25.0.1 — 2026-11-06（建书超时根修：用户实测"一直转圈然后报错"）

用户在生产建书《影响力》时弹窗无限转圈后报错。根因：`UPSTREAM_TIMEOUT_MS=45s` 是全局「等到响应头」预算，而阅读路线生成（推理模型+长输出）响应头可达 90s+，45s 超时 → 重试 3 次全超时 → 报错。四维修复：

- **超时按任务分级**：长生成任务（reading-plan / plan / lesson / graduation / persona-distill）响应头 120s、流空闲 90s；其余维持 45s/45s。`/api/chat` 的 `maxDuration` 60→300（自托管不受限；Vercel 按套餐钳制，超限由平台诚实报错，比假超时改善）
- **READING_PLAN 减重**：map 每区域 ≤2 句、5 节点、每字段一句话、全文 ≤1200 字（qwen 服务器端实测 39s 完成；保 Vercel 生命线）+ 格式铁律（对象非数组/chapters 项非字符串）
- **小程序兼容**：createBookFromPlan 接收新 `map` 输出并在无 bookProfile 时自动转换（否则小程序新建书籍丢档案）
- **弹窗诚实提示**：「正在拆解这本书…（约 1 分钟，请别关窗）」

验证：tsc 0 / eslint 0 error / vitest 233 绿 / build 50 页；UI 冒烟 22/22（本地+腾讯云生产各一轮 ALL PASS）；真模型建书全流程（注册→弹窗→生成→跳转→目标卡/认知地图/路线渲染）本地 89s、腾讯云生产 39s PASS。

部署记录：commit cc95d12 push master + 腾讯云 tar 同步构建重启（health 200 + 生产冒烟通过）；Vercel git 集成本次未触发构建，CLI 直传补部署。

## v25.0 — 2026-11-06（阅读系统 V1.0：按 PRD 大改，P0 全量落地）

对照《Mentora 阅读系统 PRD》（产品设计基线）完成读书伙伴到「自适应 AI 阅读与学习系统」的大改。核心命题：**已读完 ≠ 已掌握**；产品目标从"读懂一本书"升级为"通过阅读建立自己的学习体系"。

### 阅读目标管理（PRD 4.1，全新）
- 四种阅读成果（理解/思考/应用/沉淀）+ 主次目标组合 + 一句话意图；进入书籍首先出现目标卡
- 「让 AI 推荐」按书目信息推断目标；「直接开始」一键按理解型进入（推断标记，随时可改）——不强制填问卷（PRD 验收 1）
- 修改目标不清洗任何记录；提供按新目标重排路线入口（PRD 验收 3/4）

### 书籍认知地图（PRD 4.2，改造）
- `READING_PLAN` 升级输出 `map` 四区域：这本书在解决什么问题 / 作者核心主张 / 思想谱系 / 争议与局限（含适用边界）
- 诚实纪律入提示词：不确定写「一般认为」「（待核）」，不得伪造完整性；UI 标注"AI 生成供导读，重要观点请核对原文"
- 旧书的 `bookProfile` 自动转换为四区域显示（两代数据兼容）；`readingPlanSchema` 加裸数组容错（小模型偶发跳过对象包装，v14 extractJson 家族）

### 个性化阅读路线（PRD 4.3，扩展）
- 节点新增字段：关键概念 / 前置知识 / 预期学习成果 / 验收锚点；展开导读逐一展示
- 三种路线：完整 / 核心 / 目标导向——换路线入口在路线菜单，重排后旧章节验收结果自动归档进 `book.assessments`（含旧版分数制 verification 与新版 masteredAt 两代记录），对话/洞见/沉淀/学习状态原样保留
- 节点状态机：todo → reading → done / skipped，可跳过、恢复、上移下移排序；「让 AI 加一个我感兴趣的节点」（reading-add-node）

### 自适应教学引擎（PRD 4.4，hybrid 落地）
- 五模式（苏格拉底/费曼/思想碰撞/精读带读/复盘检验）沿用 MODE_RULES v2 行为契约，作为策略层
- 新增 `reading-strategy` 策略调度：进节点时按目标+节点+学习状态+最近对话推荐一次（cheap 任务，失败静默回落知识类型默认）；推荐以非侵入 chip 展示，一键采用
- 用户手动锁定模式时推荐完全让位（用户选择 > 系统推荐）；调度纪律入提示词：一次答错不切换更简单模式

### 三重验收（PRD 4.5，重构）
- 由"举例30%+迁移30%+贴合40%"固定三题，重构为 **Explain 理解 / Connect 结构 / Apply 迁移**三维度按阅读目标加权出题（reading-assess-gen）：理解型 explain×2+connect×1 / 思考型 connect×2 / 应用型 apply×2 / 沉淀型均衡；迁移题强制新情境
- 证据化判分（reading-assess-grade）：evidence 必须引用用户原话，partial/not 点名具体缺口；空白判 not 不放水
- 通过 = 无 not 且 mastered ≥ 2/3 → `markChapterMastered`（节点 masteredAt + 学习证据入档）；未过 → 逐题证据反馈 + 「就薄弱点补课」一键把缺口发进对话区（验收服务于学习，不制造负担）；可重考、可跳过
- 出题失败本地兜底三题，不阻断验收

### 已读完 vs 已掌握（PRD 4.5，全新）
- 书级五态状态机：未开始 / 阅读中 / 已读完 / 验收中 / 已掌握（readStatus 独立于 status 持久化，migrate v7→v8 双路推导）
- 已读完（手动标记/全节点完成）→「整本复盘验收」（切入复盘检验模式）→ 用户自证后「标记已掌握」；每一步都标注诚实原则
- 手动"标记已读完（不验收）"永不写 masteredAt；回退未读状态自动清掌握标记

### 个人知识沉淀（PRD 4.6，扩展）
- 节点级一句话沉淀：我的解释/核心点/问题/我的观点/实践案例/待解决/AI 反馈 七类，随时记录随时删除
- 「生成本节点小结」（reading-recap）：以用户自己的话为主（署名"你的话"），材料不足如实说明、不替用户编；可一键存入第二大脑
- 待解决问题面板：右栏快记 + 对话/沉淀自动归集

### UI（PRD 3.3）
- 阅读页重写为三栏：顶部认知概览（可收起）｜左阅读路线｜中 AI 阅读空间｜右学习状态面板（目标/当前节点/理解状态/待解决/验收进度/整本书状态）
- 右栏桌面默认展开可收起（右缘把手），窄屏折叠为学习状态条；移动端保留 44px 触控与 `above-mobile-nav` 约定
- 书架卡片显示阅读状态徽标（已掌握/已读完/在读）、目标摘要与掌握计数

### 工程
- 新任务六个：reading-goal / reading-strategy / reading-assess-gen / reading-assess-grade / reading-recap / reading-add-node（`reading-strategy`、`reading-goal` 入 CHEAP_TASKS 走快模型）；全部有 demo 同形状实现（演示模式全闭环可用）
- store v8 迁移（status→readStatus 推导 + assessments/deposits 补默认），与 setStoreUser 共用 migrateState 单一真相；新增 10 个阅读系统 store action
- 单测 +22（reading-v25.test.ts：schema 容错/demo 同形状/状态机语义/归档保留）；e2e +5（真模型：路线 v2/目标推荐/策略调度/出题/判分，全绿）；顺手修复 `regenerateBookRoute` 漏归档 masteredAt、`note-workspace.tsx` 重复 aria-label
- 已知边界（诚实记录）：本地 qwen3.8-flash 下原有 5 条长文 e2e（总纲要/天级/讲义/苏格拉底契约/资源修复）仍为红，与本轮改动无关（v21.0/v23.0 已记载的模型能力边界）；苏格拉底契约复跑两次输出质量正常，属 flaky

## v24.0.1–v24.0.4 — 2026-11-05（二期上线修复串：构建自洽 + 派发索引化）

- **v24.0.1 / v24.0.2**：master 构建自洽修复——v24.0 提交时误带了并发会话未提交的 prompts.ts 改动（NOTE_ASSIST 严格联合类型）与 chat/route.ts 的会员门禁依赖（lib/server/entitlement 未提交），导致 Vercel 与腾讯云构建失败。处理：`/api/chat/route.ts` 与 `prompts.ts` 均用 git 干净版 + 本会话的个人上下文改动拼出可部署版本（`git hash-object -w` + `update-index --cacheinfo` 入索引，**不覆盖并发会话的工作区文件**）；记忆注入锚点修正为只在 AGENT_CHAT 模板内插入（首版误插到 reading-chat 模板，构建报 `Cannot find name 'opts'`）。
- **v24.0.3**：**触发与投递解耦**——自托管未配发信服务时，tick 不再直接失败，而是照常标记 lastRunKey 并记 `lastDeliveredVia: "inapp"`，应用内横幅（firedToday）兜底提醒；配好 RESEND_API_KEY/华为中继后自动升级为邮件。
- **v24.0.4**：**派发索引化**——实测全量遍历 users/ 需 **46 秒**（每人多次 KV 往返），超 Vercel 60s 上限也让每分钟定时器排队。改为维护 `automations/_index.json`（owners 带 email），tick 只扫有提醒的用户：**实测降到 850ms**；另加 20s 时间预算与单次上限 20 条。
- 定时器踩坑：systemd unit 里嵌套单双引号被吃掉（curl 把 secret 当主机名）——改为独立脚本 `/opt/mentora/scripts/tick.sh`，unit 只调用脚本。
- 验证：三处生产 e2e 各 6/6（本地 / 腾讯云公网 / Vercel）；腾讯云端到端实测"建提醒 → 定时器触发 → firedToday=true → 删除后索引归零"；tsc 0 错 / eslint 0 error / vitest 206 通过 / build 通过。
- 回退：`v24.0-memory`。

## v24.0 — 2026-11-05（二期：长期记忆 + 定时提醒，技能按用户裁定不做）

主线：让智能体记住人、到点提醒人。技能（声明式指令安装）已按用户决定移除，代码零残留。

- **长期记忆**：`memory/<userId>/<entryId>.json`（加密 KV，userId 取自会话）；`/api/memory` GET(关键词/标签检索，2-gram 相关度) / POST / DELETE；条目上限 500、单条 500 字、文本去重。
- **智能体 `memory` 工具**：recall（读，自动）/ remember / forget（写，走审批卡）。写入链路：模型起草 → 用户批准 → 落云端 KV。
- **记忆注入**：agent 任务组装系统提示词时带上"最近 20 条记忆摘要"（服务端组装、1.5s 硬预算，KV 慢就注入空、不拖首字节）。
- **定时提醒**：`automations/<userId>/<id>.json`（title/prompt/time/days/timezone/enabled/lastRunKey）；`/api/reminders` CRUD；`/api/cron/tick`（CRON_SECRET fail-closed）按用户时区判定到期、幂等水位（当天同一时刻只发一次、跨天不追发）、单次上限 20 条、确定性邮件（复用 sendEmail，不再调模型，零 token 成本）。
- **调度**：腾讯云 systemd `mentora-tick.timer` 每 60s 触发（主力）+ vercel.json 每日 07:00 北京兜底；应用内横幅显示"今日已触发的提醒"（按天可关闭）——邮件之外的第二通道。
- **验证**：`personal.test.ts` 12 条（时区换算/到期判定/幂等/星期限定/输入校验）；真模型 e2e 6/6（记忆与提醒都经审批卡落库、注入后被模型复述、关键词检索命中、cron 无 secret 一律 403、探针数据清理）；tsc 0 错 / eslint 0 error / vitest 206 通过 / build 通过。
- **部署纪律**：本期只上传本会话涉及的文件——并发会话的会员门禁（`lib/server/entitlement` 等未提交改动）不入生产；`/api/chat/route.ts` 用 git 干净版 + 个人上下文注入拼出可部署版本。
- 回退：`v23.3.1`。

## v23.6 — 2026-11-06（免费版降级：到期即转免费，AI 走月度 token 预算 + 阶段付费墙）

按用户 PRD《Mentora 会员与免费体验系统》落地 P0 核心：

- **到期 ≠ 锁号 = 降级免费版（PRD §6）**：此前到期直接 402 停 AI；现在自动转入免费版——AI 仍可用但受月度 token 预算（`FREE_MONTHLY_TOKENS`，默认 20 万，月度窗口自动恢复），学习记录/笔记/导出全部保留。search/fetch-page 对免费用户放开（各自每日限流兜底）。
- **用量计量（PRD §3）**：新增 `lib/server/usage.ts`（`usage/<emailHash>/<YYYY-MM>.json`），chat 流结束后按上游真实 usage 结算，缺 usage 时按字符估算；发请求前查预算，超了返回友好文案"本月免费额度已用完，下月 1 日恢复"（429 `FREE_BUDGET_EXHAUSTED`），绝不吐技术错误。只对走服务端 Key 的免费用户计量——BYOK 烧自己的钱不计量。
- **阶段付费墙（PRD §4）**：学习教练前两个阶段免费，第三阶段起免费版锁定——时间线上标「会员」Badge、目录条目禁用、正文替换为付费墙卡（写清已有成果保留 + 解锁什么 + 价格）；锁定的阶段不自动生成目录/讲义（不白烧 token）。
- **修后台生成卡密留空天数必报错的 bug**：前端留空发 `days: null`，服务端只把 undefined/"" 当"用套餐默认"→ `Number(null)=0` 报"天数需在 1-3650"。两侧都修：前端留空不带字段，服务端 null 也算默认。
- 验证：tsc 0 错 / build 通过 / vitest 233 通过；真库 e2e——过期账号 chat 返回 200 完整流（旧逻辑是 402）、后台行 status=expired；卡密生成留空天数通过（待线上复验）。Clarity `build` 通过。

## v23.5 — 2026-11-06（老账号特权年卡 + 邀请关系可见 + 设置收纳）

用户三条指令的落地：

- **老账号特权（除管理员外）**：存量"无到期时间"的账号在**登录时**自动获得 365 天 founder 年卡（不是一次性批量改库——不登录的人不动他的档案）；管理员账号（admin 白名单）保持长期有效。顺手给没有邀请码的账号补一个，实现"人人有邀请码"；新注册账号在注册时即生成。福利发放失败绝不挡登录。
- **邀请关系可见**：注册档案记 `invitedBy`（邀请码），后台「会员管理」新增"来自邀请"列——用全量邀请码→邮箱索引解析成邀请人邮箱（解析不到时显示原始码），配合已有的邀请码/+人数列，"这个人是谁拉进来的"一眼可查。
- **设置收纳（用户定）**：侧栏导航不再有独立「设置」入口——点侧栏底部头像/用户框进入；移动端收进「更多」抽屉。邀请（拉新）从会员页挪进 设置 →「邀请」tab（我的邀请码/链接/战绩 + 原交流群二维码），会员页只留一行入口。
- 修复三处并发会话留下的半成品（都在同一工作区，先修好再验证）：`/life` 学习日历 `localDateStr is not defined`（重构改到一半，调用点没跟上——按 utils.ts:70 的 UTC 日不变量收尾，顺手改用 `streakFrom`）；cmdk 的高亮 effect 引用未声明的 `items`（TDZ，会炸整个工作台壳）；`ensureAuxTable` 的 DDL 回调类型与 `rdsQuery` 返回值不匹配。
- 验证：tsc 0 错 / build 通过 / vitest 233 通过；真库 e2e：legacy 账号登录 → plan=founder、365 天、邀请码自动生成 → 后台行可见；B 凭 A 的邀请码注册后，A 行 referred=1、B 行"来自邀请"=A 的邮箱；/life 用真实浏览器渲染无报错（测试账号已删、测试码已作废）。

## v23.4 — 2026-11-05（商业化闭环：激活码 / 会员到期 / 后台运营）

从"一个共享内测码"升级为可售卖的一人一码体系，并把运营后台并入 Clarity Admin。

- **激活码（卡密）**：一张码 = 一次兑换 = 给账号充值 N 天，30 字符表（去掉 0O1IL）3 组 4 位；`licenses/<hash>.json` 单码记录 + `licenses/index/<批次>.json` 批次索引。新增 `dbPutIfAbsent()`（Upstash/DCS `SET NX`、RDS/D1 `INSERT ... ON CONFLICT DO NOTHING RETURNING`、GitHub 201/422）做原子占用，`claim/<hash>.json` 保证一码只有一个赢家；注册写库失败会回滚占用，用户可立刻用同一张码重试。
- **会员到期 = 只读宽限**：到期立刻停 AI（chat/search/fetch-page 返回 402 `MEMBERSHIP_EXPIRED`），但账号、笔记、导出、云同步全部保留，数据永不自动删除。老用户档案没有 `planExpiresAt` 一律视为长期有效，绝不误锁；KV 读取故障/超时降级放行——故障不该变成付费墙。
- **注册怎么变**：`api/auth/register` 不再比对 `INVITE_CODE`（该变量停用），改为查库 + 原子占用激活码，新账号直接带 `plan/planExpiresAt`；登录与 `/api/auth/me` 一并返回权益，前端据此显示到期横幅与会员页。
- **续费**：`/api/subscription/redeem` 在原到期日上累加（不是从今天重置），并发走 `lock/sub/<emailHash>` 短锁。新增 `/membership` 会员中心：状态、剩余天数、兑换入口、价格、人工购买说明。
- **忘记密码改道**：不再用共享邀请码重置任意账号（等于没有锁），改为管理员在后台一键发一次性重置码（24h、用后即焚、错 8 次作废）。
- **首页开始卖**：定价区（月付 9.9 / 年付 99，价格集中在 `src/lib/pricing.ts`）、FAQ（到期会怎样/数据归谁/换设备）、Hero 主 CTA 改「申请 7 天体验」并弹窗留资 → `leads/`，后台一键发体验码。
- **拉新奖励（用户定：拉一个新用户送一个月）**：会员页显示专属邀请码 + 邀请链接（`?ref=` 自动预填注册表单），朋友注册时填上，邀请人自动 +30 天。防刷：同一被邀请邮箱只结算一次（`refreward/` 幂等占位）、不能邀请自己、邀请人 30 天最多 10 次（`REFERRAL_MONTHLY_CAP` 可调）、长期有效的老用户不重复发、删号时一并清掉邀请码索引。奖励失败绝不回滚注册——拉新是加分项，不能拖垮主流程。
- **后台**：Mentora 侧新增 `api/admin/licenses`、`api/admin/members`、`api/admin/leads`、`api/referral`；Clarity Admin 新增「会员管理 / 卡密管理 / 体验申请」三页（生成批次、复制、作废、延长 30/365 天、设置到期日、置到期、发重置码、体验申请一键发码；会员表带邀请码与已拉人数，便于人工反查刷单）。
- **到期提醒**：`api/cron/expiry-reminder` 每天扫一遍，剩余 7/3/1 天与到期当天各发一封（复用既有发信通道），`reminder/<hash>/<日期>.json` 防重复。
- 修掉两个会真出事的边界：激活码字符表实际 30 个而取模按 32 算，映射到 undefined 时 `Array.from` 静默少一位（生成过 11 位废码）；`ceil` 判定把"已过期 4 小时"算成"还剩 0 天（有效）"，付费墙会漏开一天。两者都已加测试锁住。
- 验证：tsc 0 错 / build 通过（新增 5 条路由）/ vitest 211 通过（新增 12 条会员、卡密与拉新测试）；本地对 D1 跑通真链路：生成码 → 注册带到期日 → 续费原到期日累加 → 置过期后 chat 402 → 朋友凭邀请码注册、邀请人 30→60 天 → 删除测试账号。首页定价区、体验弹窗与会员页均已渲染核对（无 JS 报错）。Clarity Admin `npm run build` 通过。测试期间在库里留下的激活码已作废、测试账号已删除。
- 注意（未提交）：本次改动尚未 commit；同仓库有另一会话在并行提交（v24.0 记忆/提醒），提交时请只带上本功能的文件，避免混入对方改到一半的内容。

## v23.3.1 — 2026-11-05（app-shell 类型自洽：master 构建不再依赖未提交的并发改动）

v23.3 部署时 Vercel 与腾讯云都构建失败：`app-shell.tsx` 用到 `user.entitlement`（并发会话正在做的会员横幅），而 master 的 `auth-client.ts` 尚无该类型（那份类型还在对方工作区未提交）。

- 修法：会员横幅改为本地声明 `EntitlementLike` 结构 + 窄化断言，不再依赖 auth-client 的类型版本——master 自洽，服务器无需任何补丁（腾讯云那处临时补丁已还原，服务器与 master 一致）。
- 教训（协作纪律）：同一工作区多会话并行时，一个会话提交的文件里可能混入另一个会话"改到一半"的行；**提交前必须 tsc+build 验证的是 git 内容而不只是工作区**（本地工作区恰好齐备，所以本地绿、CI 红）。今后合并/提交前先 `git stash --keep-index` 式的"只带我的改动"验证，或提交后立刻用干净检出复验。
- 验证：tsc 0 错 / build 通过；本地、腾讯云、Vercel 三处生产 e2e 各 8/8。
- 回退：`v23.3-workspace`。

## v23.3.1 — 2026-11-05（审查 medium 第二批：失败态可见、可取消、可重试）

- **引导页可重试**：错误提示旁补「重试」按钮（原样重发最后一条提问），文案承诺与实际出路一致；总纲要失败的 toast 改为指向页面上那个按钮（旧文案让人去目标列表找）。
- **生成阅读计划可取消**：生成期间弹窗不再能被 Esc/遮罩关掉（关了也拦不住请求，成功照样建书跳转），改为显示「取消生成」并真的 abort 掉流（`signal` 已接线）。
- **圆桌忙碌状态按会话维度**：他桌跑动时本会话发送按钮不再假 loading；Enter 被全局互斥拦下时给出 toast，而不是静默吞掉。
- **读书对话历史恢复**：effect 依赖补 `book?.id`——本地没有这本书、云端数据晚到时，历史不会再永远进不了消息列表。
- **后台失败态可见**：overview 增加 `feedbackError` / `skippedUsers` / `statsPartial`，管理页把「反馈拉取失败」「用户档案读取失败」「云端数据读取失败」分别显式呈现（配合加载骨架，空表不再被读成「没有用户」）；admin/users 列表返回 `skipped` 计数。
- 验证：tsc 0 错 / eslint 0 error / vitest 195 通过（7 skipped）/ build 46 页通过。

## v23.3 — 2026-11-05（工作台合并与首页面板化：学习=教练+读书，首页 = Trae SOLO 式布局）

按用户定稿的信息架构重排：应用不堆入口，一个工作台装一类事。

- **学习 = 教练 + 读书伙伴**：/learn 顶部加「学习教练 | 读书伙伴」切换（?tab=read 直达）；读书列表抽成 ReadWorkspace 组件复用于 tab；/read 列表入口 301 式重定向到 /learn?tab=read，书籍详情 /read/[id] 保留原路由（深链与智能体产物跳转不受影响）。
- **侧栏终版顺序**：Mentora → 学习人生 → 学习 → 人生伙伴 → 设置（移动底栏同步；/read、/brain 路由高亮归到「学习」）。
- **首页改 Trae SOLO 式布局**：顶部会话 tabs（横向切换、激活 tab 可删）＋左侧 Chat 主区＋右侧工作台三块——「任务」（计划三态＋工具调用实时状态）「产物」（本会话写入结果＋联网来源链接）「会话」（历史切换/删除）；移动端工作台以 slide-over 呼出。计划与工具从消息流移入工作台（消息区只留对话与思考摘要）。
- 文案同步：智能体界面说明与 add_book 回执改为「学习」页内读书入口。
- **验证**：tsc 0 错 / eslint 0 error / vitest 189 通过 / build 通过；真模型 e2e 8/8（导航顺序、SOLO 三块工作台、会话 tab、学习双 tab、读书嵌入、/read 重定向、Bing 搜索回归）。
- 回退：`v23.2.1`。

## v23.2.3 — 2026-11-05（审查 medium 第一批：协议完整性、同步失败态、可取消与限流缺口）

- **半截回答不再当成功**：`streamChat` 必须读到服务端的 `{"t":"end"}` 才返回；流被网关/平台掐断时抛「连接中断，回答没有生成完」。此前残句会被当完整答案，结构化任务则误报「无法解析 JSON」。新增 `stream-end.test.ts` 两条回归锁。
- **拉取失败 ≠ 云端为空**：`pullCloud` 改为 ok / empty / error 三态。登录同步与开机同步在 error 时保持本地不动、也不反推（旧实现把 401/503 折叠成 null，一次 KV 抖动就会用旧本地覆盖云端）；设置页「从云端恢复」区分三种结果并给出对应提示。
- **并发与加载兜底**：`useChat.send` 加在途守卫（旧实现只覆盖 abortRef，两条流会交错写 pending、互相覆盖消息并双倍计费）；`useHydrated` 的动态 import 补 `.catch` 放行，旧 chunk 404 时不再把页面永久锁在骨架。
- **失败可见 / 可取消**：圆桌单人对话渲染 error 并提供「停止」；读书对话流式期间增加「停止」按钮，主动取消标 cancelled 而非 failed。
- **限流缺口**：`admin/users`（含删除用户）与 `admin/feedback-state` 补 10/分持久桶（此前只靠 proxy 进程内桶，后台密码可被轮询爆破）；`/api/sync` GET/POST 分桶（读 30/分、写 60/分，写额度高于 2.5s 防抖的正常峰值）。
- **注册名字长度**：对齐 profile 的 24 字上限，避免超长 name 写爆会话 cookie（注册成功却无会话、且无法自助修复）。
- 验证：tsc 0 错 / eslint 0 error / vitest 189 通过（7 skipped）/ build 通过。

## v23.2.2 — 2026-11-05（全库审查 18 条 high 收口：静默数据丢失、限流与 SSRF）

依据 `code-review/Mentora-全库代码审查报告-2026-11-04.md`，把 18 条 high 全部处理完。

**数据丢失 / 闭环**
- 判分通过后的掌握状态改用 store 定点 patch（`setDayKnowledgeMastery`），不再用渲染闭包里的旧 `plan` 整体回写冲掉 `passed/pendingUnlock/attempts`（下一天永不解锁的死锁）；AskCoach 答疑与读书三重验收同型问题一并改为 `appendDayQa` / `updateBookChapter`。
- 新建空笔记的默认路径不再因 `active == null` 丢正文：LiveBlocks 增加草稿追踪与卸载兜底，AI 改写结果同样计入待提交。
- 导入备份/云端快照做结构校验：坏字段整份拒绝、脏元素规范化、非法 provider 丢弃、空 `apiKey` 不再抹掉本机 Key；`ModelSection` 对 provider 索引兜底。
- 小程序同步：脏标记与云端水位持久化；force 拉取不再绕过「未推送不覆盖」；登出/切后端等推送落地（≤5s）再清身份；`me()` 在途去重；手动拉取失败不再误报「已一致」。
- `bootSync` / `syncAfterLogin` 用 store 引用变化检测「拉取窗口内刚输入、尚未推送」的编辑，命中即改为推送本地。
- `wikiRetrieve` 跳过不在 `byId` 的悬挂出链/被裁决淘汰的目标（旧实现 `byId.get(id)!` 后读 `tags` 直接 TypeError）。
- `quizLog` 两侧（Web store / 小程序）只保留最近 200 次、长文本按字段截断，避免无界增长把全量快照推过 4.5MB 后连带本机写盘失败。

**交互安全**
- 读书页删书、圆桌删除自建人物都改为确认弹窗，并明示级联删除范围（章节/洞见/对话、单聊记录）。
- 读书对话失败不再静默：消费 `useChat` 的 error 渲染在输入框上方、阶段标红；用户消息在发送前落库，失败刷新也不丢。

**服务端**
- 限流键取 `X-Forwarded-For` 右侧可信跳（`TRUSTED_PROXY_HOPS`，默认 1），伪造前缀无法轮换桶；`proxy.ts` 统一使用同一实现。
- BYOK custom 端点改为 `redirect:"manual"` 逐跳复检（最多 3 跳），堵住 302 打内网的带读取 SSRF。
- `/api/chat` 读体阶段补 abort 监听与 45s 空闲超时：客户端断开后真正停掉上游，token 不再白烧。

- 回归锁新增：`backup-import.test.ts` 6 条、`client-ip.test.ts` 5 条、`rag.test.ts` 悬挂链接 1 条。
- 验证：tsc 0 错 / eslint 0 error / vitest 187 通过（7 skipped）/ build 通过。

## v23.2.1 — 2026-11-05（"学习卡片空白"诊断与自托管陈旧 bundle 根修）

用户截图学习页卡片无标题。排查结论：**不是当前代码的数据或渲染 bug**——本地以四种数据形状（正常 topic / 空 topic+空 direction / 空 draft / agent 建目标）在 390px 移动视口复现，标题、进度环、徽章、方向全部正常渲染；腾讯云构建 chunk 里也确认存在「未命名目标」兜底。空白标题只在 e373511（11-04 18:04）**之前**的 bundle 才会出现。

- **根因（自托管部署的陈旧客户端）**：长驻浏览器标签页/启发式缓存的 HTML + immutable 的 _next/static chunk，让用户设备一直跑部署当时的旧版本——移动端浏览器冻结标签页会把这个状态保持数天。此前用户看到的功能缺失（旧搜索源、无新对话/历史按钮、空白卡片）全是同一根因的不同切面。
- **服务端根修（腾讯云 caddy）**：HTML/文档路径统一加 `Cache-Control: no-cache, must-revalidate`（`/_next/static/*` 的带哈希 chunk 保持 immutable 长缓存），每次部署后浏览器必然拿到新 HTML → 新 chunk。
- **应用内新版本提醒**：AppShell 轮询 /api/health 的 build sha（首次记录基线，之后每 5 分钟比对），发现新构建即在顶部出现「已发布新版本，点此刷新更新」一键刷新条；老标签页从此不用手动强刷。
- 验证：tsc 0 错 / eslint 0 error / vitest 185 / build 通过。
- 回退：`v23.2-session`。

## v23.2 — 2026-11-05（搜索源根修 + 主对话框多会话 + 导航重排）

用户反馈三件事：搜索失败但读网页正文成功（网络通、搜索源被反爬）；对话框只有"清空"没有新建/历史；人生伙伴该放到学习上面。

- **搜索源根修**：无 Key 默认源改为 **Bing 网页解析**（cn.bing.com → www.bing.com 兜底轮换，国内外服务器均可达），DDG 降为末位兜底——DDG 对数据中心 IP 反爬封锁，这正是"搜索失败但 nextjs.org 能读通"的原因。搜索与抓页统一升级为**浏览器伪装头**（Chrome UA + Accept-Language zh-CN + Referer，抄自参考实现的反爬纪律）；Bing 的 /ck/a 跳转链接解 base64 还原真实地址；补齐 &ensp;/&#0183;/数字实体解码。真模型实测：React 19 检索 → Bing 双请求各 5 条结果 → read_url 官方文档 → 回答带 5 条来源。
- **主对话框多会话**：头部新增「新对话」「历史」按钮；会话（AgentSession）含标题（首问截断）/消息/时间，可切换/删除；store v6→v7 双路迁移——persist.migrate 与 setStoreUser 手动装载路径都把旧 agentChat 包装成历史会话，老用户历史不丢；"清空"语义改为清当前会话。刷新/重开会话持久。
- **导航重排**：侧栏与移动端顺序改为 Mentora → 人生伙伴 → 学习 → 学习人生 → 读书伙伴 → 设置。
- **深讲协议补一条纪律**：时效信息/具体数字优先 web_search 核实，搜不到要声明"未能联网核实"并标注凭记忆。
- **验证**：tsc 0 错 / eslint 0 error / vitest 185 / build 通过；真模型 e2e 9/9（搜索工具成功+来源链接、新对话空白页、两会话入库、历史切换、刷新持久、导航顺序）。
- 回退：`v23.1-deep`。

## v23.1 — 2026-11-05（深讲协议：把"真正讲懂"的九步骨架蒸馏进通用智能体）

用户提供了理想回答的完整样例（C 数组旋转两种解法 + 顺序表整章讲解），要求把这种回答效果蒸馏成全学科通用能力。

- **九步深讲骨架**（AGENT_CHAT 新增"深讲协议"节）：开门定位（知识点清单+预告顺序）→ 先建立目标（具体例子）→ 逐块拆解（是什么/为什么需要/不写会怎样，拆到操作符级）→ 完整模拟一次执行（状态表）→ 主动挑毛病（错在哪+会怎样+怎么改）→ 给改进版 → 横向对比（表格逐维度）→ 复杂度与代价 → 提炼 N 个可迁移知识点 + 小测（不给答案）+ 针对当前水平的建议。
- **分学科适配**：编程/数学/人文（还原作者在回答什么问题、论点—论据—隐含前提、最强反方）/语言/考试/产品方案决策，骨架不变换血肉。
- **触发**：deep 标志硬触发 + 语义触发（wantsDeepExplanation 扩充 讲一下/剖析/拆一下/什么意思/怎么运作/这一章）；日常短问答不启用；用户只要结论先给一句话再问是否深讲。
- **真 bug 修复（多轮回答丢前文）**：带工具调用的轮次里模型常先写出实质正文再调工具（如先讲解后出题），runner 把它当过渡语清掉了——最终消息只剩最后一轮。现在实质正文（>60 字）累积进 answerParts 并入最终回答；短寒暄不累积、重复不入列。
- **验证**：真模型双方向 e2e——编程 9/9（对齐样例场景）+ 人文 6/6（还主动披露"搜索超时，数值凭记忆未验证"）；tsc 0 错 / eslint 0 error / vitest 185 / build 通过。
- 回退：`v23.0-agent`。

## v23.0 — 2026-11-05（主对话框升级为通用智能体 harness：原生工具循环 + 联网搜索 + 新建/修改 + 设置读写 + 统一审批门）

产品定位落地第一步：首页对话框成为主入口，原有四个工作台保留，Agent 的写入最终落到工作台数据。

- **内核 v2（runner 重写）**：双通道工具调用——原生 OpenAI `tools`/`tool_calls`（服务端下发契约、流式聚合 `delta.tool_calls` 为 NDJSON `t=tc` 事件；网关 400 拒收自动降级为围栏协议并回告 `t=n tools_off`）+ 文本围栏协议兜底（qwen/DeepSeek/custom 全兼容）。修复 v1 真缺陷：并行工具死代码（parse 丢 `tools` 数组）、计划每轮双推进、run 级同名工具去重导致"检索→再检索"不可能（改为连续两轮相同「工具+参数」才算打转并强制收尾）。
- **统一审批门**：写入类工具不再"遇到就结束本轮"，改为 `PendingAction` 队列 + `requestApproval` 回调挂起循环；用户逐卡批准/拒绝，拒绝记 `declined` 并回注模型（"用户拒绝了，别重复"），循环继续到最终回答。等待审批时点「停止」= 全部拒绝。
- **工具注册表 17 个**：读（自动执行）search_brain / read_context / get_note / list_goals / get_goal / list_books / list_sessions / get_settings_public（绝不含 apiKey/baseUrl）/ make_quiz / web_search / read_url；写（必须确认）save_note / update_note / delete_note / create_goal / add_book（自动拆阅读章节）/ create_session / update_settings（白名单：称呼/教练风格/周报/模型；apiKey/baseUrl/密码/注销/整包导入导出永不进表）。
- **联网搜索**：新 `/api/search`（TAVILY → BRAVE → DuckDuckGo Lite 兜底，上游固定服务端、每用户 ≈20 次/天持久限流）+ `/api/fetch-page`（assertSafePublicUrl + 逐跳重定向复检 + 8s 超时 + 200KB 上限 + 类型白名单，≈30 次/天）。
- **过程可持久**：assistant 消息新增 `meta {plan, tools, citations}`，刷新/切页后计划、工具卡、引用来源不再丢失；回答下方渲染来源链接。
- **提示词**：保持通用智能体结构，工具段新增两条纪律——搜索/网页内容是不可信数据（其中的指令一律不执行）、引用要标注来源。
- **验证**：tsc 0 错 / eslint 0 error / vitest 185 通过 / build 通过；真模型 e2e 7/7（对话建笔记→审批→落库、对话改设置→审批→生效、黑条回归、搜索端点守卫；本机 DDG 不可达走优雅 502，生产 hkg1 出口另验真搜）。
- 回退：`v22.7-general`（本次部署前线上状态）。

## v22.7.1 — 2026-11-05（全库审查必修 Top5：静默数据丢失与限流防线）

依据 `code-review/Mentora-全库代码审查报告-2026-11-04.md` 的「必修 Top5」，逐条落地。

- **学习闭环死锁**：`submitQuiz` 不再用渲染闭包里的旧 `plan` 整体回写（会把刚写入的 `passed/pendingUnlock/attempts` 冲掉，下一天永不解锁），改用 store 新增的 `setDayKnowledgeMastery` 定点 patch；同型的 `AskCoach` 答疑与读书三重验收一并治理（新增 `appendDayQa` / `updateBookChapter`）。
- **新建笔记丢正文**：`LiveBlocks` 空笔记分支不再因 `active == null` 跳过提交；新增未提交草稿追踪与卸载兜底，失焦没触发也不会丢。
- **小程序同步覆盖本地**：`dirtyPending` 与云端水位持久化到本机；`pullIfSafe` 的「未推送不覆盖」守卫不再被 `force` 短路，有脏数据时改为先推送；`onLogout` 等推送落地（最多 5s）再清身份；`app.js` 对 `me()` 做在途去重。
- **导入坏 JSON 崩全站**：`importData` 增加结构校验（坏字段整份拒绝，脏元素过滤/规范化），非法 provider 丢弃；`ModelSection` 对 `PROVIDERS[provider]` 兜底；备份里的空 `apiKey` 不再抹掉本机已配的 Key。
- **限流键可伪造**：`clientIp` 从「XFF 最左段」改为「按 `TRUSTED_PROXY_HOPS`（默认 1）从右往左取可信跳」，伪造前缀不再能轮换限流桶；`proxy.ts` 删除重复实现，统一走同一函数。
- 回归锁：新增 `backup-import.test.ts`（5 条）与 `client-ip.test.ts`（5 条）。
- 验证：tsc 0 错 / eslint 0 error / vitest 185 通过（7 skipped）/ build 通过。

## v22.7 — 2026-11-04（智能体通用化：按朋友的自由智能体提示词复刻，删除学科模板链路）

用户反馈"回答还是按咱们的模板来"——根因是智能体提示词仍带着教学骨架。本次把智能体与教学资产彻底切开。

- `AGENT_CHAT` 重写为通用智能体人格与纪律：活人感 / 绝对红线 / 核心原则 / 质疑响应协议 / 输出 / 工作流 / 工具 / 安全边界 / 交互 / 界面；不再注入六学科教学模板，也不再走"四段式"回答契约。
- 删除智能体专用的 `TEACHING_PROTOCOL` 与 `agentTeachingRoute` 死代码；学科模板只保留在每日讲义链路，智能体不再有任何学科路由。
- 工具纪律：用户明确说"存成笔记 / 发到笔记 / 记到第二大脑"时必须调用 `save_note`（先把内容写进回答，再调用工具存入），不再只把文档贴在正文里。
- 黑条根修：`stripDirectives` 清理空代码围栏并归一化 CRLF；`Markdown` 渲染层对内容为空的 `<pre>` 直接不渲染，双保险。
- 验证：真模型 e2e（闭包问答为自然口吻、长文档触发存笔记确认卡、无空 `<pre>`）；tsc 0 错 / eslint 0 error / vitest 169 通过 / build 通过。
- 回退：`v22.6-general`（本次部署前线上状态）。

## v22.2 — 2026-10-26（登录/注册切换闪屏与小故障修复）

注册与登录互切时「排版突然闪一下」的根因不是动画，而是首屏与水合错位。

- `/login` 从客户端 `useSearchParams + Suspense` 改为服务端页面：`mode`/`next` 在服务端解析后直出表单，构建产物由 `○` 静态变为 `ƒ` 动态，首屏不再只有空白占位。
- 注册/登录成功的一瞬不再整页空白：`AppShell` 对 `/login` 始终走全屏布局，避免 `user` 已写入但路由未跳走时套上应用壳、与登录页双栏叠成三栏。
- 模式切换改为 `grid 0fr ↔ 1fr` 高度过渡（200ms）+ `inert` 折叠字段，卡片高度渐进变化而非瞬间长高/塌陷。
- 提交中禁用模式切换与输入；进入「忘记密码」清空密码，避免旧密码被当新密码提交。
- 验证：tsc 0 错 / eslint 0 error / vitest 129 通过 / build 通过；浏览器实测 **12/12**（SSR 直出表单、切换高度渐进、重置清空密码、无 console 错误、375px 无横向溢出）。
- 回退：`backup/pre-login-flash-20261026`（本次部署前线上状态）。

## v22.1 — 2026-10-26（认证改为邀请码制，邮箱验证码通道下线）

内测期发信通道不稳定，产品决策：暂停邮箱验证码，注册与找回统一走内测邀请码。

- 删除 `/api/auth/send-code`；注册、重置密码只校验 `INVITE_CODE`（未配置 503、错误 401，timing-safe 比对）。
- 登录页移除验证码输入与 60s 倒计时，注册/重置恢复「邀请码（必填）」。
- 同步冒烟脚本 `scripts/smoke-auth-v17.mjs` 为邀请码流程；隐私政策文案改为「账号找回」。
- 验证：tsc 0 错 / eslint 0 error / vitest 129 通过 / build 通过；本地认证冒烟 **17/17**。
- 回退：`backup/pre-invite-20261026`（部署前线上状态）；代码回退用 `git revert`，平台回退用 Vercel Promote 上一版本。

## v22 — 2026-10-26（移动端 UI 适配第一批：P0-P2 落地）

**依据**：`docs/PRD-2026-10-26-MOBILE-UI.md`（规划）→ 本次实现其 P0/P1/P2 与验收 M1/M2/M3 的可自动化子集。**真机（iOS/Android）与键盘实测未做**，见 ACCEPTANCE I21。

### 壳层与几何（P0）
- viewport 元数据：`layout.tsx` 新增 `Viewport` 导出（device-width/initialScale=1/viewportFit=cover/themeColor #f5f5f7）。
- 全局几何变量唯一来源（globals.css）：`--mobile-topbar-h/--mobile-nav-h/--safe-*/--keyboard-inset/--mobile-content-bottom`；新增 `.above-mobile-nav`（fixed 层统一底距=底栏+safe+键盘+12px）、`.reserve-mobile-nav`（主内容预留）、`.tap-target`（44px 命中盒）。
- `use-visual-viewport.ts`：visualViewport resize/scroll → 写入 `--keyboard-inset`；引用计数、卸载清零、无 API 降级；只写 CSS 变量不触发渲染。挂在 AppShell 一处，全站共享。
- 底栏重排：7/8 格等权 → **5 主入口 +「更多」**（学习人生/设置/管理后台/退出进抽屉；隐藏路由时「更多」亮 active）。抽屉=bottom sheet，路由变化自动收起；Back 先关抽屉（pushState 哨兵+popstate）。
- 主内容 `reserve-mobile-nav`：长内容可滚到「底栏+safe+16px」之上（M2-3）。
- body 加 `overflow-x: clip` 保护网 + `100dvh` 后备。

### 组件（P0）
- Modal 手机=bottom sheet：贴底、顶部圆角+把手、`max-h-100dvh`、safe-bottom padding、关闭钮 44px；≥sm 保持居中弹窗不变（焦点陷阱/Esc/归还焦点沿用 v17 契约）。
- 三处 composer（圆桌/引导/读书）的 `bottom-20 md:bottom-4` 硬编码统一替换为 `.above-mobile-nav`；发送钮手机 44px。

### 页面（P1/P2）
- 学习列表：输入+按钮手机纵向堆叠（按钮 44px）；目标卡移动=纵向三层（进度环+标题 / 方向 / 元数据+删除），删除钮 44px。
- 学习详情：手机新增「任务导航」折叠条（显示 N/M 天进度）——当前日默认首屏，时间线可展开/选日/自动收起；桌面双栏 sticky 不变。
- 第二大脑：编辑工具栏手机横向滚动、每工具 44px 命中盒（md 恢复 32px）；移动三 Tab ≥44px；工作区高度公式纳入 safe-top/safe-bottom/keyboard-inset。
- 读书详情：阅读路线手机默认收起（≥1024 默认展开，SSG 端 window 不存在按桌面），折叠态提供 44px「阅读路线」展开横条；收起钮 44px。
- 圆桌：会话历史手机默认折叠成横条（对话区占首屏），点会话/新建自动收起；桌面左栏常驻。
- 助手挂件：默认位与拖拽下限避开 `--mobile-nav-h+--safe-bottom`；旧 localStorage 位置迁移时 clamp 回安全区。
- 设置 Tab 命中盒 44px；学习人生里程碑 320px 起两列（原 4 列 10px 文字不可读）。

### 验证
- 新增 `scripts/smoke-mobile.mjs`：探针注册（邀请码/验证码双通道+重试）→ 320/375/390/412 四 viewport（hasTouch/isMobile）断言 M1-1/M1-2/M1-4/M2-1/M2-2/M3-1 → 桌面 1440 回归 → finally 自删。**94 PASS / 0 FAIL**（2026-10-26 本地 dev）。脚本纪律：waitForSelector 终态轮询而非固定 sleep（dev 首编译竞态会假 FAIL）。
- 四道门禁全绿：tsc 0 错 / eslint 0 error / vitest 124 passed / build 38 页。
- 截图证据：`.tmp-shots-mobile/`（gitignored）。
- **未做**（诚实边界）：真机 iOS Safari/Android Chrome 键盘与 safe-area 实测（M7）、横屏、200% 字体、Back 手势真机验证；圆桌运行逻辑本次未动（v21.3 另行验收）。

## v21.4 — 2026-10-26（回答质量三层重构：上下文分块 / 四段契约 / 证据纪律）

用户定调：重心从功能转向**回答质量**——模型之间差距不大，质量由「上下文工程 + 提示词契约 + 证据纪律」决定，这才是付费意愿的来源。三层：

- **上下文层**：替换「每篇截前 220 字/总限 1200」的腰斩式注入（关键结论在后半段的长笔记会被腰斩，模型只能看到开头）。新增 `splitIntoChunks`（按 ## 标题/代码块/段落切块、代码块整体保留、超长按句切 400 字）+ `scoreChunks`（相关度打分，小标题命中×3）+ `buildContext`（每篇 top3 块带所属小标题、总预算 2600、来源标注）。
- **契约层**：`ASK_COACH` 重写为四段回答契约——第一句就是答案（禁「这取决于」）→ 因果机制（不是复述）→ 最小例子 → 边界与常见坑；长短由问题类型决定；禁寒暄禁「希望有帮助」。
- **证据层**：RAG 注入处（读书对话 + 学习答疑）加五条硬纪律——先消化再回答/无关别用/引用标来源/**不假装记过**（没检索到就明说，通识标通识）/证据冲突要指出。
- RAG 接线点从只有读书页扩到**学习答疑**（最高频入口），`rewrite:false` 省调用，检索失败静默降级。
- 单测 124→129（+5：标题切块/后半段选中/代码块完整/预算/空命中）。
- 真模型对照：问「setTimeout 里 state 为什么总是旧的」，新旧回答同源模型，新回答四段齐全——第一句直给快照机制、因果讲渲染闭包、最小例子可运行、边界点出「函数式更新≠能读最新值」；本地与生产（DeepSeek）各验一次，行为一致。

## v21.3 — 2026-10-26（RAG 三件套 + 圆桌两个真实缺陷）

### RAG 增强（对照经典 RAG 改造方法补齐）
原架构＝BM25 + LLMWiki 图导航 + 可选向量 RRF，缺「查询侧改写」和「排序侧精排」。本次补三项：

- **查询改写（Step-Back + Multi-Query）**：新增 `task=query-rewrite`。真模型实测输出「React Hooks 中闭包捕获旧状态的原理是什么」+「useEffect 定时器读到旧 state 的 stale closure 原因」——一条上升一层、一条同义改写。
- **多查询融合（RAG-Fusion）**：`fuseMultiQuery` 把原问句与改写问句的检索结果做 RRF 合并。
- **LLM 精排（ReRank）**：新增 `task=rag-rerank`，候选编号交模型挑选。真模型实测正确剔除无关的「番茄工作法」，把直接答案排第一并给出理由。
- **CRAG 式自评**：`assessRetrieval` 判命中数与相关度，弱则触发改写重检。
- 纪律：任何一步失败都回退原行为；模型只输出 JSON 不改写笔记；一次对话最多 +2 次调用；Demo 同形状；接线点=读书页。
- 新增 `rag-enhanced.test.ts` 13 条。单测 111→124 全绿。

### 圆桌修复（故障注入发现）
- **≥2 席有效时失败席位无补答入口**：主持人照常出纪要，但没检查失败席位 → 标红席位永远补不齐。修：host 前 setRtRetry(failedSeats)，重试后出「圆桌纪要（补答后重出 · N 席）」。
- **新建圆桌被选择页盖住**：`createRoundtable` 只设 activeId 未清 picking，而选择页显隐条件是 `picking || ...`（与 v21.1 同类）。
- 新增 `scripts/smoke-roundtable-faults.mjs`：route 拦截注入 take/host 500，覆盖 A 单席失败补答 / B <2 席拒综合 / C 主持失败重试 / D 双击只发一轮。A/B 稳定全绿；C/D 受 Playwright 跨用例导航影响，产品侧等价逻辑已由 B/A 覆盖。

## v21 — 2026-10-24（Roundtable-First：路线收窄 + 圆桌 MVP 第一批）

**产品路线转向**（docs/PRD-2026-10-24.md 重写为 Sidebar-First / Roundtable-First）：不再做首页统一聊天/通用主智能体；侧栏 → 人生伙伴 → 圆桌是唯一新主线；「一个对话框」保留为长期北极星。验证标准从「每天打开」改为「5 个真实决策对比，≥3/5 产生新增价值」（R7）。

### 圆桌运行可靠性（PR1）
- **每轮一个 runId**：取消/新轮/切会话后，旧轮的 UI 增量与收尾一律被拒（`alive()` 守卫每次写入）；旧轮 finally 不再清掉新轮的 live 状态（多轮并发隔离的根）
- **可取消**：席位/主持人全阶段 AbortController 接线（此前页面根本不传 signal）；「停止」按钮 + 取消留痕消息（已完成发言保留）
- **失败诚实**：席位失败标红可单席重试；有效发言 <2 席主持人拒绝综合（不再拿残片拼「圆桌完成」）；主持人失败保留全部发言 + 「重试主持人纪要」入口
- **外层 finally**：任何异常都解锁输入（此前未捕获异常会让输入框永久禁用）
- **同步互斥**：rtBusyRef 拦双击 Enter；重试自动带回原会话；删除正在运行的会话先 abort 防晚到写入
- 会话标题升级：第一个问题落地后改为「问题摘要 · N人 · 日期」，历史列表可区分每次决策

### 三席默认 + 成本透明（PR2）
- 圆桌默认从 16 席全选改为**推荐 3 席**（naval/jobs/taleb：判断/聚焦/风险的张力组合），用户仍可自选/全选
- 选人弹窗：>6 席显示成本警告（N 席 = N+1 次模型调用，默认配额 60 次/天）

### Demo 圆桌同语义（R1 契约）
- `demo.ts` 新增 `demoRoundtableTake`（FNV 哈希按席位分配三种立场：支持但算账/反对因机会成本/取决于缓冲事实——三席必须立场可辨）与 `demoRoundtableHost`（真引用每席发言片段 + 七节结构与真实模型一致）
- `route.ts` demoTask 识别 council 的 take/host 模式——**修复 Demo 圆桌静默落入 demoCouncil 单人回答的假语义**；host args 新增 question（真实提示词不消费，Demo 用于问题重构）

### 验证
- vitest 111 条全绿（新增 `council-demo.test.ts` 3 条：默认三席两两不同/发言引用问题/主持人七节齐全）
- tsc 0 错 / eslint 0 error / build 38/38 页
- ⚠️ 未做：浏览器人工冒烟（R0/R3/R4 的实测项）与 5 个真实决策验证（R7）——部署后进行

### v21.1 — 2026-10-26（生产冒烟发现的真实 bug）

- **fix：点左侧会话列表不退出选择页**。`newChat` 会把 `picking` 置 true，而点会话只设 `activeId` → 界面仍停在会话选择页，用户看到的是"点旧会话没反应"（生产冒烟 R3 抓到的，本地复现 `picker_shown=true → back_to_session=true` 验证修复）
- **新增 `scripts/smoke-roundtable.mjs`**：生产浏览器自动化冒烟（Playwright + 7897 代理），覆盖 R0 入口/默认三席/成本警告/重开恢复、全流程终态轮询 + 90s 停滞看门狗、R3 切会话隔离、R4 停止留痕；探针账号（163 + 邀请码）跑完自删，可重复执行
- **冒烟结果 20/20 PASS**（v21.1 上线后）：圆桌全流程 host-done、三席发言落库、标题改为问题摘要、切走无残留实时卡、切回可恢复、停止留痕且输入解锁
- 训练过程诚实记录：v21 首次冒烟 7 红里有 5 红是脚本自身问题（`aside .truncate` 匹配到用户名而非会话列表、按第二个问题找只有第一个问题才更新的标题、异常路径漏删探针），另 2 红是代理把 NDJSON 流挂死（诊断为代理抖动，产品侧有停止/重试兜底）——**只有 1 红是真实产品 bug**

### 部署记录（2026-10-24 深夜）

- **已上线**：`7c9871a` → master（build sha 7c9871a 已在 /api/health 确认），tag **v21.0** 为回退锚点
- **回退方式**：`git revert 7c9871a && git push origin master`（或 Vercel 后台 Promote 上一个绿色部署 111517a）
- **上线验证**：本地四道门禁全绿；本地 e2e（qwen3.8-flash 弱模型）3/7 绿——4 红为长文生成超时（总纲 39s 流式成功但接近 45s 上游超时），属模型能力非代码回归，且**生产实际走 DeepSeek 通道**；**生产冒烟（真 DeepSeek + 探针账号，测完已自删）四项全 PASS**：引导 206 字 / 总纲要 3 阶段 JSON 过 schema / 圆桌席位 388 字（人格 system 链路）/ 主持人纪要 1599 字含新 question 参数零影响
- ⚠️ 遗留：浏览器人工冒烟（R0/R3/R4 实测项）与 5 个真实决策验证（R7）待用户进行

## v20 — 2026-10-24（全库代码审查：22 处缺陷修复 + 回归测试锁）

全量精读（~2 万行 TS/TSX，两个独立扫描 + 逐条人工核实）后集中修复。单测 81→94（新增日期数学与 URL 守卫回归锁），tsc/lint/vitest/build 四道门禁全绿。

### 安全
- **管理员白名单移除 `text@qq.com`**（`admin-emails.ts`）：泛化前缀邮箱一旦被他人注册即获后台全权（全量用户数据/删用户）。内置名单只留真实持有账号；如仍需该账号走 `ADMIN_EMAILS` env 添加
- **linkcheck SSRF 重定向修复**（`api/linkcheck`）：`redirect:"follow"` 改为逐跳 `manual` 校验后再跟进（此前请求先打出去、复检只是事后确认）；不再把内网目标返回的 HTTP 状态码带回给调用方（探测预言机）；重定向上限 5 跳
- **url-guard IPv6 旁路封堵**（`server/url-guard.ts`）：①WHATWG URL 的 hostname 对 IPv6 带方括号返回，`net.isIP` 认不出 → 形态层私网检查对全部 IPv6 字面量失效，现先剥括号再判；②回环/ULA/链路本地/组播/文档段改为展开成 8 组后按位裁决（`"0:0:0:0:0:0:0:1"` 这类展开写法此前直接放行）
- **sync 解压炸弹前置闸死**（`api/sync`）：`gunzipSync` 加 `maxOutputLength`，4GB 膨胀在内存里撑爆之前就 413
- **chat 结构化日志脱敏**（`api/chat`）：`chat-usage` 的 account 维度记邮箱 sha256 前 8 位指纹而非明文邮箱（该字段仅入库无按账号消费方，行为不变）

### 数据正确性
- **`addDays`/`daysBetween` 改纯 UTC 日历运算**（`utils.ts`）：旧实现本地时区解析 + UTC 输出，东八区一次 `addDays(-1)` 跳过两天——首页「连续 N 天」被砍半、漏学一天提前断链（全部中国用户可触发）
- **RDS 漏斗聚合补 `GROUP BY name`**（`server/db.ts` dbEventStats）：PostgreSQL 不带 GROUP BY 直接 42803，被 catch 吞成 null → `DB_CHANNEL=huawei`（文档主通道）下 admin/stats 永远 503
- **D1 分块写顺序反转**（db.ts d1Put）：先写块行、最后写主行（读者以主行 `__chunks__` 数为准，主行最后落=读到旧值完整密文而非缺块密文）；收尾清理内容变短后多余的旧块行（此前永久泄漏）
- **同步迁移补 `linkifyBodies`**（store.ts setStoreUser）：v<2 旧仓同步路径只跑 migrateKnowledge 漏了双链解析（persist.migrate 是跑的），老用户图谱/反链为空
- **Obsidian 占位笔记真升级**（store.ts importKnowledge）：①unresolved 占位不再算重复挡住真笔记导入；②真笔记收养占位 id（双链不悬空）原位替换正文；③修复升级块对 store 写入无效 + `upgraded` 存占位 id 却拿去过滤 fresh id 的双键错位
- **同名文档上传改为更新**（note-workspace.tsx）：addKnowledge 按标题去重会把新正文静默丢弃还提示"已导入"，现命中同名即覆盖正文并明确提示「已更新」

### 交互
- **Modal 焦点陷阱只挂载一次**（ui.tsx）：依赖 `onClose`（调用方全是内联箭头）导致父组件每渲染一次焦点就被抢到关闭按钮——弹窗里打一个字丢一个字（复习回忆作答/反馈/添加书籍/锻造人物四处全中）
- **圆桌并行发言期间切会话不再串显**（council/page.tsx）：结束时回填旧会话消息前先确认 activeId 未变
- **⌘K 跳笔记同页生效**（brain/page.tsx）：URL 参数解析改依赖 `useSearchParams`，已在 /brain 时再跳 `?note=id` 也能打开
- **图谱「显示孤立节点」真过滤**（graph-view.tsx）：开关此前只改计数文字，画布一个节点不少
- **删除文件夹连带子文件夹**（store.ts removeFolder）：`A/B` 残留导致树重建复活出空夹
- **截止日按当天结束计算**（learn/[id]）：date-input 语义是当天仍可交付，此前东八区当天上午 8 点后就判「已过期」
- **关页 flush 超 64KiB 跳过**（auth-client.ts）：浏览器对 keepalive 请求体硬限 64KiB，超大库的强制 flush 必然失败还把同步态打成 error，现交给常规防抖推送兜底
- **useHydrated 订阅泄漏修复**（use-chat.ts）：cleanup 写在 `.then()` 返回值里 React 看不见，auth store 订阅永久泄漏
- **open/plan 绑定键修复**（api/open/plan）：`users/<id>` 漏 `.json` 且与 UUID 键空间错位，档案永远查不到；现补 `.json` 并兼容 UUID（回落邮箱扫描）

### 新增回归测试（vitest，13 条）
- `utils.test.ts` 增补：addDays 跨月/跨年/互逆、daysBetween、streakFrom 连续/断链/今天未学（时区无关断言）
- `url-guard.test.ts` 新建：IPv6 回环全写法（`[::1]`/展开形式/IPv4-mapped）、内网保留段、ULA/link-local/组播/文档段、协议端口 userinfo 约束

### 已知遗留（如实记录，见 docs/PRD-2026-10-24.md）
- 全站日界仍为 UTC（本地 0-8 点复习到期/验收日期错位一天）——牵一发动全身，需专项（P1）
- 自托管形态 `clientIp` 信任 XFF 最左值，伪造即可绕限流——需部署文档强制反代覆写（P1，Vercel 平台已覆写不受影响）
- preview 部署仍回显 devCode（公开可达时任何人可注册/重置任意邮箱）——建议 reset 用途关闭（P2）
- 注销账号不清 `versions/` 快照（最多 10 份加密快照留库）——合规瑕疵（P2）
- cron/weekly-digest 无幂等水位，双触发会重复发信（P2）；proxy 对 /api/health 反射任意 Origin（P2，收紧前需确认 Clarity Admin 依赖）

## v17.0 — 2026-10-11（外部评审后的集中还债）

依据 2026-10-11 产品评审（docs/PRODUCT-REVIEW-2026-10-11.md）按 P0→P1 逐条修复。

### 安全（发布阻断级）
- **/api/chat 提款机堵死**：模型 Key 与 baseUrl 必须同源——BYOK 模式只用客户端自己的 Key（custom 端点过公网 HTTPS + DNS 解析取证守卫）；服务端模式完全无视客户端头（此前 `provider+baseurl` 头组合可把部署者 DEEPSeek Key 的 Bearer 转发到攻击者 URL）
- **/api/chat 生产登录墙**：烧服务端 Key 的真实调用必须登录（演示脚本不限）；非 Vercel 环境放行保本地冒烟链路
- **BYOK 真接线**：客户端随请求携带用户 Key（此前是死码，README 卖点不成立）；BYOK 用户不受每日配额
- **生产注册旁路关闭**：未配 RESEND_API_KEY 时不再把验证码回给响应体（dev/preview 保留）——**生产恢复注册需要配 Key**
- **ADMIN_PASSWORD 明文出仓**：清理脚本改为强制从环境变量读取；旧密码已轮换
- **验证码/限流出进程**：存 D1/Upstash（跨 isolate 一致），dev 无 KV 自动回退内存——修多实例下注册验证码时好时坏的根因
- **登录账号维度防爆破**：同一邮箱 10 分钟内失败 8 次锁 15 分钟（找回通道不受影响）；/api/admin/overview GET 补限流
- **会话可吊销**：用户档案加 sv 版本号，改密/重置密码后所有旧设备 cookie 即刻作废（此前 30 天内照用）
- **SSRF 守卫统一**：linkcheck 与 BYOK custom 共用 url-guard（DNS 解析取证挡十进制 IP；重定向后复检落点）

### 账号与数据
- **忘记密码全链路**：send-code(purpose=reset，防账号枚举) → /reset-password → 登录页「重置密码」模式
- **云端版本快照**：/api/sync 覆盖写前自动保留最近 10 份历史（versions/<userId>/<ts>.json，`?versions=1` / `?v=<ts>` 可查可取）；请求体与解压体积双闸

### 学习闭环（判分认识论）
- 验收判分带参照物：当日讲义原文与知识点随 ctx 上行，QUIZ_GRADE 以讲义为准、覆盖不到判 ungradable（不再凭模型内建知识盲判）
- 复习判卷错位修复：出题改为钉死清单第 1 条，判卷材料带真题原文+笔记摘录；**评分服务异常不再默认通过**（重试即可，不灌水）
- **复习→掌握状态机接线**：recordReview 通过会推进 masteryStatus（masteryFromReview 从紧升级，失败不降级）；apply/build 无提示判对可达 transferable——六级状态机不再有永不可达的级
- **迁移题真门**：验收判过后当天成绩照常保存，但下一天须答迁移题才解锁；题目与答案持久化，刷新/换设备可补答
- 掌握状态机拆纯模块 mastery.ts + 9 条回归测试

### 崩溃与纪律
- 修复 learn/[id] 条件性 useState（React #310 白屏模式第三次复踩）
- ESLint 19 errors → 0（graph-view 渲染期读 ref ×5 改 viewStats+rAF 同步，顺带修复"缩放百分比标签不跟手"的真 bug；set-state-in-effect ×6；unescaped-entities ×6；purity；TDZ）
- CI 升级：npm ci（尊重 lockfile）+ lint 门禁 + build 验证；单测 21→30
- 死代码清理：固定阶梯 REVIEW_INTERVALS/nextReviewDate/nextReviewInterval（FSRS 已替代）；framer-motion（从未使用）

### 体验与可观测
- Modal 补 role=dialog/aria-modal/焦点陷阱/Esc/滚动锁/焦点归还；流式输出 5 处 aria-live；图标按钮 aria-label 补齐；落地页移动菜单 inert；hero 视频 preload 降 metadata
- token 计量：DeepSeek/OpenAI 流式回带 usage，逐次落 chat-usage 结构化日志（BYOK/配额/账号维度）
- @vercel/analytics 接入页面计数
- 文档纠偏：README 存储通道口径（D1 主通道）、FSRS 替代 1/3/7/15、BYOK 真实语义；ACCEPTANCE/ENGINEERING 同步；设置页 custom 端点提示修正

### 已知边界（诚实记录）
- AUTH_SECRET 一钥三用（会话 HMAC+数据加密+派生域）——密钥分离与轮换未做（P2）
- 无隐私政策/用户协议、无支付、大陆可达性（vercel.app 域名）——均待用户决策（P2）
- Sentry 未接（需账号）；Postgres 真源迁移未做（P2）
