# AUDIT-V26.2 — 第二轮代码审计报告（只读）

**项目**：Mentora V26.2 专项整改 · 阶段 0 交付物
**日期**：2026-11-07
**基线**：`447269b`（tag `v26.1`，整改前最后稳定提交）
**审计对象**：`4218277`（master，tag `v26.1.5-isolation`，当前生产）
**窗口提交**：`3a45ed6 → 5a7bad5 → 59e7af2 → afa868f → 28604f7 → 4218277`（共 6 个功能提交 + 2 个文档提交）
**审计纪律**：未修改任何代码、未执行数据库迁移、未删除任何文件、未覆盖任何用户数据、未部署。唯一写入 = 本报告。
**方法**：git 全量 diff + 逐文件读码 + 关键论断双源复核（两路独立探查 + 主审计逐条 grep/读码取证）。所有 file:line 均为当前工作区（=4218277，工作树干净）实测。

---

## 0. 结论速览

| # | 判断 | 一句话 |
|---|---|---|
| 1 | 学习人生原有功能**组件与数据完好，入口完全断裂** | `LifeWorkspace` 是旧页逐行等价抽取，但从未被渲染——侧栏「学习人生」点进去看到的是学习教练内容 |
| 2 | 原有数据**零丢失** | store 数据层在整改窗口唯一改动是 `appendAgentMsg` 签名；persist version 8 未动；无任何迁移 |
| 3 | V26.1 修改**绝大部分应保留**，不需要整体回滚 | 会话隔离/任务化/资源约束/书籍核查/预算语义都是真实修复；需修的是 1 个渲染分支 + 4 条书籍验证绕过路径 + 3 条泄漏路径 |
| 4 | 最严重的工程问题是**验证造假风险** | PRD §12 场景 A-H 冒烟脚本写好了但从未执行（交付文档自认"生产验收待执行"），交付表格的 ✅ 是"脚本就绪"不是"执行通过" |

---

## 1. (A) 文件级差异报告

窗口内共 29 个文件，+3256 / −394 行。

### 1.1 新增文件（11 个）

| 文件 | 行数 | 性质 |
|---|---|---|
| `src/lib/plan-tasks.ts` | 118 | 计划生成任务模块注册表（SPA 切页存活）+ KV 状态 |
| `src/app/api/tasks/route.ts` | 70 | 任务状态 KV 持久化（鉴权+按用户加密，安全） |
| `src/lib/resources.ts` | 110 | 资源约束解析/URL 分类/程序化校验 |
| `src/lib/agent/phase-regen.ts` | 136 | 阶段重排（regeneratePhase） |
| `src/components/life-workspace.tsx` | 315 | 学习人生工作台（旧 life 页逐行抽取，见 §2） |
| `src/components/onboarding-modal.tsx` | 98 | 新手引导弹窗 |
| `src/lib/__tests__/resources.test.ts` | 85 | 资源校验 9 测试 |
| `src/lib/__tests__/meta-filter.test.ts` | 148 | B12 语言过滤 8 组测试 |
| `scripts/smoke-v26.mjs` | 495 | PRD §12 场景 A-H 冒烟（**已就绪，从未执行**） |
| `scripts/site-sweep.mjs` | 110 | 站点巡检脚本 |
| `docs/`（AUDIT-V26.1 / V26.1-DELIVERABLES 等） | ~380 | 文档 |

### 1.2 修改文件（17 个，按风险排序）

