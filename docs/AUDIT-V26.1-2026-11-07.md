# Mentora V26.1 第一轮全站审计报告（架构问题与根因）

**日期：** 2026-11-07
**审计范围：** PRD V26.1 全部 12 个用户报告问题 + §11 潜在问题清单
**审计方式：** 代码级取证（file:line），不修改任何代码
**基线：** commit `653c0e5` 之后的 master（含 v25.0 阅读、v24.x 智能体、会员体系）

---

# A. 当前架构问题清单（结构性，不是单点 Bug）

| # | 架构问题 | 影响 | 关联用户 Bug |
|---|---|---|---|
| A1 | **任务生命周期由页面组件持有**：学习计划/讲义/引导生成全部是页面内 `streamChat` 调用（`learn/[id]/page.tsx:780-860,852+`、`learn/new/page.tsx:230+`），组件卸载 = 任务死亡，结果只经页面回调落库 | 切页即中断、无法恢复 | Bug2 |
| A2 | **主对话的"运行态"是组件级单例**：`pending/tools/plan/pendingActions/reasoning` 全是 `agent-home.tsx` 的 useState；多会话共用同一份运行态缓冲 | 切会话串台 | Bug1、Bug3 |
| A3 | **结果落库按"完成时刻的 activeId"**：`appendAgentMsg`（`agent-home.tsx:286`）写入完成时的 `agentActiveId`——生成中途切会话，回答落进**别的会话** | 串台的核心根因 | Bug1 |
| A4 | **Agent 没有计划修改能力**：工具表里没有任何 modify_plan 类工具；"调整第二阶段"这种请求只能靠 5 轮只读检索打转后撞上限 | Bug12 的深层根因 | Bug12 |
| A5 | **资源约束没有解析与校验机制**：规划提示词有"视频偏好硬规则"（`prompts.ts:152` 视频单集直链、:152 区块"用户偏好是硬规则"），但它只读 `ctx.learnerProfile`；**主对话框路径的规划调整根本不设置 learnerProfile**，且生成后无程序化资源类型校验、无大陆可访问性优先级 | Bug4 全部三个症状 | Bug4 |
| A6 | **阅读创建无真实性验证**：`read/page.tsx` create 直接 `streamChat(reading-plan)`（:27-48），无任何存在性核查 | Bug9 | Bug9 |
| A7 | **学习人生足迹是"事件日志"**：每个"新掌握"事件（含 目录/MOC 类笔记）都进足迹（`life/page.tsx:118,289-307`） | Bug5 | Bug5 |
| A8 | **回答质量判定缺"资源类型维度"**：评测器结构断言不含资源类型/可访问性检查 | Bug4 无法被测试拦截 | Bug4 |

# B. 已确认 Bug 清单（根因 + 证据）

| BugID | 现象 | 根因（file:line） | 严重度 |
|---|---|---|---|
| B1 | 切会话后生成内容串到其他会话 | A2+A3：`appendAgentMsg` 按"完成时 activeId"落库（`agent-home.tsx:286`）；pending/tools/plan 为组件级共享缓冲 | P0 |
| B2 | 切页面导致计划生成中断且不可恢复 | A1：页面内 streamChat + 卸载放弃结果（`learn/[id]/page.tsx:780+`）；无服务端任务持久化 | P0 |
| B3 | 思考过程串对话 / 答非所问 | B1 同源：reasoning 缓冲组件级共享；切换后显示上一任务 reasoning | P0 |
| B4 | 明确要视频仍给文档 | A5：agent 路径无 ResourceConstraint；planner 硬规则依赖 learnerProfile 未被设置；无生成后校验 | P0 |
| B5 | 视频全是 YouTube（大陆不可达） | `prompts.ts:152` 视频规则把 YouTube 与 B站并列为合法来源，无"大陆可访问优先"分级，无可访问性状态标注 | P0 |
| B6 | 不存在的书也生成 | A6：`read/page.tsx:27-48` 直入 reading-plan，零验证 | P0 |
| B7 | 计划/阶段无修改入口 | 学习页只有"计划缺失时重新生成"（`learn/[id]/page.tsx:1053`）与天级"重新生成"（:1716），无阶段级修改/重生成入口；Agent 无 modify 工具（A4） | P0 |
| B8 | 发消息不滚到最新 | `agent-home.tsx` 无任何 scrollIntoView（grep=0） | P1 |
| B9 | 不存在的书仍生成 = B6 | 同 B6 | P0 |
| B10 | 删除按钮溢出卡片 | 学习卡删除钮 `ml-auto`（learn/page.tsx）在窄屏与徽章/长 meta 挤压下溢出（移动端截图证实）；全局同类卡片需排查 | P1 |
| B11 | "单轮工具调用上限 5 次"中断复杂任务 | `MAX_TOOL_ROUNDS=5`（protocol.ts:275）+ **A4 无修改能力**导致 5 轮全花在只读检索上（截图：12 次工具卡全是 看详情/检索/读全文）；文案"单轮…5 次"还误导（实为轮数） | P0 |
| B12 | 工具结果英文残句泄漏进回答（截图5："…to see stage list"） | 非硬编码（grep 无此文案）= 模型复述工具返回的英文残句；现有 trimMetaEdges 只剪首尾无汉字行，混有中文的英文句漏过 | P1 |
| B13 | 学习人生记录粒度过细（掌握「目录」也进足迹） | A7 | P1 |
| B14 | 新用户无引导 | 无任何引导组件/状态 | P1 |

