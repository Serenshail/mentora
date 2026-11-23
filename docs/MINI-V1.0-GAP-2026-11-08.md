# Mentora Mini V1.0 PRD 差距分析（2026-11-08）

PRD = 《Mentora Mini V1.0 开发总指令》+ 用户补充指令（学习教练功能按阅读功能同等标准纳入 V1.0）。
最终验收支柱：完整阅读流程 / AI 阅读工具 / 三重验收 / 知识沉淀 / 跨端数据同步；学习教练侧同标准外推：完整学习流程 / AI 学习工具 / 验收门 / 知识沉淀 / 跨端数据同步。
范围纪律：**未经用户确认不扩大范围**——下表未列入 P0 的项一律不做，列入 P1/P2 并在交付报告「未解决与风险」如实说明。

## 差距清单

### A. 阅读线（对标 Web 阅读系统 V1.0）

| # | PRD 支柱 | 差距 | 优先级 | 说明 |
|---|---|---|---|---|
| A1 | 完整阅读流程 | 读书页无认知地图展示（数据已存 map 字段但 UI/上下文不用） | **P0** | book 页顶部认知概览四区域 + 注入 bookCtx |
| A2 | AI 阅读工具 | 无阅读目标（四成果），三重验收失去加权依据 | **P0** | reading-goal 推荐 + 四成果 chip 可改 → setBookGoal |
| A3 | 三重验收 | 完全缺失（explain/connect/apply 出题+判分+四级判定+掌握写回） | **P0** | assess-gen/grade 接入 + 失败本地兜底三题 + markChapterMastered + assessments 存档 |
| A4 | 完整阅读流程 | 节点/整本状态机缺失（无「标记读完」「整本验收」「确认已掌握」，readStatus 不落） | **P0** | 五态最小实现：手动读完=finished、整本验收=assessing+recall-check、确认已掌握=mastered |
| A5 | 知识沉淀 | 七类一句话沉淀、节点小结 recap、待解决问题全部缺失 | **P0** | deposits + reading-recap → 入第二大脑（source=read）+ unresolvedQuestions |
| A6 | 知识沉淀 | 书籍核查已对齐（learn.js 三态弹窗） | 已达成 | V26.2 同判据移植已存在，本轮回归验证 |
| A7 | AI 阅读工具 | 五模式对话 + 模式切换开场协议 | 已达成 | 同语义在位 |
| A8 | 完整阅读流程 | 迁移任务 transfer/复检/结业/加节点/路线重排/策略推荐 | P1 | 本轮不做，Web 端完成；报告如实声明 |

### B. 学习教练线（用户新增，同等标准）

| # | PRD 支柱 | 差距 | 优先级 | 说明 |
|---|---|---|---|---|
| B1 | 完整学习流程 | 苏格拉底引导建目标完全缺失（小程序无法从零建目标） | **P0** | 新增 coach 引导页：task=intake 多轮 → splitGoalReply 移植 → 目标卡+直接生成 |
| B2 | 完整学习流程 | 总纲要/阶段天目录/单日细节生成缺失（引导完无计划） | **P0** | task=plan 三模式（master/phase-list/phase-detail）+ masterDraftToPlan/phaseDraftToDay 移植 + store setPlan/setPhaseCatalog/setDayDetail |
| B3 | AI 学习工具 | 讲义/答疑/验收判分/迁移门/跳过 | 已达成 | 同语义在位（本轮回归验证） |
| B4 | 验收门 | 迁移真门（pendingUnlock）+ 强制跳过 | 已达成 | 在位 |
| B5 | 知识沉淀 | 验收通过 → 第二大脑（MOC/双链/复习档） | 已达成 | addLearnKnowledge 在位 |
| B6 | 知识沉淀 | 结业回路（needsGraduation 落库但无 UI） | P1 | 本轮不做（Web 端完成），报告声明 |
| B7 | AI 学习工具 | 答疑无第二大脑 RAG 证据（ragCtx 恒空） | P1 | 本轮不做，报告声明（Web 端体验完整） |
| B8 | 完整学习流程 | 阶段重排/计划资源约束体检/enableReview 开关 | P1/P2 | 不做，报告声明 |

### C. 通用线

| # | 差距 | 优先级 | 说明 |
|---|---|---|---|
| C1 | 注册页文案「邀请码」与现行「激活码」不符 | **P0**（文案） | 字段名 inviteCode 已兼容，改标签+说明 |
| C2 | 跨端数据同步链路 | 已达成 | 本轮场景三实测验证 |
| C3 | chat.js 无 t=end 断流校验 | **P0**（小改） | 与 Web 同语义：没收到 end 按失败处理（保 err.partial） |
| C4 | 429/配额/到期文案透传 | 已达成 | 服务端返回人话文案，chat.js 已透传 e.message |

## P0 汇总（第六步实施范围）

- **B1+B2 学习教练闭环**（coach 引导页 + 计划三模式 + store 计划写路径）——最大缺口
- **A1-A5 阅读系统补齐**（地图/目标/三重验收/状态机/沉淀）
- **C1 注册文案 + C3 断流校验**
- 全量回归：四门禁 + 三个端到端场景

## 不做清单（如实报告）

迁移任务与独立复检、结业回路（goal+book）、reading-strategy 策略推荐、reading-add-node、路线重排（full/core/goal）、RAG 注入、阶段重排、enableReview、资源 linkcheck 体检、agent 智能体（首页 Codex 形态）——均属 Web 端完成项或下轮范围，符合「不扩大 V1.0 范围」纪律。
