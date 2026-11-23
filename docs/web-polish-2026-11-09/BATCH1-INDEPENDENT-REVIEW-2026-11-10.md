# 第一批实现的独立验收复核

日期：2026-11-10 · 复核者：Codex · 依据：当前磁盘代码、原始评测归档与本轮隔离探针

## 结论

当前不能将第一批 P0 整体标为验收完成。已复跑原有 4 个相关测试文件，39 项通过；使用真实内存 Store 与实际编辑执行器新增的 7 项独立验收探针，7 项均失败。失败是业务断言未满足，并非测试启动或模块导入错误。

本轮未改产品实现，未操作真实账户、真实学习数据或本地网页；未调用模型、重新启动 dev server、执行 git stash 或提交。没有重新运行全量测试、类型检查或构建，旧报告中的这些结果属于前一执行者的记录。

## 1. 实测发现

| 编号 | 严重程度 | 复现场景与实际结果 | 违反的预期 |
|---|---|---|---|
| R1 | P1，阻塞本批验收 | 仅传 boundaryChanges，执行返回成功，但边界仍为原值 | AG-03/08：批准的修改应真实写入 |
| R2 | P1，阻塞本批验收 | 单独删除阶段，或单独调整阶段顺序，planHistory 均为 0 条 | AG-04/L09：修改前须有该次可恢复记录 |
| R3 | P1，阻塞本批验收 | 修改阶段 title/outcome/estDays 后恢复，返回 true，但三个字段仍为新值 | AG-04：恢复应覆盖本次实际修改的计划字段 |
| R4 | P1，阻塞本批验收 | 草稿形成后另一处修改标题；执行旧草稿仍返回成功，覆盖新标题 | AG-02/DATA-02、EX-15：冲突需重新展示差异，不能沿用旧批准静默覆盖 |
| R5 | P1，阻塞本批验收 | phaseOrder 含重复 ID，应用后实际产生重复阶段；编辑不存在的阶段 ID 仍得到成功草稿 | AG-01/03/08：输入应验证真实对象与结构不变量，不能伪成功 |

7 条失败对应 R1 一条、R2 两条、R3 一条、R4 一条、R5 两条。不能把“7 条探针”误写成 7 个互不相关的缺陷。

### 代码定位与原因

- R1：[phase-edit.ts](D:/zcode/agent/mentora/src/lib/agent/phase-edit.ts:242) 只有 catalog 和 dayDiff 都存在时才调用 setPhaseCatalog；单独修改 boundary 被跳过，但最终统一返回成功。
- R2：[applyPhaseEdit](D:/zcode/agent/mentora/src/lib/agent/phase-edit.ts:224) 只快照 perPhase。perPhase 来自元信息、目录、边界的编辑，删除的阶段又被跳过；纯增删/排序没有相应结构快照。此外，[restorePlanVersion](D:/zcode/agent/mentora/src/lib/store.ts:929) 找不到原阶段就退出，不能恢复已删除阶段。后一项为源码确认，本轮删除测试在“没有快照”处即失败，未继续到恢复断言。
- R3：[snapshotPhase](D:/zcode/agent/mentora/src/lib/store.ts:875) 未记录 outcome/estDays；[恢复实现](D:/zcode/agent/mentora/src/lib/store.ts:953) 恢复目录和边界，未恢复阶段标题等元信息。
- R4：[edit_phase 执行入口](D:/zcode/agent/mentora/src/lib/agent/tool-executors.ts:944) 用最新状态重新计算并立刻应用，没有与批准时的版本/差异比较。重新计算不能替代冲突检测与重新决定。
- R5：[方案计算](D:/zcode/agent/mentora/src/lib/agent/phase-edit.ts:119) 未拒绝未知阶段引用；[排序应用](D:/zcode/agent/mentora/src/lib/agent/phase-edit.ts:280) 按输入逐个映射，同一阶段 ID 可被加入多次。

## 2. 证据与复现

- [探针源码](D:/zcode/agent/mentora/docs/evidence/batch1-independent-review-2026-11-10/probe.ts)
- [独立配置](D:/zcode/agent/mentora/docs/evidence/batch1-independent-review-2026-11-10/probe.config.mts)
- [原始结果](D:/zcode/agent/mentora/docs/evidence/batch1-independent-review-2026-11-10/results.json)

在 `D:\zcode\agent\mentora` 运行：

```powershell
node node_modules/vitest/vitest.mjs run --config docs/evidence/batch1-independent-review-2026-11-10/probe.config.mts
```

这些探针使用生产 Store 与执行器，在独立 Node 测试进程中装入专用数据，不做浏览器/模型/云端请求。文件名为 probe.ts，不进入默认 npm test 的测试匹配范围；必须用上述配置显式运行。它们断言 PRD 预期行为，故当前失败应保留为修复证据，不能反向修改断言让缺陷通过。

