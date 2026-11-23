# Mentora Mini V1.0 最小必要改造方案与技术映射（2026-11-08）

原则：不新建任何后端、不加新依赖、不改 Web 端一行代码；全部复用 /api/chat 现有 task、/api/sync、/api/search、/api/auth/*。小程序侧只做「协议对齐 + 数据模型补字段 + 新页面」，与 Web store 快照双向兼容（Web 拉到小程序写入的数据必须能正常渲染）。

## 一、API 映射表（小程序 → 服务端现有任务）

| 功能 | task | args 形状（与服务端 buildSystem 逐字段对齐） | 归一化移植 |
|---|---|---|---|
| 引导对话 | `intake` | `{topic, userName}`，messages=对话历史 | splitGoalReply（client.ts:209 同算法） |
| 总纲要 | `plan` mode=master | `{mode:"master", cardJson}` | masterPlanSchema 容错 + masterDraftToPlan（plan.ts:74） |
| 阶段天目录 | `plan` mode=phase-list | `{mode:"phase-list", ctx, maxDays}` | phaseListSchema + setPhaseCatalog |
| 单日细节 | `plan` mode=phase-detail | `{mode:"phase-detail", ctx, boundary, days}` | phasePlanSchema 容错 + phaseDraftToDay（plan.ts:102） |
| 讲义/答疑/验收/复习 | `lesson`/`coach-qa`/`quiz-grade`/`review-ask`/`review-grade` | 已在位 | 已在位 |
| 建书/读书对话 | `reading-plan`/`reading-chat` | 已在位（bookCtx 本轮增强） | 已在位 |
| 目标推荐 | `reading-goal` | `{title, author, desc}` | readingGoalSchema（枚举回落 understand） |
| 三重验收出题 | `reading-assess-gen` | `{book, chapter, goal, previousWeak}` | readingAssessGenSchema + 本地兜底三题 |
| 三重验收判分 | `reading-assess-grade` | `{book, chapter, goal, qa}` | readingAssessGradeSchema（mastered/partial/not/ungradable） |
| 节点小结 | `reading-recap` | `{book, chapter, deposits, chatExcerpt}` | 纯文本，无 schema |
| 会话 cookie/同步 | `/api/auth/*`、`/api/sync?plain=1` | 已在位 | 已在位 |

## 二、数据模型补齐（小程序 store.js，字段名与 Web types.ts 一字不差）

新增写路径（全部 markDirty 进快照，Web 端可直接读）：
- `addGoal(g)` / `updateGoal(id, patch)` / `setPlan(goalId, plan)` / `setPhaseCatalog(goalId, phaseId, list, boundary)` / `setDayDetail(goalId, dayId, draft)`（stub 继承状态语义与 Web setDayDetail 一致：catalog 的 day 处于 active 则新细节继承 active）
- `setBookGoal(bookId, goal)` / `markChapterMastered(bookId, chapterId, evidence, misconceptions?)` / `addBookAssessment(bookId, a)` / `addBookDeposit(bookId, d)` / `setBookReadStatus(bookId, status)`（finished/mastered 联动 finishedAt/masteredAt/status=done）
- `addKnowledgeRead(items, sourceTitle)`：recap 入第二大脑（source="read"，**不进复习队列**——Web 同语义，nextReviewAt 留空）

常量移植：READING_GOAL_LABELS、ASSESS_KIND_LABELS、DEPOSIT_TYPE_LABELS、READ_STATUS_LABELS（中文文案与 Web types.ts 一致）。

## 三、页面改造

### 3.1 新增 `pages/coach/coach`（学习教练引导页，约 300 行）
- 布局：全屏对话（复用 book 页对话布局类）+ 底部 composer + 「直接生成目标」按钮（轻引导纪律：最多追问 2 轮的体验交给提示词，UI 提供跳过追问出口）
- 流程：输入想学什么 → intake 流式（onDelta 实时渲染）→ 每轮后尝试 splitGoalReply → 出卡（目标卡卡片展示 topic/direction/weeklyHours/successCriteria/assumptions）→ 「确认，生成总纲要」→ plan mode=master（bgTask 风格 loading，失败留在确认态可重试）→ 写 store（addGoal→updateGoal→setPlan）→ 写总纲要笔记进第二大脑（`${topic} · 学习总纲要`，双链阶段笔记标题与 Web 同公式）→ 跳回 learn 列表
- 入口：learn 页 goals tab 空态与列表底部「+ 新的学习目标」

### 3.2 `pages/goal/goal` 增强
- 阶段卡：「生成天目录」按钮（catalog 为空且 phase=active）→ plan phase-list（maxDays=min(estDays‖6,8)）→ 目录渲染（stub 天标注「待展开」）
- stub 天点击 → day 页先「展开今天细节」（plan phase-detail，仅这一天）再进讲义流

### 3.3 `pages/day/day` 增强
- stub 态：顶部「展开今天的计划」按钮（phase-detail 单日），完成后正常渲染
- 其余不动

### 3.4 `pages/book/book` 增强（阅读系统 V1.0）
- 顶部「认知概览」可收起块：map 四区域（无 map 旧书自动隐藏）+ verification 标注
- 阅读目标卡：未设 → 「推荐阅读目标」（reading-goal，展示 primary+reason，inferred）+ 四成果 chips 可点改；已设 → 展示 + 可改
- 章节抽屉每项加操作：「开始验收」（assess 流）「标记读完」（status=done 手动）；章节头显示 masteredAt 徽标
- 验收弹层（新 sheet）：三题（kind 徽标 理解/结构/迁移）→ 作答 → 判分（四级 verdict 色调）→ 全 mastered → markChapterMastered（done+masteredAt+learning.evidence）→ 「薄弱点」展示 suggestion；出题失败本地兜底三题（与 Web 同文案）
- 沉淀面板：七类 chip + textarea → addBookDeposit；待解决问题类同步 learning.unresolvedQuestions；节点小结按钮 → reading-recap（流式）→ 「存入第二大脑」
- 整本状态条：在读 → 「标记读完」（finished）；finished → 「整本验收」（assessing + 切 recall-check + modeJustSwitched）；assessing → 「确认已掌握」（mastered）
- bookCtx 增强：+ map/goal/本章 assessments 弱点/deposits（与 Web readCtx 同形状）

### 3.5 `pages/login/login`：文案「邀请码」→「激活码」（一人一码，网页版/客服获取）；register payload 不变

### 3.6 `utils/chat.js`：sawEnd 校验（收到 `t=end` 才 resolve；否则 reject「连接中断，回答没有生成完」+ err.partial）——与 Web client.ts 同语义

## 四、schema/工具移植清单（新文件 `utils/schema.js`）

- `extractJson` 已在 chat.js（不动）
- `splitGoalReply(text)`：client.ts:209 同算法（GOAL_READY 标记 + 候选逆序）
- `normMasterPlan / normPhaseList / normPhaseDay`：手写容错（对应 z.preprocess：枚举回落、year/kind/evergreen 容错、acceptance kind 回落 apply、knowledgePoints 字符串|对象 union）
- `masterDraftToPlan(draft, card)` / `phaseDraftToDay(d, phaseId, dayId)`：plan.ts 同逻辑（uid 前缀 kp/ac/ph/day 与 Web 一致）
- `normReadingGoal / normAssessGen / normAssessGrade`：枚举回落 + evidence 截断
- `chapterJson(c)` / `goalText(goal)` 上下文助手（与 Web read/[id]/page.tsx 同形状）

## 五、测试方案（第七步三场景）

1. **场景一·阅读闭环**：探针账号（ADMIN_PASSWORD 现场发激活码注册）→ node 脚本以小程序同款 args 顺序打真实后端：reading-plan（建书）→ reading-goal → assess-gen → assess-grade → 全 mastered 断言 → reading-recap；UI 层由 smoke-mp-core 新增断言覆盖：setBookGoal/markChapterMastered/assessments 存档/setBookReadStatus 五态联动/deposits/recap 入库（wx stub）
2. **场景二·学习教练闭环**：同探针 → intake 两轮（splitGoalReply 断言出卡）→ plan master（断言 phases≥1 且首阶段 active）→ phase-list（断言 catalog/maxDays 钳制）→ phase-detail（断言 acceptance≥2/resources）→ UI 层 smoke：addGoal→setPlan→过门→迁移→解锁→done 全链（部分已有 32 断言回归）
3. **场景三·跨端同步**：探针推送含 map/goal/assessments/deposits/book.readStatus 的快照（MP serialize 形状）→ `/api/sync?plain=1` 拉回比对字段无损；反向：Web 形状快照（含 masteredAt/planHistory）→ MP adoptCloud → 断言新字段不丢
4. 门禁：`node scripts/check-mp-wxml.cjs` + `check-mp-wxss.cjs` + `smoke-mp-core.cjs`（扩容）+ 全部 js `node --check`
5. 诚实边界：WXML/WXSS 编译与真机 UI 验收需用户在开发者工具点「编译」（本机 GUI 自动化不可用，见项目记忆）；报告给用户手测清单

## 六、实施顺序（第六步）

1. utils/schema.js + store.js 写路径（先数据层，可单测）
2. chat.js t=end
3. coach 新页 + learn 入口 + goal/day 增强
4. book 页阅读系统增强
5. login 文案
6. 四门禁 + 三场景脚本 → 修复 → 回归