# C. 潜在问题清单（未在用户报告中出现，审计主动发现）

| # | 风险 | 证据 |
|---|---|---|
| C1 | 会话 tabs 只渲染前 8 个（`sessions.slice(0,8)`），更多会话只能靠右栏"会话"列表 | `agent-home.tsx` tabs 区 |
| C2 | `agentSessions` 不在云同步 FIELDS 里——换设备丢全部主对话历史 | `sync/route.ts` FIELDS |
| C3 | 多标签页 store 回采（bindStoreSync）可能把旧 agentSessions 盖回内存 | `store.ts:1189+` |
| C4 | 工具结果与回答之间无"引用/复述"边界，模型复述工具返回时混入英文/元话语（B12 的族类） | 截图5 |
| C5 | 配额（60 次/日）在长任务多轮工具循环下按请求计费——一次复杂对话可烧 5+ 次配额，用户感知"没聊几句就到限" | `quota.ts` 按请求计数 |
| C6 | 计划生成无幂等键：双击/重连可能重复建任务（PRD 2.2 要求） | 页面 streamChat 无 dedupe |
| C7 | 移动端 composer 与底栏遮挡已在 v24.0.9 修过首页，学习卡删除钮属同类问题的另一处（B10） | 移动端截图 |
| C8 | resume_workflow/handoff 类英文残句泄漏（B12）与评测器已有泄漏检测（eval 侧）不同步到产品端 | runner 过滤器 |

# D. 根因与影响范围汇总

四大根因覆盖全部 12 个 Bug：
1. **任务生命周期归页面**（A1）→ B2（切页中断）；修 = 服务端 GenerationTask 持久化 + 客户端订阅/恢复，影响 learn 全链路与 chat 协议。
2. **运行态单例 + 落库按完成时 activeId**（A2/A3）→ B1/B3；修 = 会话级任务上下文 + 按 sessionId 路由事件与落库，影响 agent-home 与 runner 回调。
3. **能力缺口 + 预算语义**（A4）→ B11（上限中断）+ B7（无修改入口）；修 = 新增计划局部修改工具/页面入口 + 预算耗尽时"基于已有信息收尾"。
4. **资源约束无解析无校验**（A5/A6/A8）→ B4/B5/B6；修 = ResourceConstraint 解析 + 生成后程序化校验（type/region/存在性）+ 大陆优先分级 + 书籍存在性核查。

# E. 推荐修复顺序（对应 PRD 十三，按本审计调整）

| 轮 | 内容 | 说明 |
|---|---|---|
| 一（本报告） | 审计 | ✅ 已完成 |
| 二 | **核心架构**：①agent 会话级任务上下文 + 事件路由（修 B1/B3，中等工作量）；②学习计划生成的服务端任务持久化 + 恢复（修 B2，最大工作量，建议先做"计划生成"单点，讲义/引导后延） | PRD 阶段二 |
| 三 | **AI 质量**：ResourceConstraint 解析（agent 工具参数级）+ 生成后程序化资源校验（type/region）+ 大陆优先分级 + 书籍存在性核查（复用 web_search）+ 计划局部修改工具 | PRD 阶段三 |
| 四 | **交互**：滚动（B8）、阶段/计划修改入口（B7）、学习人生改结果层（B13）、新手引导（B14）、删除钮布局（B10） | PRD 阶段四 |
| 五 | 回归：PRD §12 场景 A-H 全部脚本化进 eval 体系（部分已有：意图/深讲；新增：并发切换/视频约束/书籍验证/预算收尾） | PRD 阶段五 |

