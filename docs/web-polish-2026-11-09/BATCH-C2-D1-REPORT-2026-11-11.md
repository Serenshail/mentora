# 批次 C 二轮 + 批次 D 首轮实现报告

**日期：** 2026-11-11 ｜ **依据：** 用户指令（R06→R02→R04→直接推进批次 D）
**状态标注（按用户要求）：** 批次 C 累计为「**批次 C 首轮（7 工具）+ 二轮（6 工具）**」；阅读整体仍在推进（R06 的深度讨论体验还需真实模型调优）。D1 阻塞的真实验收单列保留，本轮开发不依赖它。

## 1. 本轮交付

### 1.1 键盘测试修复（并发重构的定位更新）

书卡组件被并发进程从 `read-workspace.tsx` 迁到新组件 `reading-shelf.tsx`，且可达性**升级**（整卡 onClick 移除，标题与「打开阅读」均为真实 `<Link>` 带 aria-label/focus-visible，删除按钮动态 aria-label）。测试重写为 v2：锁定新语义 5 项（书名链接、CTA aria-label、focus-visible、无 tabIndex/role=button、删除按钮原生可命名）。**5/5 通过。**

### 1.2 R06：接着读、讨论材料、检验理解

| 能力 | 实现 |
|---|---|
| 讨论材料 | `get_book` 新增 `chapterTitle` 参数——返回章节完整材料上下文：核心论点/本章问题/关键概念/其他观点/前置/预期成果/验收锚点/**该章已有沉淀（保留原话）**/上次验收结果（避免重复出题）+ `/read/{id}` 接续入口。模型拿到这些即可在对话里直接讲解 |
| 检验理解 | 新工具 `record_book_assessment`（write）：kind（explain/connect/apply）+ level（mastered/partial/not/ungradable）+ **evidence 必填**（引用原话或指出缺什么——判而不解释=无效判）。落库 `addChapterAssessment`；level=mastered 同时 `markChapterMastered`（masteredAt 只能来自验收通过，纪律不变） |

### 1.3 R02：修改书目、删除书籍

- `update_book`：newTitle/author 字段差异预览（重名拒绝）；执行后章节/进度/验收/沉淀全保留。
- `remove_book`：审批卡列出**全部影响**——章节数（含已完成/掌握数）、对话条数、沉淀条数、验收档案数、迁移记录数、洞见数 + 「第二大脑笔记不受影响；随云同步双端不可恢复」。

### 1.4 R04：重排阅读路线（先预览后应用 + 恢复）

- `rebuild_reading_route`：**校验阶段即真实生成**新路线（修正页面侧 F03 模式——旧流程批准时看不到新方案），审批卡展示新旧章节对照；批准后 `snapshotBookRoute` → `regenerateBookRoute`（验收归档、沉淀/对话/洞见保留）。
- 冲突检测：`bookRouteSignature`（书名/目标/路线类型/章节标题序列）——批准到执行之间被改则拒绝（EX-15）。
- store 新增：`Book.routeHistory`（5 条上限）+ `snapshotBookRoute` + `restoreBookRoute`（恢复前先快照当前版，可再回退；恢复只动章节列表与路线类型）。
- `restore_book_route`：按 version 恢复，预览「现 vs 恢复为」对照。
- 3 项真实 store 测试锁定恢复语义。

### 1.5 批次 D 首轮：人生伙伴 C01/C02/C05/C06

| 工具 | 覆盖 | 行为 |
|---|---|---|
| `get_session`（read） | C01 | 消歧定位会话，返回与会人物/议题（首条用户消息）/最近 3 条消息/接续入口 |
| `create_session` 增强 | C02 | `participants` 显式指定圆桌阵容；`opening` 议题作为**第一条用户消息**存入——已讨论问题不丢 |
| `manage_session`（write） | C06 | rename（预览新旧名）/ delete（先展示消息数与不可恢复提示） |
| `forge_persona`（write） | C05 | **校验期蒸馏**，身份核对说明（identityNote）与「模拟视角」声明进审批卡，核对后入库；id 带 `custom:` 前缀 |