| 文件 | 增/删 | 改动内容 | 风险 |
|---|---|---|---|
| `src/app/learn/page.tsx` | +9 | tab 扩为三个 + 引入 LifeWorkspace + 删除钮 flex-wrap | **P0（见 §2.3）** |
| `src/components/life/page.tsx`→重定向壳 | −313/+7 | 旧页整体迁出为组件，路由 307 → `/learn?tab=life` | P0 关联 |
| `src/lib/agent/runner.ts` | +99 | B12 句级过滤 + 预算文案 + 收尾赋值 | P1（清洗覆盖不均，§4.3） |
| `src/components/agent-home.tsx` | +69 | runSessionId 渲染门控×6 + reasoning 停显 + 后台生成指示 | 保留（残余风险 §4.3） |
| `src/lib/store.ts` | +24/−8 | `appendAgentMsg(msg, sessionId?)` 显式会话回写，不改 agentActiveId | 保留（数据安全，§3） |
| `src/components/read-workspace.tsx` | +107 | 建书前 /api/search 核查 + 四分支弹窗 + 强制粘贴 | P0 关联（绕过路径 §5） |
| `src/lib/agent/tool-executors.ts` | +130 | update_plan_resources + regenerate_phase + web_search 工具 | P0 关联（add_book 无核查 §5） |
| `src/lib/agent/protocol.ts` | +19 | 新工具注册 | 低 |
| `src/app/learn/[id]/page.tsx` | +25 | 阶段卡「重排本阶段」按钮（window.prompt + force=true） | P1（§6） |
| `src/app/learn/new/page.tsx` | +55 | 总纲要生成接 plan-tasks 注册表 + KV 状态 | 保留 |
| `src/components/app-shell.tsx` | +4 | NAV /life 高亮归 learn + OnboardingModal 挂载 | 低 |
| `docs/*` | — | 审计/交付/评测归档 | 低 |

### 1.3 删除文件（1 个）

`docs/evidence/eval-intent-ui-2026-11-06-32246bf.json`——被更新的归档（b76abd8 版）替代，属评测产物正常换版，**无功能代码被删除**。

**明确回答 PRD §3.2 的问题**：整改窗口内没有任何生产代码文件被删除；学习人生旧页面文件保留（改为重定向壳）；不存在"被删未恢复的文件"。

---

## 2. (B) 功能保全清单 —— 学习人生专项

### 2.1 组件层比对：旧 `life/page.tsx`（447269b，313 行）vs 新 `life-workspace.tsx`（315 行）

逐段比对结论：**新组件是旧页的逐行等价抽取，唯一功能差异是一处有意的过滤**：

- `life-workspace.tsx:62-65`：mastered 事件排除「目录/学习总纲要/MOC」骨架条目（注释：V26.1 §7.4 结果层语义）。这是本 PRD 认可的方向性改进。

原 9 项功能全部在组件层保留：

| # | 原有功能 | 旧实现位置 | 新实现位置 | 状态 |
|---|---|---|---|---|
| 1 | 学习日历热力墙 | life/page.tsx:131 | life-workspace.tsx:133 | ✅ 逐行相同 |
| 2 | 学习进行时（进度环/当前任务/连续天数） | :134-174 | :136-176 | ✅ 相同 |
| 3 | 笔记与复习卡 | :176-192 | :178-194 | ✅ 相同 |
| 4 | 读书伙伴卡 | :194-215 | :196-217 | ✅ 相同 |
| 5 | 人生伙伴卡 | :217-229 | :219-231 | ✅ 相同 |
| 6 | AI 教练朋友圈动态（life-post） | :232-250 | :234-252 | ✅ 相同 |
| 7 | 里程碑相册格（近 8 个验收通过） | :252-270 | :254-272 | ✅ 相同 |
| 8 | 空态引导 | :272-285 | :274-287 | ✅ 相同 |
| 9 | 足迹时间线（40 条事件流） | :287-310 | :289-312 | ✅ 相同 + 骨架过滤 |

### 2.2 数据层比对

新旧组件读取的字段完全一致：`goals`（含 `quizLog`）、`knowledge`（含 `masteredAt`）、`sessions`（圆桌）、`books`、`settings.userName`、`useDueReviews()`。**没有任何数据查询失效**。

### 2.3 P0 根因：入口断裂（三处叠加，全部实证）

**这是"学习人生疑似被替换或丢失"投诉的完整解释——功能没丢，但用户在当前版本中根本无法到达它：**

1. **Tab 零渲染分支（根因）**。`src/app/learn/page.tsx:96` 是全页唯一的 tab 条件渲染：
   ```tsx
   {tab === "read" ? (<ReadWorkspace />) : (<>…学习教练内容…</>)}
   ```
   `LifeWorkspace` 在 `:14` 被 import，**全库 grep 零渲染调用**（唯一出现处 = import 行与组件定义）。点击「学习人生」tab：按钮高亮变化、内容仍是学习教练——用户感知"点了没反应/功能没了"。
   该分支从引入（59e7af2）起就不存在，此后 4 个提交均未补上。

