# Mentora Mini V1.0 现状审计报告（2026-11-08）

审计范围：`miniprogram/`（11 页 + utils 层，4753 行）与 Web 端 master `363a01e`（V26.2 已上线）。
方法：小程序逐文件精读 + Web 侧数据模型/协议/门禁定点核查。只读，未改任何代码。

## 一、小程序现有能力（第一步审计结论）

### 1.1 页面清单（app.json）

| 页面 | 能力 | 对应 Web |
|---|---|---|
| overview 今天 | 主任务卡（进度/迁移门上浮）+ 到期复习 + 热力墙 12 周 + 连续天数 | 总览/学习人生精简版 |
| login 登录/注册 | 邮箱密码 + 邀请码字段 | /login（Web 已改激活码制） |
| learn 学习 | 目标列表 tab + 书架 tab + 建书弹层（含 V26.2 书籍核查三态） | /learn 双 tab |
| goal 目标详情 | 阶段折叠目录 + 天状态（locked/active/passed/skipped）+ 迁移门标记 | /learn/[id] 计划部分 |
| day 今日 | 讲义生成（task=lesson）→ 资料复制 → 答疑（coach-qa）→ 验收判分（quiz-grade，证据强制降级）→ 迁移真门 → 强制跳过两击 | /learn/[id] 天视图 |
| brain 大脑 | 笔记搜索/文件夹筛选/链接数/到期数 | /brain 列表 |
| note 笔记 | markdown 渲染 + 出链/反链跳转 + 掌握状态 chips | /brain 详情 |
| review 复习 | 出题（review-ask）→ 判卷（review-grade，无证据改判 fail）→ 经典 1/3/7/15/30 档 | 复习流 |
| book 读书 | 五模式对话（socratic/feynman/collision/close-read/recall-check）+ 章节切换 + 模式切换开场协议 | /read/[id] 对话部分 |
| council 伙伴 | 12+4 席位单聊 + 圆桌逐席发言 + 主持人纪要（task=council） | /council |
| profile 我的 | 账号/数据计数/同步状态/后端切换（prod/tunnel/local，正式包锁 prod）/退出 | /settings 精简 |

### 1.2 utils 层与 Web 的同语义程度

- `store.js`（962 行）：goals/knowledge/books/sessions/customPersonas/folders/settings 七键，与 Web 云快照键一致（agentSessions 按 Web 约定不参与云同步）。写路径已复刻：unlockNext 解锁链、pendingUnlock 迁移真门、completeTransfer、applyQuizPass（一次 clone 写全）、quizLog 裁剪（200 条/600 字）、MOC 目录、linkifyBodies 双链、recordReview 经典档 + masteryFromReview 同规则、createBookFromPlan（**已接 v25 map 四区域 + V26.2 verification 标注**）。
- `chat.js`：NDJSON `t=d/h/e/p/end` 与 Web 逐字一致；enableChunked + 增量 UTF-8；取消句柄；err.partial 半截保留。
- `grade.js`：zod 容错解析的手写移植 + 证据强制降级（无 evidence 正向判 → ungradable）。
- `mastery.js`：六级状态机忠实移植（apply/build 无提示判对 → transferable）。
- 同步：脏标记/水位/防抖 2.5s/onHide flush/空快照不覆盖/30s 拉取节流，全套防事故机制在位。

### 1.3 门禁脚本（scripts/）

`check-mp-wxml.cjs` + `check-mp-wxss.cjs` + `smoke-mp-core.cjs`（32 断言：md/extractJson/判分降级/掌握状态机/过门/真门/解锁链/复习档/结业回归锁）+ 全 JS `node --check`。

## 二、Web 侧现状（第二步审计结论）

### 2.1 阅读系统 V1.0（Web 有、小程序缺）

- 数据模型（`src/lib/types.ts:287-557`）：Book 新增 map（认知地图四区域）、goal（ReadingGoal 四成果 understand/think/apply/retain + secondary + intent + background + inferred）、readStatus 五态（unread/reading/finished/assessing/mastered）、routeType、assessments[]（ChapterAssessment：explain/connect/apply × mastered/partial/not/ungradable + evidence）、transfers[]（含 recheck 六分类）、deposits[]（七类沉淀）、learning（knownConcepts/misconceptions 带 clarified/unresolvedQuestions/evidence）、recommendedMode、verification。章节节点新字段 keyConcepts/prerequisites/expectedOutcome/assessFocus/masteredAt。
- AI 任务（客户端 → /api/chat，NDJSON）：`reading-goal`（目标推荐）、`reading-strategy`（进入节点推荐模式）、`reading-assess-gen`（按目标加权出三题，args: book/chapter/goal/previousWeak）、`reading-assess-grade`（args: book/chapter/goal/qa；四级 + misconception 提取）、`reading-recap`（args: book/chapter/deposits/chatExcerpt → markdown 小结）、`reading-add-node`、`reading-transfer-gen/grade/recheck/recheck-grade`、`reading-graduation`（args: book/goal/map/stats/transfers/deposits → noteMarkdown + nextSteps≤3）。schema 全部带预处理容错（枚举回落、裸数组解包）。
- store 写路径：markChapterMastered（done+masteredAt+learning.evidence+trackReading）、addBookDeposit、addBookTransfer（used_correct 联动沉淀 practice）、attachTransferRecheck、setBookReadStatus（finished/mastered 联动 finishedAt/masteredAt/status=done）、setBookGoal、regenerateBookRoute（验收档案归档不丢）。
- UI 交互（`src/app/read/[id]/page.tsx`，1916 行）：顶部认知地图、目标卡（AI 推荐/直接开始=inferred）、节点状态机、验收弹层（出题失败本地兜底三题）、沉淀面板（七类一句话）、节点小结→入第二大脑（addKnowledge source="read"）、整本状态机按钮（读完/整本验收=recall-check/确认已掌握）、迁移与结业面板。