# F. 预计修改文件与数据结构

| 修复项 | 预计涉及 |
|---|---|
| 会话级任务隔离（B1/B3） | `agent-home.tsx`（pending/tools/plan 改为 per-session 或按 sessionId 过滤）、`store.ts`（appendAgentMsg 带显式 sessionId）、`runner.ts` 回调携带 sessionId |
| 计划生成服务端任务化（B2） | 新增 `/api/tasks`（创建/查询/结果）+ KV `tasks/<userId>/<taskId>.json`（状态机 queued/running/completed/failed）+ `learn/new`、`learn/[id]` 改为提交任务+轮询/恢复；**Vercel 60s 上限是硬约束**——长任务需拆段（phase-list/phase-detail 本就分步，天然适配任务化）或明确"仅自托管支持完整后台任务" |
| 计划修改（B7/B11 深层） | 新增 agent 工具 `modify_plan`（局部改某阶段，保留其他阶段与完成记录）+ `learn/[id]` 阶段卡"修改/重新生成"入口；store 需 `setPhasePlan` 局部写 |
| 资源约束（B4/B5） | `tool-executors.ts`（解析约束参数）+ `prompts.ts`（PLANNER/LESSON 接收 resourceConstraint + 大陆优先分级 + 可访问性状态字段）+ 生成后校验器（新纯函数+测试：type/region 断言、失败降级不崩溃） |
| 书籍验证（B6） | `read/page.tsx`（先 web_search 核查 → A/B/C/D 分支 UI）+ 复用 agent 的 web_search |
| 滚动（B8） | `agent-home.tsx`（底部哨兵 + 用户上滚检测） |
| 足迹改结果层（B13） | `life/page.tsx`（过滤 目录/MOC 类、按里程碑聚合） |
| 引导（B14） | 新组件 + settings 持久化引导完成标记 |
| 删除钮布局（B10） | `learn/page.tsx` 等卡片 flex 结构统一 |

**数据结构变更**：GenerationTask（若做任务化）为新增 KV 命名空间，不动现有结构；ResourceConstraint 为 agent 工具参数与校验器的内存结构，不落库；学习人生为展示层过滤，不动数据。

---

## 待用户确认的三个产品决策（不确认不开发）

1. **学习人生位置**：PRD §7.2 建议"学习 tab 下第三个子页（教练/读书/学习人生）"；你的话是"侧栏放到学习下面、人生伙伴下面"。二选一：①侧栏顺序改 Mentora→学习→人生伙伴→学习人生→设置；②学习页加第三个 tab，侧栏去掉独立学习人生。**推荐②**（与 PRD 一致，侧栏更短）。
2. **任务化范围**：完整后台任务（PRD 2.2 全量）在 Vercel Serverless 60s 上限下需要队列/Worker，工作量大；**推荐先做"计划生成单点任务化"**（KV 状态机 + 断线恢复 + 计划分步天然适配），讲义等短任务保持现状。自托管（腾讯云主力）可后续做完整版。
3. **思考过程展示**：PRD 2.3 建议不展示原始推理。现状是"思考摘要行"（非全量思维链）。建议：保留阶段标签（理解中/检索中/生成中），去掉 reasoning 文本摘要——确认？

---

## 与既有工作的关系

- 评测体系（v24.1 建立的 fixtures/归档/前后对比）将按 PRD §12 扩展：场景 A-H 逐个脚本化，作为每轮修复的回归门。
- 审计中确认的既有护栏（流式无增量超时、审批门、打转守卫、私有独白过滤）与本 PRD 无冲突。
- B12 的泄漏过滤已在 v24.0.5-10 做过一轮（首尾无汉字行），本次是"混有中文的英文句"新形态，归入同一过滤器族迭代。
