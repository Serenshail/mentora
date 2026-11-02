# Mentora · 产品全景手册

> 这份文档写给**下一个接手本项目的 AI**（也写给新加入的人）。
> 读完这一篇，你应该能在不读源码的情况下，准确说出这个产品是什么、为谁做、每个模块怎么运转、代码在哪、哪些坑不能再踩。
> 最后更新：2026-10-28 · 对应代码版本见 `package.json`（Next.js 16.3.4 / React 19）

---

## 0. 60 秒速览

**Mentora 是一个「把学会任何东西变成日常」的个人学习操作系统。** 它不是一个课程平台、不是一个笔记软件、也不是一个聊天机器人——它是把「学习这件事」拆成可执行闭环的四合一工具：

| 模块 | 一句话 | 它替代了什么 |
|---|---|---|
| 🎓 学习教练 | 先真正认识你，再排两级计划，每天一课，验收通过才放行 | 替代「买了一堆课却不知道从哪开始」 |
| 🧠 第二大脑 | Obsidian 式双链笔记 + 力导向图谱 + FSRS 间隔复习 | 替代「笔记记了不用、学了就忘」 |
| 📖 读书伙伴 | 解剖一本书的论证结构，陪你读到能自己讲出来 | 替代「读完就忘、划了线等于学会」 |
| 🧭 人生伙伴 | 16 个反迎合的席位（12 位真人 + 4 个思维模型）+ 圆桌研讨 + 可锻造任何人物 | 替代「问 AI 只得到正确的废话」 |

**技术形态**：Next.js 16 App Router 全栈单体（React 19 + Tailwind 4 + TypeScript + zustand），AI 能力全部收敛到唯一端点 `/api/chat`，提示词只存在服务端。数据本地优先（localStorage 快照）+ 云端同步（AES-256-GCM 静态加密）。

**一句话判断**：这是一个**方法论引擎**，不是内容库。它的护城河是提示词 + 判分标准 + 数据闭环，不是题库。

---

## 1. 产品定位

### 1.1 它解决的真问题

普通人学东西的真实失败点不在「找不到资料」，而在四件事：

1. **不知道学到什么程度算学会** → 没有验收标准
2. **计划排得太满或太空** → 一开始就排死全部，遇到现实就崩
3. **学了记不住、记了用不上** → 笔记与学习两张皮
4. **没人给真话** → AI 只会附和，朋友只会鼓励

Mentora 的四个模块分别针对这四点，且**它们共享同一套数据**（知识点 → 掌握状态 → 笔记 → 复习 → 图谱），这是它与「四个独立工具拼起来」的本质区别。

### 1.2 目标用户

- **主用户**：有明确学习意图但缺少方法论的成年人（考研/留学/转行/技能补强/自学编程），每周能投入 5–20 小时。
- **典型场景**：`为了参加华为 ICT 大赛，用 Python 做传感器数据采集并入库`（这是探针实测用例）。
- **不服务**：K12 刷题党、想要题库的人、想要陪伴型角色扮演的人、想要团队协作的企业。

### 1.3 产品哲学（决定了所有文案与设计取舍）

- **第一句话就是判断**：不铺垫、不排比、不和稀泥。文档、UI 文案、AI 回复全部遵守。
- **验收不放水**：判分四级（correct / partially_correct / incorrect / ungradable），不给二元 pass/fail；想强行跳过必须输入「跳过」二次确认并留痕。
- **不承诺日期**：学习量由任务决定，投入多少走多快。没有「30 天精通」这种话术。
- **数据归用户**：本地优先、随时可导出、加密同步、可切存储后端。
- **做减法**：明确的不做清单见 `COMMERCIAL.md` §5（不做社交大盘、不做题库、不做泛知识库问答、不做原生 App、不做企业版）。

---

## 2. 四大模块详解

### 2.1 🎓 学习教练（主力，永远是第一优先级）

**核心资产：不是「生成计划」，而是「先认识人，再排计划」。**

#### (1) 引导 / 目标卡（Intake）

用户输入一句话（如「我想学 Python」），教练用 **6–9 轮苏格拉底式提问**挖出：目的、基础、可投入时段与时长、学习风格、放弃史、性格倾向、现实约束。

- 行业标准类问题（「学到什么程度能应聘」）由 AI 自己推导，**不反问用户**。
- 每轮结束模型可能输出一张 **目标卡（GoalCard）** = `topic / direction / domainKind / motivation / background / weeklyHours / learnerProfile / successCriteria / assumptions`。
- 前端用 `splitGoalReply()` 从回复中剥离 JSON（见 §7.4），绝不让裸 JSON 出现在气泡里。
- 用户确认目标卡 → 生成总纲要。

**关键工程点**：草稿可中断可回档（`goal.status = "draft"`），刷新后从 `intakeTranscript` 恢复对话。

#### (2) 两级计划（这是产品的骨架）

**第一级：总纲要（Master Plan）**
输入目标卡 → 输出 `summary + phases[]`（每阶段有 `title / outcome / estDays / outline(8–15 条) / boundary(不学什么)`）。
这一级只排「阶段」，不排到天。

**第二级：天级计划（Phase Plan）——拆成两步，这非常重要**