**C03/C04 未做（如实标注）：** 发起/继续圆桌讨论的执行引擎在 council 页面闭包内（多席位流式+主持汇总），抽成共享库是独立重构，本轮不声称已接入。首页现有路径是 `resume_workflow` 返回 /council 接续入口。结论→笔记/学习目标已可经 `save_note`/`create_goal` 完成（C06 部分已存在）。

## 2. 工具总数与测试

- 智能体工具累计 **30 个**（首批 22 + C 一轮 7 + 二轮/D 新增 8、增强 2）。写工具清单测试有意迁移（fix-01 更新）。
- 新增测试：reading-notes-tools 扩至 **46 项**（R02/R04/R06/D 全覆盖，含 rebuild 校验期生成的 mock 生成路径）、book-route-history 3 项、键盘测试 v2 5 项。
- 全量 `npm test`：**1233 通过 / 0 失败**（190 文件）——并发破坏的键盘测试已修复，套件全绿。
- `tsc --noEmit` exit 0；lint 0 error；`next build` ✅。

## 3. 能力矩阵更新口径

| 编号 | 本轮后 | 剩余 |
|---|---|---|
| R02 | **已接通**（改字段/删书均带影响展示） | — |
| R04 | **已接通**（路线重排预览→应用→恢复；节点顺序上轮已通） | — |
| R05 | 已接通（上轮） | — |
| R06 | **部分接通**（章节材料上下文+验收落库已通；深度讨论体验待真实模型调优） | 首页与阅读工作区的讨论体验统一 |
| C01 | **已接通** | — |
| C02 | **已接通**（阵容+议题传入） | — |
| C05 | **已接通**（蒸馏→核对→入库） | — |
| C06 | **部分接通**（rename/delete/结论转笔记或目标已通） | — |
| C03/C04 | **未接通**（引擎在页面闭包，待抽取） | 批次 D 后续 |

## 4. 改动文件

```
新增  src/components/reading-shelf.tsx 由并发进程产出（书卡迁移）；本批仅更新其测试
改动  src/lib/__tests__/read-book-card-keyboard.test.ts（v2 重写）
改动  src/lib/types.ts            （BookRouteHistory + Book.routeHistory）
改动  src/lib/store.ts            （snapshotBookRoute / restoreBookRoute）
改动  src/lib/agent/protocol.ts   （+8 工具注册：record_book_assessment/update_book/remove_book/rebuild_reading_route/restore_book_route/get_session/manage_session/forge_persona；create_session 增强）
改动  src/lib/agent/tool-executors.ts（resolveSession 消歧 + bookRouteSignature + 2 个异步校验器 + 执行分支）
改动  src/components/agent-home.tsx（审批卡预览分支扩容）
新增  src/lib/__tests__/book-route-history.test.ts（3 项）
改动  src/lib/__tests__/reading-notes-tools.test.ts（46 项）
改动  src/lib/__tests__/fix-01-agent-pipeline.test.ts（写清单 += 7）
```

## 5. 交付目标核对（用户设定）

> 「用户能通过智能体找到一本书、继续讨论、检验理解并调整阅读安排」

- **找到一本书** ✅（get_book 消歧 + 详细状态）
- **继续讨论** ✅（章节材料上下文 + 接续入口 + 保存沉淀）；深度讨论的模型体验待真实调优
- **检验理解** ✅（record_book_assessment 落库，通过即记掌握，evidence 纪律）
- **调整阅读安排** ✅（改目标/进度/顺序/重排路线全部预览→应用→可恢复）

## 6. 待办（下一步）

1. **C03/C04**：圆桌讨论引擎从页面闭包抽成共享库后接入首页（批次 D 主体）。
2. R06 深度讨论体验的真实模型调优（与 in12/in16 两轮、UI 走查合并安排，等 D1 恢复）。
3. 批次 E：全站收口（能力矩阵全覆盖、历史与大数据、辅助页面）。
