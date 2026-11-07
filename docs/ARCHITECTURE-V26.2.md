# ARCHITECTURE-V26.2 — 架构变化说明

**日期**：2026-11-07　**基线**：447269b → 4218277 审计（[AUDIT](./AUDIT-V26.2-2026-11-07.md)）→ 本轮 H1-H7 修复

## 1. 本轮新增的架构单元

| 单元 | 文件 | 职责 |
|---|---|---|
| BookVerificationService | `src/lib/book-verify.ts`（新） | 三条建书路径共用的真实性判定：可信书目来源过滤 + 双侧标题归一化 + 作者匹配。返回 verified / insufficient / unsearchable 三态（PRD §5.4）。纯判定函数 `judgeBookEvidence` 可单测 |
| 阶段重排历史栈 | `store.snapshotPhase` + `Goal.planHistory`（新，可选字段） | 重排前深拷贝旧目录（≤5 条，只增不删）；UI 在路径设计列表按阶段展示历史版本 |
| 阶段重排对齐器 | `phase-regen.alignPhaseDayIds`（新纯函数） | 新目录与旧天按标题对齐沿用旧 id——quizLog/成绩引用与「已完成 N 天」显示在重排后保留（修复审计 P1-4 的"清零"） |

## 2. 变更的链路

### 2.1 建书链路（三入口统一核查语义）

```
UI 手动添加 ──┐
agent add_book ──┼→ verifyBook()/judgeBookEvidence ─→ verified：正常生成，Book.verification="verified"
小程序 create ──┘        │
                         └→ insufficient/unsearchable：暂停。
                            用户坚持且提供原文材料 → 生成但 Book.verification="user_material"（书架+详情页标注）
                            无材料 → 拒绝生成（agent 路径：工具返回 ok:false，由模型如实转述并索要材料）
```

- 修复审计 P0-2 的四条绕过路径：粘贴材料免检（UI 现在也核查）、搜索异常静默放行（改为 unsearchable 弹窗）、agent `add_book` 零核查（协议新增 `material` 参数）、小程序零核查（`api.searchBooks` + showModal 流程）。
- "未经核实"标注从注释空头承诺变为落库字段 + 双端展示。

### 2.2 Agent 输出清洗链路（四层，均在渲染/落库前）

```
模型增量 ─→ onDelta: 剥 tool/plan 围栏 + stripMetaSentences（流式气泡实时干净，H3-A）
   │
   ├→ 收尾赋值 7 处统一过 stripMetaSentences∘trimMetaEdges∘stripDirectives（取消/重试/打转/预算路径不再绕过，H3-B）
   ├→ 工具轮次正文：写入类工具轮次（hasWriteCall 真生效）不并入最终回答
   └→ 错误路径：上游响应体只进服务端 logEvent，用户 toast 是人话（H3-C）
```

### 2.3 清洗的语境判定（H4，替代 B12 的"无汉字一概剔"）

`stripMetaSentences` 先按非代码段判定**整个回答的语言**：
- 中文回答里混入的无汉字句组 = 泄漏，整组剔（B12 行为保留，锁用户实测泄漏形态）；
- 整段英文回答 = 教学内容，句子级只剔私语形态（独白引导词开头的短句 / "to see|to view" 复述），`META_EN_WORDS` 词表不再参与英文回答路径（report/tool/confirm 是教学普通词，按词表剔误伤实质内容）。

## 3. 没有变化的部分（明确边界）

- 四层隔离架构（内部执行/工具事件/状态摘要/最终回答）与事件通道维持 V26.1 形态，本轮未引入新事件协议（PRD §17 约束）。
- 数据模型零迁移：persist version 8 不变；`verification`/`planHistory` 均为可选字段。
- 不重写 Agent 系统、不引入消息队列、不动导航信息架构（/life 仍重定向并入学习工作台第三 tab，决策①不变）。