> ⚠️ 曾经的实现是「一次生成整阶段全量细节」。实测上游推理模型单次产出 5753 / 8817 / 13379 / 15092 completion tokens，耗时 2–4 分钟，客户端或隧道在流结束前断开，用户看到 `network error`。**这是历史第一大故障，已彻底修复，不要退回旧做法。**

现在的链路（`prompts.ts` 顶部有同样的工程说明）：

```
phase-list   →  只出「天清单」：boundary + [{title, knowledgePoints(字符串数组)}]，2–8 天，总输出 ≤900 tokens
phase-detail →  按批展开细节：每批 ≤2 天，每天含 knowledgePoints(带 knowledgeType)、resources、method、example、acceptance
```

前端（`src/app/learn/[id]/page.tsx` 的 `PhasePlanPanel`）：

- 每批请求独立，`chatWithRetry(2)` 小步重试；
- **每批完成立刻 `setPhasePlan(..., { partial: true })` 落盘**（不置 planned、不激活首天）；
- 断线后按钮变「继续生成天级计划（已完成 N 天）」，从第 N 天续跑，不重头再来；
- 进度文案显示「正在展开 Day X–Day Y（第 i/n 批 · 全阶段共 m 天）」。

**数据形态**：`Phase.catalog: DayOutline[]`（全阶段天目录，目录一生成就完整可见）+ `Phase.planned`（全部天是否已展开细节）+ `DayPlan.stub`（只有标题与清单级知识点的占位天）。
用户学到哪天，才展开哪天——这是「计划不排死」的实现方式。

#### (3) 每日一课（Daily Lesson）

按「6 段教学模板」生成，并按 `domainKind` 分领域模板：

| domainKind | 教学方式 |
|---|---|
| `coding` | 完整可运行项目例子驱动 |
| `humanities` | 原文细读 + 费曼口述，**禁止代码** |
| `language` | 输入 / 输出循环 |
| `exam` | 真题 + 间隔重复 |
| `career` | 作品集驱动 |
| `other` | 通识技能 |

六段结构：可直接学的资料 → 知识点穷尽到方法级 → 完整可运行示范 → 逐步拆解 → 变体与易错 → 操作 + 默写双验收。
`coachTone` 设置（standard / gentle）只改语气，**不改判分标准**。

#### (4) 验收门（Acceptance Gate）

- 每天有 2–5 条验收题，`kind` ∈ `explain / apply / oral / essay / build`。
- `quiz-grade` 任务四级判分，逐条给 `verdict + feedback + hintLevel`。
- 全部通过 → 记录 `QuizResult`、知识点入库（第二大脑）、解锁下一天。
- 不通过 → 给最小补救动作（提示阶梯 L0–L5：自检 → 错误位置 → 原则 → 结构 → 示范关键步 → 完整示范）。
- **迁移题真门**：判分 pass 后会出 `transferQuestion`，答完才真正解锁下一天（`pendingUnlock` 字段控制）。这是防止「背下来 = 会了」。
- 强行跳过需输入「跳过」二次确认，`forced: true` 留痕。

#### (5) 掌握状态机与结业

六级 `MasteryStatus`：`unknown → exposed → guided → independent → transferable → durable`（来自 Learn Anything mastery-rubric）。
知识点带 `knowledgeType`（fact / concept / procedure / discrimination / judgment / creative），决定后续讲解策略与验收方式。

最后一个阶段过门后 → `needsGraduation = true` → 生成**结业笔记**（入第二大脑）+ `nextSteps`（下一步建议，仅建议、不自动建目标）→ `graduatedAt`。

#### (6) 学习中随手记 / 随时问

- 「问教练」(`coach-qa`)：按天保存到 `DayPlan.qa`，带 RAG 检索（用户自己的笔记作为证据，有严格的使用纪律：禁止照抄、不相关就不用、要标注来源、不许假装记过）。
- 「随手记」：一句话直入第二大脑。

---

### 2.2 🧠 第二大脑（Obsidian 式）

**定位**：不是笔记软件，是「学习成果的沉淀层」。学习计划、读书洞见、圆桌判断，最后都变成这里的笔记。

- **双链**：正文支持 `[[标题]]`，未创建的显示虚线占位（`unresolved`）；出链 / 反向链接面板。
- **力导向图谱**：拖拽 / 点击 / 邻居高亮（`src/components/brain/graph-view.tsx`）。学习计划本身也作为节点进图谱。
- **AI 建联（`autolink`）**：在整库里找有真实思想联系的笔记并说明理由，**宁缺毋滥**。
- **LLMWiki 编译（`wiki-compile`）**：把孤立/新笔记「编译」进 wiki 网——优先建立链接而不是复制内容，发现重复建议合并，发现矛盾标记。这是产品宣称的护城河之一。
- **复习调度：FSRS**（`ts-fsrs`，免费开源记忆调度器）：按每次回忆表现自适应下一天，不再用固定 1/3/7/15 天。字段 `KnowledgeItem.fsrs`，旧数据用 `reviewStage` 兼容。
- **回忆式复习**：AI 出题（`review-ask`）→ 凭记忆作答 → AI 对照笔记判定（`review-grade`）→ 通过则推进掌握状态。
- **导入导出**：Obsidian 库导入（`obsidian-import.ts` / `components/brain/obsidian-import.tsx`），支持 frontmatter、标签、双链解析。