现有测试复跑命令：

```powershell
node node_modules/vitest/vitest.mjs run src/lib/__tests__/phase-edit.test.ts src/lib/__tests__/agent-aq-fixes.test.ts src/lib/__tests__/store-snapshot.test.ts src/lib/__tests__/fix-01-agent-pipeline.test.ts
```

结果：4 文件 / 39 测试通过。默认 phase-edit 测试主要验证方案计算，未实际导入 applyPhaseEdit 执行上述行为，不能凭其文件注释推断已完成写入链路验证。

## 3. 评测口径待决项 EVAL-01

**用户同意登记待决项；尚未改评测器、重算正式通过率或改变产品行为。**

### 当前证据

1. [浏览器评测脚本](D:/zcode/agent/mentora/scripts/eval-intent-ui.mjs:119) 使用 routeOk 判定。direct 路径调用 CJKOK，门槛是中文且长度大于 60；[API 评测器](D:/zcode/agent/mentora/scripts/eval-agent.mjs:80) 的 direct.answer 才是大于 120。因此不能将浏览器 in09 的原因直接解释为“120 字门槛”。短翻译不该依赖统一最小字数，这个产品方向可以成立，但必须改对实际运行的断言。
2. 当前浏览器脚本没有执行 intent.noDump。handoff 路径检查工具标签或文本正则；归档 in12 使用了长期记忆/检索笔记，未使用交接工具，文本亦未命中当前交接正则。[API 侧 intent.noDump](D:/zcode/agent/mentora/scripts/eval-agent.mjs:93) 检查的是问卷式提问，不是检索过程。因此“in12 因引述检索过程触发 noDump”不受当前代码支持。
3. in12 原文先询问学习用途与基础，这是合理的候选行为，但它也根据笔记/记忆为空说“那就是从零开始”。空资料不等于零基础，此句仍应人工评估。不能以允许澄清为由豁免整条回答的内容质量。
4. 当前 PRD 要求关键缺失信息应澄清，禁止普通概念问题被强行建目标；它没有要求所有“我想学 X”都绝对不得创建草稿。需要明确“先澄清”和“建草稿后补背景”在什么情况下分别合格。
5. 浏览器评测归档只有文本片段、工具标签、配额和总结果，没有实际持久化 background 字段。in11 等通过能支持交接行为发生，不能单凭模型说“已写入背景”证明背景字段已正确保存。修复代码和单测提供另一层证据，端到端验证仍应直接读取新对象。

以上针对**当前磁盘脚本**。归档只标 HEAD，未固定未提交脚本和提示词的内容哈希；若执行时版本不同，应补对应版本后再认定运行时原因。

### 建议校准规则（待确认后版本化）

- 简答/翻译：按任务完成、语义正确、无无关流程判断；取消统一字数下限，用拒答、空输出、截断等专门检查兜底。
- 薄意图规划：接受有针对性的必要澄清；允许范围明确的草稿式交接，但不得将猜测写成既知用户事实。是否创建正式计划是另一项判断。
- 工具交接：检查对象确实创建、指定背景字段完整、未重复创建；不能只看工具标签或成功文案。
- 每个运行保存具体检查项结果、完整或受控存储的原始输出、实际对象结果、提供商/模型、提示词与脚本哈希、独立 runId。
- 新口径以新版本重评，保留旧结果，不覆盖旧口径失败，不为单个样本临时加豁免。

## 4. 模型归档的额外限制

[当前回答归档](D:/zcode/agent/mentora/docs/evidence/eval-agent-2026-11-10-facf520.json) 的 summary 为 10/10，存在两个 mergedRuns 时间，ds04 保存的是复跑通过输出。报告文字将首轮记为 9/10 是正确的统计区分，但这份合并文件本身不足以独立复核首次失败的完整输出与检查项；应保留不可覆盖的首轮原始归档。

一次复跑通过只能说明该次输出通过了对应检查，不能证明首次问题一定与代码无关。结构标记通过也不等于解释正确、用户真正学懂。

意图归档保留 21 通过、2 未通过、7 配额中断的原始分类。配额中断不是已证明的模型错误，也不是成功；完整 30 例结论仍未取得。待校准项不要提前改标为通过。

## 5. 建议的下一步

优先修复 R1–R5，并让这 7 条独立验收探针通过；尤其统一“修改一次”和“恢复一次”的范围，不能只补一条目录快照就宣称增删/排序可恢复。随后补真实计划编辑 UI 走查和端到端数据检查。EVAL-01 同时校准，但不以重跑模型替代数据正确性修复。此后再扩展第二批阅读/人生伙伴能力。