2. **URL 参数只认 read**。`learn/page.tsx:48`：
   ```tsx
   if (new URLSearchParams(window.location.search).get("tab") !== "read") return;
   ```
   `?tab=life` 被直接忽略。

3. **侧栏/重定向全部汇入死胡同**。`app-shell.tsx:47` 侧栏第二项即「学习人生」→ `/life` → `src/app/life/page.tsx` 307 → `/learn?tab=life` → 落在学习教练 tab。**侧栏首屏第二个入口指向的内容是错的。**

### 2.4 为什么测试没有拦住（重要工程教训）

- `scripts/smoke-v26.mjs:412-414` 场景 F 的作者**知道** URL 缺陷（注释原文："?tab=life 只认 ?tab=read 直达，life 需点一下 tab"），并断言点击 tab 后 body 含「掌握了「顺序表的插入删除」」——该文本只存在于 LifeWorkspace 的足迹时间线。**按当前代码执行，F1 必然 FAIL（25s 超时）**。
- 但 `docs/V26.1-DELIVERABLES.md:58` 自认："场景 A-H……**生产验收待执行**"。而同文档 §交付对照表（L91-98）却将场景 B/C/D/F/G/H 逐条标 ✅——✅ 的语义是"脚本已就绪"，不是"执行通过"。实际跑过的生产冒烟只有 "`/life` 307 重定向 + health OK"（L74），恰好拦不住本缺陷。
- 这正是本 PRD §13 警告的"不能仅根据代码中存在某个函数就认定功能完成"的实例。

### 2.5 其他已有功能保全核查

| 功能 | 状态 | 证据 |
|---|---|---|
| 学习教练（引导/总纲/天级/讲义/验收） | ✅ 未触碰 | 窗口 diff 仅 +任务化接线与重排按钮 |
| 读书伙伴（五模式/三重验收/迁移/结业） | ✅ 保留 | read-workspace 仅加核查逻辑 |
| 圆桌/人生伙伴 | ✅ 未触碰 | 窗口零 diff |
| 第二大脑 | ✅ 未触碰 | 窗口零 diff |
| 小程序 12 页 | ✅ 未触碰 | 窗口零 diff（但建书核查缺失，§5） |
| 云同步/版本快照/错误边界 | ✅ 未触碰 | 窗口零 diff |

---

## 3. (C) 数据安全报告

### 3.1 数据层结论：零丢失、零迁移、零破坏

- **store.ts 在窗口内的全部改动 = `appendAgentMsg` 支持 `sessionId?` 参数**（+24/−8 行，§1.2）。数据模型、persist 结构、迁移函数零改动；`version: 8`（store.ts:1679）与基线一致。
- **窗口内没有任何数据库/存储结构变更**：无 db.ts 改动、无 D1 schema 改动、无迁移文件。学习人生数据（quizLog/masteredAt/sessions）与所有用户数据存储路径完全未触碰。
- 唯一新增存储 = `tasks/<userId>/<taskId>.json`（api/tasks/route.ts），隔离在独立命名空间，带会话鉴权 + 加密 + 字段长度上限，与既有用户数据零交集。

### 3.2 "数据丢失"感知的机理判定

按 PRD §3.2 要求区分五种情况——本例属于第 2 种（**页面入口被隐藏/破坏**），不属于其他四种：

| 可能情况 | 是否发生 | 证据 |
|---|---|---|
| 代码被删除 | ❌ | 组件逐行保留（§2.1） |
| **页面入口被隐藏/破坏** | ✅ **就是它** | §2.3 三处叠加 |
| 数据查询失效 | ❌ | 读取字段与基线逐字一致 |
| 数据库结构被改变 | ❌ | 窗口零迁移 |
| 旧数据没有迁移 | ❌ | persist v8 未动 |

### 3.3 备份与恢复能力（未受影响，仍然在位）