关键字段：`title / body / domain / source(learn|read|council|manual|obsidian) / sourceTitle / knowledgeType / masteryStatus / reviewStage / nextReviewAt / links / tags / version / updatedAt / fsrs`。

---

### 2.3 📖 读书伙伴

**定位**：不是「书籍摘要生成器」，是「陪你把一本书读到能自己讲出来」。

- **书籍档案（BookProfile）**：这本书在解决什么问题 / 作者立场 / 思想谱系链条 / 主要争议。
- **拆解方式按论证逻辑走，不默认按目录**。每个单元（`BookChapter`）带：核心论点 `coreIdea` + 带读问题 `focusQuestion` + 其他思想家的交叉视角 `perspectives` + 值得记的笔记建议 `capture`。
- **五模式对话引擎**（`READING_MODE_CHAT` + `reading-modes.ts`）：
  `socratic`（苏格拉底，只提问不代讲）/ `feynman`（费曼式讲给我听）/ `collision`（观点碰撞）/ `close-read`（原文细读）/ `recall-check`（回忆检验）。
  切换模式时会带 `modeSwitch` 标记，让模型立刻执行新模式的「开场协议」，否则会顺着旧语境继续（这是实测修过的坑）。
- **三重验收（`verify-score`）**：通俗举例 / 知识迁移 / 贴合度，三项打分 → `understood / partial / not`。
- **洞见入库（`insight`）**：从对话里提炼**用户自己说出的**理解（不是书上原话），变成独立笔记。
- **RAG**：检索用户第二大脑笔记作为证据喂给对话。

---

### 2.4 🧭 人生伙伴（含圆桌）

**定位**：反迎合的思维伙伴。核心不是「陪你聊」，是「给你判断」。

- **8 条判断纪律**（写在 `COUNCIL_BASE`）：第一句就是明确判断 / 挑战坏问题的框架 / 主动给最强反方 / 诚实标注无知 / 不给情绪安慰给可执行判断 / 不和稀泥 / 观点与身份解耦 / 永远附下一步动作。
- **16 个内置席位**（`PERSONAS` + `CONCEPT_PERSONAS`）：
  **12 位真人**——`naval`、`jobs`（乔布斯）、`munger`（芒格）、`feynman`（费曼）、`taleb`（塔勒布）、`graham`（Paul Graham）、`karpathy`、`musk`（马斯克）、`zhangxuefeng`（张雪峰）、`zhangyiming`（张一鸣）、`mrbeast`、`sutskever`（Ilya）；
  **4 个思维模型席位**——`first-principles`（第一性原理）、`incentives`（激励结构）、`antifragile-filter`（反脆弱筛子）、`attention-econ`（注意力经济）。
  每个人格 = 思想体系（用 TA 自己的术语）+ 语言指纹 + 招牌提问 + 真实原话 + few-shot 对话，存在**服务端**（IP 保护，前端拿不到全文，只能拿到名字/标签/颜色这类元数据）。
- **圆桌研讨会**：
  - 每位与会者**并行独立发言**（`council` mode=`take`，服务端拼 `persona.system + ROUNDTABLE_TAKE`）；
  - 主持人收拢（mode=`host`）成纪要：共识 / 真分歧 / 被遗漏的视角 / 下一步；
  - 默认推荐 3 席，>6 席给成本警告；有 runId、取消、超时、部分失败、重试、切会话隔离。
- **锻造任何人物（`persona-distill`）**：输入一个名字 → AI 确认身份 → 蒸馏出 1500–3000 字的「本人降临」级系统提示词（人生关键节点 / 三层思想体系 / 语言指纹 / 真实原话 / 样例对话），存 `CustomPersona`，之后可参与单聊与圆桌。
- **方向引导（`direction-guide`）**：用第一性原理拆回用户自己的底层事实，不推荐热门方向。

---

### 2.5 🧩 学习人生（Life）与全局助手

- **学习人生**：个人时间线 + 打卡 + 连续天数 + 热力图（`study-heatmap.tsx`）。由 `life-post` 以教练第一人称发「朋友圈」式动态（像朋友发动态，不像系统通知）。**只有个人时间线，没有社交**。
- **全局助手（`app-assistant`）**：住在左下角，回答「这个功能在哪 / 这条数据去哪了」，像同事不像客服，三句内说完。
- **命令面板（⌘K / Ctrl K）**：跳转任意页面、目标、笔记、书籍。

---

## 3. 端到端用户旅程

```
访客打开 /            → 落地页（手写体标题动效 + 四模块讲解）
注册（邀请码）        → /login?mode=register
进入 /learn/new       → 一句话描述想学什么
  ↓ 6–9 轮问答        → 每轮可能产出目标卡
确认目标卡            → 生成总纲要（master）→ 落到 /learn/{goalId}
  ↓ 阶段列表可见      → 点某阶段「生成天级计划」
phase-list（1 次）    → 拿到天目录
  ↓ 立即落盘目录
phase-detail（每批 2 天，多次）→ 每批完成即 partial 落盘
  ↓ 全部完成          → planned = true，激活 Day 1
Day 1 学习页          → 生成每日讲义（lesson）
  ↓ 读完讲义
验收（quiz-grade）    → 四级判分 + 提示阶梯
  ↓ 全过
迁移题（transfer）    → 答完才解锁 Day 2
  ↓ 入库
知识点 → 第二大脑笔记 → FSRS 排期 → 到期复习（review-ask/grade）
  ↓ 阶段全过
下一阶段 / 最终结业（graduation）→ 结业笔记 + nextSteps
```