### 2.2 学习教练（Web 有、小程序缺）

- 引导建目标：`/learn/new` task=intake（args: topic/userName）多轮 → `splitGoalReply` 从回复里解析目标卡（`<!--GOAL_READY-->` 标记或裸 JSON 兼容）→ 目标卡展示 + 直接生成 → confirmCard 更新 goal（status: active）→ 总纲要 task=plan mode=master（args: cardJson）→ `masterDraftToPlan`（阶段骨架、第一阶段 active、planned:false）→ 写第二大脑总纲要笔记（`${planTitle} · 学习总纲要` + 双链）。
- 阶段计划两步制：`phase-list`（args: ctx/maxDays）出天目录（catalog）→ `phase-detail`（args: ctx/boundary/days）按天展开细节 → `phaseDraftToDay`。V26.1 起总纲生成已任务化（切页/刷新可恢复），天级仍两段式并行。
- store：addGoal/updateGoal/setPlan/setPhaseCatalog/setDayDetail 等（`src/lib/store.ts:603-730`）。
- 其余：coach-qa 带 RAG（rag-pipeline 五步增强）、结业回路（needsGraduation → task=graduation → 第二大脑 + nextSteps）、阶段重排 regenerate_phase、update_plan_resources、enableReview 笔记加入/移出复习。

### 2.3 身份认证 / 会员 / 配额（小程序直接影响）

- **注册=一人一码激活码**（`src/lib/server/license.ts`，claimLicense 一码一赢家；INVITE_CODE 已停用、send-code 已删）。字段名仍是 `inviteCode`（`src/app/api/auth/register/route.ts:44`），小程序 login.js 传的字段名一致 → **功能兼容，仅文案需改**。注册还有邮箱 MX 取证 + 24 字名字上限。
- 会话：`mentora_session` HMAC cookie；`/api/auth/me` 会话失效返回 `{user:null}`（小程序 app.js/learn.js 已正确处理该形态）。
- **生产 /api/chat 强制登录**（isDeployed()）；到期会员（expired）自动降免费档（月度 token 预算，429 FREE_BUDGET_EXHAUSTED 文案服务端已人话）；每日调用配额 60 次/用户（AI_DAILY_CALL_LIMIT）。
- `/api/sync`：GET `?plain=1` 明文（>4.2MB 拒绝）；POST 4.2MB 上限 + 64MB 解压闸 + 10 份版本快照。
- `/api/search`（POST）：V26.2 书籍核查与小程序 learn.js 已共用的搜索网关。
- 限流：全站 /api 每 IP 令牌桶 120/min，chat 30/min —— 小程序与 Web 共享桶（按 IP）。

### 2.4 协议细节差异（审计发现）

1. **Web streamChat 要求收到 `{"t":"end"}` 才算成功**（`src/lib/ai/client.ts:145` 断流报「连接中断」）；小程序 chat.js 在请求 success 时即 resolve，**断流会把半截回答当完整答案**（判分类 JSON 任务会以「无法解析 JSON」掩盖真因）。
2. Web reading-chat/bookCtx 已注入 map/goal/deposits/learning；小程序 bookCtx 只有 planSummary/currentChapter/pastedExcerpt/insights。
3. Web quiz-grade 支持 args.tone（coachTone gentle）；小程序未传（standard，语义默认，可接受）。

## 三、技术风险

| # | 风险 | 等级 | 说明 |
|---|---|---|---|
| R1 | 小程序缺「引导建目标 + 计划生成」，学习教练新用户在小程序端无法从零开始 | P0 阻断 | 只能看 Web 建好的目标 |
| R2 | 缺三重验收/五态/沉淀，读书侧只完成「对话」一环，与 PRD 验收支柱不符 | P0 阻断 | 知识沉淀支柱缺失 |
| R3 | chat.js 无 t=end 校验 | P1 | 断流时半截 JSON 当成功，用户看到解析失败但不知原因 |
| R4 | 4.2MB 快照上限：新增长文数据（assessment/deposit）后大库用户可能触顶 | P2 | 与 Web 同上限，快照裁剪已部分缓解（quizLog 裁剪） |
| R5 | 每日 60 次配额 + 每 IP 30/min：小程序重度使用会触限 | P2 | 提示文案服务端已人话，小程序如实透传 |
| R6 | UI 层无法在本机自动化验证（开发者工具 GUI 不可程序化截图，见项目记忆） | 边界 | 编译验证依赖用户在开发者工具点「编译」；逻辑层用 wx stub 冒烟兜底 |
| R7 | 真机网络：vercel.app 大陆直连不通 | 已知 | README 已写明；后端切换只放 prod（正式包） |