- 本地 persist v8 + 云端 KV 加密快照 + `/api/sync` 版本快照（`versions/<uid>/<ts>.json`，v17 机制）。
- 历史事故工具链（mentora-db git 历史、restore-users-from-github.mjs）未受影响。
- **恢复学习人生 = 修复入口代码即可，无需任何数据恢复操作**（详见 §7 恢复方案）。

---

## 4. (D) Agent 执行链路报告

### 4.1 完整链路（当前 4218277 实测）

```
用户输入 agent-home.tsx:238
  → appendAgentMsg(userMsg) 取回 runSid（发起会话 id）
  → streamChat(task="agent") → /api/chat (route.ts: buildSystem+工具契约)
  → runner.ts 工具循环（≤5 轮；```tool 解析→执行→结果回注→再问）
  → NDJSON 事件流：t=d 正文增量 / t=h 思考心跳 / t=tc 原生工具调用 / t=e 错误
  → agent-home.tsx 渲染：pending 气泡、AgentTrace 阶段、工具卡、计划时间线
  → runAgent 返回 → appendAgentMsg(answer, runSid) 落回发起会话（store.ts:1526 显式回写不动 agentActiveId）
```

### 4.2 对照 PRD §4.1 四层隔离：已达成与未达成

| 层级 | PRD 要求 | 现状 |
|---|---|---|
| Agent 内部执行不可见 | ✅ | **基本达成**：reasoning 文本已停显（agent-home.tsx:277 `onReasoning: () => {}`；基线是 `reasoning.slice(-40)` 直显上屏——这是整改前最典型的泄漏，已根修） |
| 工具执行事件默认不可见 | ⚠️ 部分 | 工具卡/计划时间线/AgentTrace 是**设计性可见过程**（只显示 label + 人工编写的 summary + 时长，如"3 篇：…"；原始 `ToolResult.content` 只回注模型，不进 UI）。符合 shadcn AI Elements 式过程展示，**不属于泄漏** |
| 任务状态摘要可见 | ✅ | 阶段标签三态（"正在理解你的问题…/正在调用工具…/准备回答"，agent-home.tsx:641-645） |
| 最终回答干净 | ⚠️ 部分 | §4.3：主路径已清洗，仍有 3 条泄漏路径 + 1 个过度清洗问题 |

### 4.3 仍存在的问题（按影响排序）

**P1-A｜流式气泡是残余泄漏主通道**。`agent-home.tsx:282` 的 onDelta 只剥 ```tool/```plan 围栏，其余逐字上屏；英文私语（如 "Fine. Give final answer briefly."）、围栏外裸 JSON、内部过渡语在流式期间直接可见，直到正式清洗后的消息替换（先脏后净，两帧不一致）。

**P1-B｜五个收尾赋值点绕过 B12 清洗**。`stripMetaSentences` 只套在 runner.ts:211、287 两处；`:193`（取消/断连）、`:236/240`（noTools 重试）、`:274/277`（打转强制收尾）只过 `stripDirectives`——这些路径的产出会被**持久化**为最终消息（agent-home.tsx:294-313），半截流的私语可随之上库。

**P1-C｜错误 toast 泄漏上游原始响应体**。route.ts:401 `` `上游模型返回 ${res.status}：${text.slice(0, 300)}` `` → client.ts:140 throw → agent-home.tsx:323 `toast.error(...)`。上游网关错误体（可含 provider 内部报文/HTML）前 300 字直接弹给用户。

**P1-D｜过度清洗反噬回答正确性（"答不对题"投诉的头号嫌疑）**。runner.ts:484 `if (!CJK_CHAR.test(s)) return true;` 把**所有无汉字句子整句剔除**——外语学科的英文例句、全英文回答、"It depends." 式短答都会被静默吞掉；`META_EN_WORDS` 的宽泛词（tool/report/confirm）与 `/to see |to view /` 也会误伤教学句。测试只覆盖"该删的删"，没有"不该删的英文内容保留"用例。另外工具轮 >60 字门槛会把多轮短正文整轮丢弃。

**P1-E｜注释与实现不符（死变量）**。runner.ts:290-291 `hasWriteCall`/`looksLikeSelfTalk` 声明后从未使用（基线 447269b 已如此，非整改引入）——"写入类工具的过渡语一律不并入最终回答"的注释是空头承诺，写入轮 >60 字、含汉字、未踩元话语正则的过渡语仍会并入正文。

**P2｜取消/断连路径产出半截流**（runner.ts:193）与孤儿会话可能（运行中删除发起会话后回写，store.ts:1501-1512 会新建不可见会话接住消息——无泄漏但产生孤儿数据）。

### 4.4 会话隔离（PRD 场景 F 前提）：真实实现

- `appendAgentMsg(msg, sessionId?)`：显式回写不改 `agentActiveId`（store.ts:1526）；无显式才跟随激活（用户刚发出消息的场景）。
- 渲染门控 6 处：pending 气泡/审批卡/AgentTrace/计划/工具卡/停止按钮全部 `runSessionId === activeId`（agent-home.tsx:594/605/652/366/388/714）。
- 后台完成提示：agent-home.tsx:722-726 "上一段对话仍在后台生成中"。
- B2 任务化真实接线：learn/new 用裸 `streamChat`（脱离 useChat 卸载即 abort）+ `startPlanTask` 注册表 + KV 状态（含 interrupted 兜底）。**这部分是真实实现，不是"代码存在"式的假完成**——但浏览器整页刷新仍会杀死流（KV 只保证"发生过"语义，场景 A04/A03 的完整闭环待场景脚本执行验证）。

---

## 5. (E) 书籍真实性验证报告

### 5.1 建书入口矩阵（4 个入口 × 核查覆盖）

| 入口 | 位置 | 核查 | 结论 |
|---|---|---|---|
| ① UI 手动添加（空材料） | read-workspace.tsx:49-79 | ✅ /api/search + 图书域名白名单 + 标题前 8 字匹配，不过则弹窗暂停 | **本版新增且生效** |
| ② UI 手动添加（粘贴任意材料） | read-workspace.tsx:49 `if (!pasted.trim())` | ❌ **粘贴哪怕 1 个字符即完全免检**，直接 generateBook | 绕过路径 B1 |
| ③ agent `add_book` 工具 | tool-executors.ts:712-724 | ❌ **零核查**：审批通过即直接 `task:"reading-plan"` 生成目录/章节 | 绕过路径 B2（与投诉最吻合） |
| ④ 小程序建书 | miniprogram/pages/learn/learn.js:155-196 | ❌ 零核查，直连 reading-plan | 绕过路径 B3 |
| （demo 模式） | demo.ts:404 demoReadingPlan | ❌（按设计编演示内容，可接受） | 低风险 |

### 5.2 核查实现本身的问题

- **通过标准弱**（read-workspace.tsx:61-66）：前 5 条搜索结果中 ≥1 条命中图书类域名（豆瓣/百科/出版社/京东/当当…）且标题含书名**前 8 字符**子串。纯字符串包含，snippet 不参与；超 8 字书名或结果标题被改写即误杀，编造书名前 8 字恰好出现在百科标题即漏放。无同名不同作者的区分（PRD C4 场景无法通过）。
- **异常静默放行**（:78）：`catch { /* …会在生成结果里如实标注未经核实 */ }` ——**"未经核实"标注是空头承诺**：全库检索，该承诺只存在于注释（:78）与弹窗文案（:345），`Book` 类型无任何 verified/来源字段，`generateBook` 与 `store.addBook` 均未写标注。
- **用户强推降级流**（:356-362）：确认弹窗强制先粘贴原文/目录——这部分是真实实现的（空粘贴会被 toast 拦截）。但生成结果同样无"未核实"标记。

### 5.3 判断：投诉是否成立

**部分成立。** UI 空材料主路径的核查是 V26.1 新增且真实生效（基线 447269b 完全无核查，276 行旧版直接生成）；但"编造书名直接生成内容"在当前版本可通过三条路径完整复现，其中 **agent 对话路径（模型发起 add_book → 用户批准 → 直接生成）与投诉形态最吻合**：协议描述（protocol.ts:187-193）、审批卡（仅展示书名/作者/简介）、执行器三层均无任何核实动作，AGENT_CHAT 提示词也无"先核实书籍存在"的指令。生成端 READING_PLAN 提示词只有"（待核）"措辞纪律，不阻止为不存在的书编出完整章节结构。

---

## 6. 学习计划修改（PRD §6 对照）

- **现有入口**：① 当前活动阶段卡「重排本阶段（换一批学习日）」按钮（learn/[id]/page.tsx:1049-1073，ghost 小按钮、进入天详情视图即消失）；② agent 工具 `regenerate_phase`（审批卡）；③ agent 工具 `update_plan_resources`（**仅接受视频类约束**，其余资源调整提示"请在学习页进行"——但学习页并无对应 UI）；④ `modify_plan` **不存在**（全库零命中）。
- **PRD §6.1 要求的入口对照**：查看计划 ✅ / 修改阶段 ⚠️（仅整体重排）/ 重新生成阶段 ⚠️（同上，且**仅限当前活动阶段**——已通过/未解锁阶段在路径设计列表零入口）/ 调整资源 ❌（UI 无）/ 调整时间 ❌ / 暂停 ❌ / 删除 ✅（列表卡）。
- **regeneratePhase 的真实行为**（phase-regen.ts:113-126 + store.ts:628-660）：
  - 新目录每天生成**全新随机 id** → `plan.days` 里旧 day 对象成为孤儿（不删除），`phase.dayIds` 整体替换 → `countCompletedDays` 按新 dayIds 计算归 0 → **该阶段"已完成 N 天"显示被清零**，旧成绩（goal.quizLog）数据仍在但脱离阶段结构不可见。
  - `:77` 与 `:116-117` 两处注释声称"沿用 id 保留记录引用""按 title 保留 quizLog 引用"——**均为虚假注释**，代码无对应实现。这直接违反本 PRD §6.4"不得因为重新生成而清空用户已经完成的进度"。
  - 无版本历史/撤销（PRD §6.4 要求的当前版本/上一版本/修改原因均无存储）。
  - UI 按钮 `window.prompt` 收集不满原因后**直接 force=true**，无二次确认弹窗；agent 审批卡 `actionPreview` 无 `regenerate_phase` 分支（agent-home.tsx:101-114 返回 null），payload 里的完成日警告不会展示在卡上。

---

## 7. (F) 风险清单（P0/P1/P2）

### P0（发布阻断级）

| # | 风险 | 位置 | 说明 |
|---|---|---|---|
| P0-1 | 学习人生入口断裂 | learn/page.tsx:96/:48、app-shell.tsx:47、life/page.tsx | 侧栏+tab+URL 三条路径全部失效；功能实际不可达（§2.3） |
| P0-2 | 书籍验证绕过矩阵 | read-workspace.tsx:49/:78、tool-executors.ts:712、miniprogram learn.js:155 | agent 路径+小程序零核查；粘贴免检；"未核实"标注零实现（§5） |
| P0-3 | 验收证据缺失 | V26.1-DELIVERABLES.md:58 vs :91-98 | 场景 A-H 从未执行但表格标 ✅；发布门槛（PRD §15"生产环境验证通过"）实际未满足 |

### P1（高优先）

| # | 风险 | 位置 |
|---|---|---|
| P1-1 | 流式气泡裸显未清洗输出（泄漏主通道） | agent-home.tsx:282 |
| P1-2 | 5 个收尾赋值点绕过 B12 清洗并持久化 | runner.ts:193/236/240/274/277 |
| P1-3 | 无汉字句整句剔除过度清洗 → 外语教学内容被吞、答不对题 | runner.ts:484 + META_EN_WORDS |
| P1-4 | 阶段重排清零完成日显示 + 孤儿 day + 虚假注释 + 无版本历史 | phase-regen.ts:77/:116-126、store.ts:628 |
| P1-5 | 错误 toast 泄漏上游响应体前 300 字 | route.ts:401 → agent-home.tsx:323 |
| P1-6 | 非当前阶段零修改入口、无局部编辑、审批卡不显示完成日警告 | learn/[id]/page.tsx:1166、agent-home.tsx:101 |
| P1-7 | 建书核查标准弱：无同名区分、snippet 不参与、前 8 字子串误杀/漏放 | read-workspace.tsx:61-66 |

### P2（记录在案）

| # | 风险 | 位置 |
|---|---|---|
| P2-1 | hasWriteCall/looksLikeSelfTalk 死变量，注释与实现不符（基线已有） | runner.ts:290-291 |
| P2-2 | 取消/断连产出半截流持久化 | runner.ts:193 |
| P2-3 | 运行中删除发起会话 → 回写新建不可见孤儿会话 | store.ts:1501-1512 |
| P2-4 | plan 文本未过私语过滤，模型元话语可进计划时间线 | agent-home.tsx:366 |
| P2-5 | 整页刷新后 KV 任务状态可能永久停在 running（interrupted 兜底只覆盖同目标新任务） | learn/new/page.tsx:151 |
| P2-6 | `update_plan_resources` 提示"请在学习页进行"但学习页无对应 UI（死路指引） | tool-executors.ts:538 |

---

## 8. (G) 恢复方案

### 8.1 明确回答：不需要整体回滚

V26.1 的六组修改经逐项核实，**五组半是真实且有价值的修复**，整体回滚会重新打开已修好的串台/中断/资源违约/预算文案问题。应采取**最小修复**而非回滚：

| V26.1 修改 | 处置 | 依据 |
|---|---|---|
| B1/B3 会话隔离（appendAgentMsg 显式 sessionId + 渲染门控 + 不拽 agentActiveId） | **保留** | store.ts:1526 + 6 处门控实证真实 |
| B2 计划任务化（plan-tasks + /api/tasks） | **保留** | 接线真实，仅补刷新恢复边界（P2-5） |
| B4/B5 资源约束（resources.ts + update_plan_resources） | **保留** | 9 测试在库，校验逻辑实证 |
| B6/B9 书籍核查（UI 空材料路径） | **保留并补全** | 补 B1-B3 绕过路径 + 标注落库 |
| 学习人生第三 tab（决策①） | **保留，修渲染分支** | 组件完好，1 个条件分支 + 1 行 URL 判断即恢复 |
| B8 自动滚动 / B10 删除钮 / B14 引导弹窗 / 预算文案 / reasoning 停显 | **保留** | 实证无副作用 |
| B12 语言过滤 | **保留但收窄** | 整句剔除规则需豁免"含实质内容的非中文句"（P1-3） |

### 8.2 学习人生恢复方案（最小修复，Git 历史无需动）

1. `learn/page.tsx`：渲染分支补 `tab === "life"` → `<LifeWorkspace />`（约 3 行）；URL effect 改为接受 `read|life`（1 行）。
2. 冒烟补断言：`/life` 直接 307 后落地页 body 必须含 LifeWorkspace 特征文本（现有场景 F 的 F1 断言天然覆盖，**前提是它真的执行**）。
3. 无数据操作、无迁移、无回滚风险；旧版回退锚点 tag `v26.1.5-isolation` 在位。

### 8.3 数据恢复：无需执行

数据层零丢失（§3）。唯一需要的"恢复"是把已达数据重新接上显示层（§8.2）。

---

## 9. (H) 第二阶段实施计划（待批准后执行）

| 项 | 文件 | 技术方案 | 依赖 | 测试标准 |
|---|---|---|---|---|
| H1 学习人生入口恢复 | learn/page.tsx | 补 life 渲染分支 + tab URL 解析泛化 | 无 | smoke-v26 场景 F **真实执行** PASS；PRD B1-B8 |
| H2 书籍验证补全 | read-workspace.tsx / tool-executors.ts / miniprogram learn.js / types.ts+store.ts | `verifyBook()` 抽为共享服务；add_book 执行器接入；小程序接入；粘贴路径也核查；Book 加 `verification: verified\|unverified\|user_material` 字段落库展示 | H1 无关可并行 | PRD C1-C8，C2/C3/C5 强制阻断 |
| H3 泄漏三路收口 | agent-home.tsx / runner.ts / route.ts / client.ts | onDelta 复用 stripMetaSentences；5 个收尾点统一过清洗；错误 toast 改用户话术（原始体进 console） | 无 | PRD A1-A5 |
| H4 过度清洗修正 | runner.ts isMetaSentence | 无汉字句剔除加豁免：代码块（已有）+ 引用/例句标记 + 深讲语言学科上下文 | 无 | meta-filter 测试补"不该删保留"组 |
| H5 阶段重排语义修复 | phase-regen.ts / store.ts setPhaseCatalog | 按 title 对齐沿用旧 day id（保 quizLog/成绩引用）；重排前快照进 plan 历史栈；UI 显示版本 | H1 | PRD D1-D7 |
| H6 修改入口补全 | learn/[id]/page.tsx | 路径设计列表各阶段卡补「修改阶段」入口；审批卡 actionPreview 补 regenerate_phase 分支展示 completed | H5 | PRD G3 |
| H7 冒烟纪律 | scripts/smoke-v26.mjs | 场景 A-H 纳入部署门禁（先本地后生产），交付表 ✅ 语义改为"执行通过+证据链接" | H1 | 交付文档含 evidence 文件 |

执行顺序建议：H1（半天）→ H3/H4（并行）→ H2 → H5/H6 → H7 收口回归。全程遵守 PRD 阶段 0-6 顺序与"先本地 e2e 全绿再部署"纪律。

---

## 10. 三个问题的明确回答

**问 1：学习人生原有功能到底还在不在？**

**在。组件与业务逻辑 100% 保留**——`life-workspace.tsx` 是旧 life 页（313 行）的逐行等价抽取，9 项功能（热力墙/学习进行时/笔记复习/读书/人生伙伴/教练动态/里程碑/空态/足迹时间线）全部在位，唯一差异是有意的结果层过滤（目录/总纲要/MOC 不再算"掌握"）。**但在当前生产版本中用户不可达**：渲染分支从未写上（learn/page.tsx:96 只有 read 二元分支）、`?tab=life` 不被解析、`/life` 重定向落在教练 tab。用户看到的现象（点侧栏「学习人生」出来的是学习教练内容）由此完全解释。修复 = 约 4 行代码 + 真实执行一次场景 F 冒烟。

**问 2：原有数据有没有丢失？如果有，能否恢复？**

**没有丢失，无需恢复。** 整改窗口内：store 数据层唯一改动是 `appendAgentMsg` 增加可选 sessionId 参数；persist version 8 与迁移函数零改动；无任何数据库迁移；学习人生读取的全部字段（quizLog/masteredAt/sessions/books/knowledge）存储路径未触碰；云端同步与版本快照机制未触碰。新存储 `tasks/<userId>/` 是隔离的独立命名空间。学习事件的入库链路（验收/跳过/掌握/圆桌 → store → 云同步）一直在正常工作——只是这些数据聚合出的学习人生界面没有渲染入口。恢复显示层后所有历史记录立即可见。

**问 3：V26.1 的哪些修改应该保留，哪些应该回滚？**

**全部保留，零整体回滚；需要的是补修，不是撤销。** 会话隔离（显式 sessionId + 渲染门控 + 回写不拽视图）实证真实且直击串台根因；计划任务化接线真实；资源约束解析/校验有测试兜底；UI 手动建书核查是基线完全没有的新能力；预算文案、reasoning 停显、自动滚动、删除钮布局、新手引导均为低风险净改善。需要**收窄**的只有 B12 语言过滤（过度剔除无汉字句，反噬回答正确性）；需要**补全**的是学习人生渲染分支（P0-1）、书籍验证的 agent/小程序/粘贴三条绕过路径（P0-2）、以及从未执行的场景 A-H 冒烟（P0-3）。没有任何一处 V26.1 改动需要 `git revert`。

---

## 11. 审计证据附注

- 全部 file:line 引文经主审计逐条 grep/读码取证；两路独立探查的结论中，与主审计取证不符的零条。
- 基线对照文件：`git show 447269b:src/app/life/page.tsx`、`git show 447269b:src/components/read-workspace.tsx`、`git show 447269b:src/lib/agent/runner.ts` 已逐段比对。
- 工作树在审计期间保持干净（`git status` 无变更）；审计用临时比对文件已删除。

*本报告为阶段 0 唯一交付物。在获得批准前，不进入任何代码修改。*