**并行支线**：读书伙伴（`reading-plan` → 单元对话 → 三重验收 → 洞见入库）、人生伙伴（单聊 / 圆桌 / 锻造）、第二大脑（随时记、建联、编译 wiki）。

---

## 4. 页面地图

| 路由 | 作用 | 关键点 |
|---|---|---|
| `/` | 未登录=落地页；已登录=仪表盘 | 登录墙逻辑在 `app-shell.tsx` |
| `/login` | 登录 / 注册 / 重置密码（`?mode=`） | 服务端读 `mode` 渲染，避免水合闪白 |
| `/learn` | 目标列表 | 目标卡列表 + 进度 |
| `/learn/new` | 引导流程 | 草稿恢复、对话落盘、确认目标卡 |
| `/learn/[id]` | 目标详情（产品最复杂页面） | 阶段列表 / 天目录 / 天级计划面板 / 单日学习 / 验收 / 迁移题 / 结业 |
| `/brain` | 第二大脑 | 笔记工作区、图谱、复习队列、Obsidian 导入 |
| `/read` | 书架 | 新建书籍（书名/作者/粘贴原文）→ `reading-plan` |
| `/read/[id]` | 单本书 | 书籍档案、单元列表、五模式对话、三重验收、洞见入库 |
| `/council` | 人生伙伴 | 人格选择、单聊、圆桌、锻造人物 |
| `/life` | 学习人生 | 时间线、打卡、热力图 |
| `/settings` | 设置 | BYOK（服务商/Key/模型/自定义端点）、教练语气、每周复习邮件、导入导出、清空数据 |
| `/admin` | 作者后台 | 独立密码门（`ADMIN_PASSWORD`），用户列表与删除 |
| `/privacy` `/terms` | 合规页 | |

**移动端**：底部 5 个主入口 + 「更多」抽屉（`MOBILE_PRIMARY` / `MOBILE_MORE`）；「更多」在当前路由落在隐藏入口时高亮；Back 先关抽屉再离开（pushState 哨兵）；`useVisualViewportInset` 处理键盘遮挡；安全区 `--safe-top`。

---

## 5. 数据模型（`src/lib/types.ts`）

```
Goal
  id, topic, direction, domainKind, motivation, background, deadline?
  weeklyHours, successCriteria[], assumptions?, learnerProfile?
  status: draft | active | paused | done
  plan?: Plan
  quizLog: QuizResult[]
  intakeTranscript: {role, content}[]      // 引导对话，刷新恢复用
  needsGraduation?, graduatedAt?, graduationNoteId?, nextSteps?

Plan
  summary, totalDays, weeklyHours, startDate, createdAt
  phases: Phase[]
  days: Record<dayId, DayPlan>

Phase
  id, title, outcome, dayIds[], status: locked|active|passed|skipped
  outline[]?, boundary?, estDays?
  planned?        // 所有天都已展开细节
  catalog?: DayOutline[]   // 全阶段天目录（dayId, title, knowledgePoints[]）

DayPlan
  id, phaseId, title, stub?
  knowledgePoints: {id, text, detail?, knowledgeType?, masteryStatus?, historicalHighest?, hintLevel?}[]
  resources: {title, url?, why, year?, kind?, evergreen?, verified?, author?}[]
  method, example?: {title, description, code?}
  acceptance: {id, kind: explain|apply|oral|essay|build, question, hint?}[]
  status: locked|active|passed|skipped, completedAt?, attempts
  lesson?        // 已生成的当日讲义缓存
  qa?: ChatMsg[] // 当日答疑
  pendingUnlock?, transferQuestion?, transferAnswer?   // 迁移题真门

KnowledgeItem（第二大脑笔记）
  id, title, body(Markdown, 支持 [[双链]]), domain, source, sourceTitle
  knowledgeType?, masteryStatus?, masteredAt
  reviewStage, nextReviewAt?, lastReviewOk?
  links[], tags?, version?, updatedAt?, unresolved?
  fsrs?: {st, dif, stb, elapsed, scheduled, reps, lapses, due, last}

Book
  id, title, author?, profile?{positioning, author, lineage, controversies}
  pastedText?, status: want|reading|done
  chatMode?, modeJustSwitched?
  planSummary?, chapters[], insights[], chat[]

CouncilSession
  id, personaId(内置 id | "roundtable" | "custom:xxx"), participants?, title, messages[]

CustomPersona
  id, name, tag, bio, color, identityNote, system(蒸馏出的完整提示词), createdAt

Settings
  provider: demo|zai|deepseek|moonshot|openai|maas|custom
  apiKey, model, baseUrl, userName
  coachTone?: standard|gentle
  digestWeekly?: boolean
```

**掌握状态机**：`unknown → exposed → guided → independent → transferable → durable`
**知识类型**：`fact / concept / procedure / discrimination / judgment / creative`
**提示阶梯**：L0 自检 → L1 错误位置 → L2 原则 → L3 结构 → L4 示范关键步 → L5 完整示范

---

## 6. AI 引擎

### 6.1 唯一端点 `/api/chat`

前端**只发 `task + args`（纯数据）+ messages**，服务端按 task 组装系统提示词。
**提示词模板永不进浏览器包、不上网络**（IP 保护核心）。

### 6.2 task 全表（`buildSystem`）

| task | 用途 | 备注 |
|---|---|---|
| `intake` | 苏格拉底引导 + 目标卡 | 6–9 轮 |
| `plan` (mode=master) | 总纲要 | phases[] |
| `plan` (mode=phase-list) | 阶段天目录 | ≤900 tokens |
| `plan` (mode=phase-detail) | 按批展开细节 | ≤2 天/批 |
| `lesson` | 每日讲义 | 6 段模板 + 域模板 |
| `quiz-grade` | 验收判分 | 四级 + 迁移题 |
| `review-ask` / `review-grade` | 复习出题 / 判定 | FSRS 队列 |
| `reading-plan` | 书籍解剖 | 论证逻辑拆解 |
| `reading-chat` | 陪读（五模式） | 支持 RAG 证据 |
| `verify-score` | 读书三重验收 | 三维打分 |
| `insight` | 洞见提炼入库 | 只提炼用户自己的理解 |
| `autolink` | 笔记建联 | 宁缺毋滥 |
| `wiki-compile` | LLMWiki 编译 | 建链优先于复制 |
| `note-assist` | 笔记写作助手 | 多操作模式 |
| `coach-qa` | 学习答疑 | 带 RAG |
| `query-rewrite` / `rag-rerank` | RAG 改写 / 精排 | 只出 JSON |
| `resource-fix` | 失效资源替换 | 见 §6.5 |
| `direction-guide` | 方向引导 | 第一性原理 |
| `life-post` | 学习人生动态 | 朋友圈口吻 |
| `graduation` | 结业总结 | 笔记 + nextSteps |
| `app-assistant` | 应用内助手 | 简短可执行 |
| `persona-distill` | 人物蒸馏 | 1500–3000 字 system |
| `council` (mode=take/host/single) | 圆桌发言 / 主持 / 单聊 | 人格在服务端 |

### 6.3 NDJSON 流协议

每行一个 JSON：

| 事件 | 含义 |
|---|---|
| `{"t":"d","v":"增量"}` | 正文文本增量 |
| `{"t":"h","v":"思考摘要"}` | 推理模型 reasoning 心跳（**不进正文**） |
| `{"t":"e","v":"错误"}` | 错误 |
| `{"t":"p"}` | 保活 ping（服务端 5s 一次） |
| `{"t":"end"}` | 结束 |

客户端 `streamChat` 只认 `d/h/e`，其余静默忽略。

### 6.4 可靠性工程（不要删这些）

| 机制 | 数值 / 做法 | 为什么 |
|---|---|---|
| 首字节 | 立刻 `push({t:"p"})` | 隧道网关 ~15s 无字节返回 503 |
| 心跳 | 5s `setInterval` | 推理模型首包 30–50s |
| 上游超时 | `UPSTREAM_TIMEOUT_MS = 45s` | |
| 重试 | `MAX_ATTEMPTS = 3`，指数退避，仅可重试状态码 | |
| 预算 | `withBudget()` 并行限流/会话校验，各 1500ms 硬预算 | 跨洋 KV 单次 fetch 曾导致首字节 20–54s |
| 限流 | chat 30 次/60s（IP），注册 5 次/分钟 | |
| 配额 | 服务端 Key 按账号每日限额；BYOK 不计额 | |
| 廉价模型 | `quiz-grade / review-grade / verify-score` 走 `AI_CHEAP_MODEL` | 判分高频、便宜够用 |
| 取消 | 客户端 abort → 服务端 `outer.abort()` | 防止 "Controller is already closed" |

### 6.5 资源管线（`resource-pipeline.ts`）

生成资源 → `/api/linkcheck` 体检（含 YouTube oEmbed / B站 view API 实测单集是否存在）→ 失效或疑似广告 → `resource-fix` 找替代 → 二次体检 → 仍不合格丢弃。
`refineResources` 内部 12s 体检超时 + 20s 修复超时，失败原样返回（**不允许因为修资源把整批计划搞挂**）。

### 6.6 RAG

- 检索源**只有用户自己的笔记**（不做大百科、不做联网搜索产品化）。
- 链路：`query-rewrite` 改写 → 混合检索（BM25 必选 + 向量可选，`EMBED_MODEL` 未配置时纯 BM25）→ `rag-rerank` 精排。
- 使用纪律写在系统提示里：先消化再回答 / 不相关就别说 / 引用要标来源 / 不许假装记过 / 有冲突要指出。

### 6.7 模型配置与 BYOK

优先级：**用户浏览器 BYOK → 服务端 env → 演示模式**。

BYOK 请求头：`x-mentora-key`、`x-mentora-provider`、`x-mentora-model`、`x-mentora-baseurl`（仅 custom）。
服务端**只转发不落盘**，且 `custom` 端点必须过公网 HTTPS 守卫（`url-guard.ts`）。

支持的厂商（`providers.ts`）：`demo / zai / deepseek / moonshot / openai / maas(DemoArts) / custom`。

**demo 模式的语义**：`Settings.provider === "demo"` = 「跟随服务端配置」，**不等于**「没接模型」。
（曾因把它当"演示中"判断，导致所有用户侧栏误显示「正在用演示数据」——已改为读 `/api/health` 的 `channel.ai`，仅服务端真为 demo 时提示。）

---

## 7. 账号 / 同步 / 存储 / 部署

### 7.1 账号

- **注册：邀请码制**（`INVITE_CODE` 环境变量，timing-safe 比对）。**没有邮箱验证码/发信流程**——这是产品决定（README 里「邮箱验证码注册」是过时描述，以代码为准）。
- **忘记密码：邮箱 + 邀请码 + 新密码**，一步重置（`/api/auth/reset-password`）。
- 密码：`crypto.scryptSync` 单向加盐哈希。
- 会话：HMAC-SHA256 签名的 HttpOnly cookie `mentora_session`，含 `sv` 版本号；改密/重置后 `sv` 递增，**旧设备会话全部吊销**。
- 登录有账号失败锁定 + IP 限流。

### 7.2 本地优先 + 云同步

- 本地快照：zustand `persist`，key = `mentora-store-anon`（匿名）或 `mentora-store-${userId}`（登录后）。
- `skipHydration: true` + `setStoreUser(userId)` **切仓**：登录/退出时换 key 并重载该仓快照。
  > ⚠️ 历史坑：`useHydrated` 800ms 兜底早于 `/api/auth/me`，导致写入匿名仓后被切仓覆盖 → 刷新丢数据。改法是等 auth 结果再决定仓，并给足水位。
- 同步协议 `/api/sync`：
  - `GET` 拉当前快照（支持 gzip）；`?versions=1` 列历史版本；`?v=<ts>` 取指定版本。
  - `POST` 上传快照（≤4.2MB，支持 gzip）；写入前把上一份存档到 `versions/<ts>.json`（保留最近 10 份）。
  - 冲突策略：**快照级 last-write-wins**（`overwriteOnConflict`），长期计划是字段级合并。
- `useAutoPush`：数据变化后 2.5s 防抖自动推送；`useFlushOnHide`：关页/切后台前强制 flush；断网排队、恢复重发。

### 7.3 存储通道（一个变量切换，上层只看到 `dbGet/dbPut/dbList/dbDelete`）

`DB_CHANNEL = auto | huawei | upstash | d1 | github`

- `auto`：Upstash → D1 → GitHub 隐式优先级；
- `huawei`：RDS PostgreSQL + DCS Redis；
- 全部数据 **AES-256-GCM 静态加密**，密文落库；
- Cloudflare D1 单次 fetch 硬超时 5s + 3 次重试（300/600/1200ms）；
- GitHub 通道用 sha 做乐观并发。

当前线上用的是 **D1**（`/api/health` 返回 `channel.db = "d1"`）。

### 7.4 AI 输出解析的容错（别简化）

- `extractJson()`：先试 ``` 围栏 → 再做大括号/中括号配对扫描（跳过字符串内部与转义）→ 最后整段 trim。候选按在原文中出现位置排序，避免裸数组时只取到第一个对象。
- `splitGoalReply()`：优先认 `<!--GOAL_READY-->` 标记；没有标记就找 JSON 候选并**把这段 JSON 从正文中剔除**（历史 bug：气泡里出现整段裸 JSON 给用户看）。

### 7.5 部署

| 方式 | 说明 |
|---|---|
| Vercel | `vercel link && vercel --prod --yes`；`maxDuration` 只在这里生效 |
| 华为云（大赛主路径） | RDS/DCS/MaaS + CCE Autopilot 或 ECS + SWR 镜像 + FunctionGraph 定时 + LTS/Cloud Eye，见 `docs/DEPLOY-HUAWEICLOUD.md` |
| 自托管 | `npm run build && npm start`（standalone 输出）；`Dockerfile` 可用 |
| 公网内网穿透（当前实际使用） | `uumit-connector.exe` 把本机 3000 端口映射为 `https://app-3000--laptop-xxxx.uua2a.com` |

> ⚠️ 用 UUMit 时的硬约束：网关对「长时间无字节」的连接约 15s 返回 503。**任何长任务流都必须有心跳（服务端已 5s 一次）**。
> ⚠️ `next start` 从 `.next` 提供服务，**build 会覆盖正在服务的产物**——不要在端到端探针运行期间执行 build。

### 7.6 环境变量（`.env.example`，只列名与用途）

| 变量 | 用途 |
|---|---|
| `AUTH_SECRET` | 会话签名 + 数据加密（**唯一必需项**） |
| `AI_PROVIDER` / `CUSTOM_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | custom 通道 |
| `MAAS_API_KEY` / `MAAS_BASE_URL` / `DEEPSEEK_API_KEY` / `ZAI_API_KEY` / `MOONSHOT_API_KEY` / `OPENAI_API_KEY` | 各服务商兜底 |
| `AI_CHEAP_MODEL` | 判分分级快模型 |
| `EMBED_MODEL` / `EMBED_API_KEY` / `EMBED_BASE_URL` | 向量混排（未配置 = 纯 BM25） |
| `DB_CHANNEL` / `DATABASE_URL` / `REDIS_URL` | 华为云通道 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash 通道 |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_D1_DATABASE_ID` / `CLOUDFLARE_D1_API_TOKEN` | D1 通道 |
| `GITHUB_DB_TOKEN` / `GITHUB_DB_REPO` | GitHub 兜底通道 |
| `ADMIN_PASSWORD` | `/admin` 密码门 |
| `GITHUB_TOKEN` | 反馈 → GitHub Issues |
| `CRON_SECRET` | 定时任务（周报 digest） |
| `RESEND_API_KEY` / `MAIL_FROM` / `APP_URL` | 发信 |
| `INVITE_CODE` | **注册邀请码**（未配置 = 关闭注册） |

---

## 8. 工程质量门禁

改任何东西之前先看这节。这个项目的质量要求是**底线，不是加分项**。

**每轮改完必须过：**

```bash
npx tsc --noEmit                                  # 0 error
npx eslint "src/app/xxx" src/lib/xxx              # 0 error（warning 可容忍）
npm run build                                     # 必须成功
npx vitest run                                     # 单测
E2E=1 npx vitest run e2e                           # 真模型端到端（需本地 dev server）
```

`src/lib/__tests__/` 有 20+ 个单测文件（schema / extract / split-goal-reply / mastery / fsrs 相关 / rag / url-guard / db-channel / demo-parity / seats …）。

**e2e 冒烟**（`e2e.local.test.ts`）：引导 → 总纲要 → 天级计划（两步）→ 每日讲义（必须含 ≥1 条可点在线链接）→ 判分（四级 + 迁移题）→ 读书苏格拉底契约（必须提问且 <500 字）→ 资源修复。**全绿才允许部署。**

**已踩过的坑（别重复）：**

1. **不要退回到「一次生成整阶段」** —— 必然断流。
2. **不要在流开始前做串行跨洋 KV 查询** —— 首字节会被拖到 20–54s，隧道直接 503。现在用 `withBudget()` 并行 + 硬预算。
3. **不要用 `useHydrated` 的短超时兜底** —— 会在 auth 返回前写错仓，刷新丢数据。
4. **不要把裸 JSON 展示给用户** —— 用 `splitGoalReply` / `extractJson`。
5. **不要用 `provider === "demo"` 判断"正在演示"** —— 它是"跟随服务端"。
6. **不要在探针运行时 build** —— 会覆盖 `.next` 打断服务。
7. **Playwright `waitForFunction` 的第三个参数才是 options** —— 写成第二个会静默用 30s 超时。
8. **PowerShell 里路径含 `[id]` 要加引号** —— 否则被当通配符。

---

## 9. 当前状态

### 9.1 已完成且验证

- 学习教练全链路：引导 → 目标卡 → 总纲要 → 天级计划（两步 + 分批 + 断点续跑）→ 每日讲义 → 验收 → 迁移题 → 结业。
- 天级计划弱网修复：本机与**公网域名**双重端到端验证通过（首批落盘 → 强制刷新保住 → 按钮变「继续生成」→ 续跑完成 7 天 → 再刷新仍在）。
- 第二大脑：双链 / 图谱 / FSRS / 建联 / wiki 编译 / Obsidian 导入。
- 读书伙伴：五模式 / 三重验收 / 洞见入库 / RAG。
- 人生伙伴：16 席（12 真人 + 4 思维模型）/ 圆桌 / 锻造。
- 账号（邀请码）/ 加密云同步 / 版本快照 / BYOK / 后台 / 反馈。

### 9.2 待办与已知欠账

- 圆桌 5 个真实问题对比验证（≥3/5 产生新增价值）——代码已完成，人工验证未做。
- 双链 live 编辑时的 `[[` 自动补全。
- IndexedDB 本地持久化（大库离线可靠性）。
- 同步升级：快照 LWW → 字段级合并。
- Token 计量与用量面板；移动端 PWA + 复习推送。
- 读书伙伴 EPUB / PDF 上传（暂缓）。
- `README.md` 里「邮箱验证码注册 / 邮箱找回」是过时描述，实际是邀请码（改文档时注意）。

### 9.3 商业化（`COMMERCIAL.md`）

阶段 0 收费前置：BYOK 主导成本 → 兑换码验证付费意愿 → 分析与监控 → 合规页 → 大陆可达性。
阶段 1 免费增值：免费（本地全功能 + 1 设备同步 + 每日额度）/ Pro（¥19 月或 ¥168 年：多设备、更高额度、LLMWiki 自动编译、图谱导出）。
**现阶段最值钱的不是收入，是留存与使用深度的证据。**

---

## 10. 代码地图（从这里进）

```
src/
  app/
    page.tsx                 登录墙：未登录=落地页，已登录=仪表盘
    login/                   登录/注册/重置（服务端读 ?mode=）
    learn/
      page.tsx               目标列表
      new/page.tsx           引导（intake → 目标卡 → master）
      [id]/page.tsx          产品最复杂页面：阶段/天目录/PhasePlanPanel/单日学习/验收/迁移题
    brain/page.tsx           第二大脑（笔记/图谱/复习/导入）
    read/page.tsx            书架 / read/[id]/page.tsx 单本（五模式对话/验收/洞见）
    council/page.tsx         人生伙伴（单聊/圆桌/锻造）
    life/page.tsx            学习人生（时间线/打卡/热力图）
    settings/page.tsx        BYOK / 语气 / 邮件 / 导入导出
    admin/page.tsx           作者后台
    api/
      chat/route.ts          ★ 唯一 AI 端点（buildSystem + 流 + 限流/配额/心跳）
      auth/*                 注册(邀请码)/登录/me/登出/改密/重置/资料/账号
      sync/route.ts          快照同步（GET 拉/版本；POST 推+存档）
      linkcheck/             资源体检
      feedback/              反馈 → GitHub Issues
      admin/*                后台统计与用户管理
      track/                 埋点
      health/                运维健康检查（含 channel.db / channel.ai）
      cron/weekly-digest     周报
      open/plan              外部只读计划
      debug/auth             调试
  components/
    app-shell.tsx            壳层：侧栏/底栏/登录墙/切仓感知/演示提示
    landing.tsx              落地页
    cmdk.tsx                 命令面板
    assistant-widget.tsx     左下角助手
    feedback-widget.tsx      反馈
    markdown.tsx             渲染（含 [[双链]]）
    ui.tsx                   Button/Card/Input/Modal 等原子
    brain/*                  图谱 / 笔记工作区 / Obsidian 导入 / wiki markdown
    learn/study-heatmap.tsx  热力图
    chunk-recovery.tsx       发布后 chunk 失效自动重载
    error-boundary.tsx       错误边界
  lib/
    types.ts                 ★ 全部领域类型（先读这个）
    store.ts                 ★ Zustand store + persist + 切仓 + 全部 action
    plan.ts                  phaseDraftToDays 等草稿→数据的转换
    mastery.ts               六级掌握状态机
    graduation.ts            结业判定
    rag.ts / rag-pipeline.ts RAG（BM25 + 可选向量 + 改写 + 精排）
    resource-pipeline.ts     资源体检/修复管线
    wiki-compile.ts          LLMWiki 编译
    auth-client.ts           useAuth / useAutoPush / useSyncStatus / useFlushOnHide / syncAfterLogin
    use-chat.ts              流式对话 hook（网络错误翻译、卸载 abort）
    doc-import.ts            文档导入
    obsidian-import.ts       Obsidian 库导入
    verify-heuristic.ts      验收启发式
    period.ts                学习时段主题（按本地时间变色）
    use-poptext.ts           标题手写体动效
    use-typewriter.ts        打字机
    use-visual-viewport.ts   移动键盘 inset
    track.ts                 埋点
    ai/
      prompts.ts             ★ 全部系统提示词（核心资产，服务端独占）
      client.ts              ★ streamChat + 全部 zod schema + extractJson/splitGoalReply
      providers.ts           厂商注册表
      demo.ts                演示模式脚本化 AI（全流程可体验）
      persona-meta.ts        人格元数据（前端展示用的名字/标签/颜色）
      reading-modes.ts       五模式规范
      embedding.ts           向量
    server/
      db.ts                  ★ 存储通道（auto/huawei/upstash/d1/github）+ withBudget
      auth.ts                scrypt + HMAC 会话 + 版本吊销
      ai-config.ts           BYOK 解析 + 服务端配置
      quota.ts               服务端 Key 每日配额
      rate-limit.ts          IP 限流（持久）
      url-guard.ts           SSRF/HTTPS 守卫
      config.ts              envStatus + 事件日志
      admin-auth.ts          后台密码门
      mail.ts                发信（周报）
      deploy-env.ts          构建版本/是否部署
  lib/__tests__/             20+ 单测（schema/E2E/rag/fsrs/seats…）
```

**根目录文档**：`README.md`（对外介绍）· `ACCEPTANCE.md`（38+ 条验收基线）· `ENGINEERING.md` · `CHANGELOG.md`（版本演进）· `COMMERCIAL.md`（商业化）· `docs/PRD-*.md`（产品需求）· `docs/PROJECT-obsidian-doc.md`（最完整的设计取舍与踩坑日志，**要深挖历史决策就读这篇**）。

---

## 11. 接手须知（给下一个 AI 的操作纪律）

1. **先跑起来再动手**：`npm run dev`（无配置即演示模式，全流程可体验）。要真模型就设 `AI_PROVIDER=custom` + `CUSTOM_API_KEY` + `AI_BASE_URL` + `AI_MODEL`。
2. **改 AI 链路前先读** `src/lib/ai/prompts.ts` 顶部的工程说明 + `api/chat/route.ts` 的 `buildSystem`。
3. **改数据结构前先读** `src/lib/types.ts` 和 `store.ts` 的 `setPhasePlan` / `importData` / `setStoreUser`——这三个是数据一致性的关键。
4. **任何"生成很慢/中途断开"的问题**，先看是不是单次请求太大：优先拆请求，而不是加超时。
5. **不要为了"看起来完整"而编数据**：这个产品的立身之本是"验收不放水、不承诺做不到的事"。同理，文档与汇报也必须是实测结果。
6. **不要把提示词搬去前端**，哪怕是为了"方便调试"。
7. **验证要用真实链路**：起本地 dev/prod server，用真模型跑一遍（`E2E=1`），而不是只看单测。
