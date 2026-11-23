# 第二批 C 实现报告：阅读与笔记业务动作（AG-05）

**日期：** 2026-11-11 ｜ **依据：** PRD AG-05、[能力矩阵](./CAPABILITY-MATRIX.md) R01–R07 / N01–N05、交付计划批次 C
**范围声明：** 本轮接入首页智能体可**直接执行**的阅读与笔记业务动作；R06（针对当前材料的讨论/节点检验/全书验收）与路线重生成（需模型生成内容）仍走阅读页工作区，本轮不声称覆盖。人生伙伴（AG-06/C01–C06）属批次 D，未开始。

## 1. 新增工具（7 个）

| 工具 | 风险 | 覆盖 | 行为 |
|---|---|---|---|
| `get_book` | read | R01 | 按 title/id 消歧定位，返回目标/路线类型/逐章状态/进度/沉淀迁移计数，含 `id=` 供后续精确定位 |
| `edit_book_goal` | write | R03 | 预览旧→新（主/次目标、为什么读、当前基础），批准后 `setBookGoal`；`inferred=false`；主目标变化时提示可重排路线且验收沉淀保留 |
| `set_reading_progress` | write | R05 | 章节状态（reading/done/skipped/todo，支持序号定位）+ 全书 readStatus；**手动 done 不写 masteredAt**（读完≠掌握，PRD 4.3）；已是目标值则不产生写入 |
| `move_chapter` | write | R04 | 节点上移/下移一位（与邻居交换），内容与状态不变；已在边界则不产生写入 |
| `save_reading_deposit` | write | R07 | 沉淀落到指定书（可带章节来源），type 白名单（7 种 DepositType）；预览含正文前 200 字 |
| `link_notes` | write | N04 | 双链关联两篇笔记（id/标题定位），不改正文；已关联/同篇 → 无需重复 |
| `review_queue` | read(带写子动作) | N05 | `list` 读队列；`enable`/`record` 走审批卡——**record 缺 ok（用户真实作答）直接拒绝**，不凭模型判断伪造复习记录 |

## 2. 设计纪律（与第一批一致）

- **消歧**：`resolveBook` 与 `resolveGoal` 同语义——精确 id → 精确书名 → 唯一子串 → 歧义候选列表（书架两本版本变体都非精确同名时要求用户选择）。
- **审批门**：全部写工具走 PendingAction 审批卡，`actionPreview` 展示变更摘要（旧→新、影响提示、正文预览）后才执行。
- **状态已满足不写**：`set_reading_progress`/`move_chapter` 在无实际变化时返回「无需修改」且**不产生 action**——避免无意义确认与虚假操作记录。
- **读完与掌握分离**：`set_reading_progress` 预览中明确「手动标记已读完，不等于验收掌握」。
- **复习真实性**：`record` 必须携带用户真实作答结果（ok），否则拒绝（matrix N05「依据用户表现更新，不凭模型判断伪造复习记录」）。

## 3. 验证

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0，0 错误 |
| 新增 `reading-notes-tools.test.ts` | **25 项**（消歧语义 5、get_book 2、edit_book_goal 3、set_reading_progress 4、move_chapter 2、save_reading_deposit 2、link_notes 3、review_queue 4）全过 |
| `fix-01-agent-pipeline.test.ts` 写工具清单 | 有意迁移 `+=` 5 个写工具（16 项过） |
| 全量 `npm test` | **1204 通过 / 15 跳过 / 1 失败**（见 §4） |
| `npx eslint`（新改文件） | 0 error（3 个 warning 均为既有未触及行） |
| `next build` | ✅ |

## 4. 如实记录：1 项失败为并发修改破坏（非本轮引入）

`read-book-card-keyboard.test.ts` 扫源码锚定 `read/[id]/page.tsx` 的 `<Card` 结构——该页面在 **2026-11-10 16:52 被外部并发进程修改**（与本会话并行工作的其他进程，本会话从未触及该文件），测试锚点失效（`lastIndexOf("<Card")` 返回 -1）。

**处置：** 不在本批次内代修他人 UI 的测试；留待页面归属方修复。该失败与本轮 7 个工具的代码路径无交集（本批未改阅读页 UI）。

## 5. 改动文件

```
改动  src/lib/agent/protocol.ts          （+7 工具注册：get_book/edit_book_goal/set_reading_progress/move_chapter/save_reading_deposit/link_notes/review_queue）
改动  src/lib/agent/tool-executors.ts    （resolveBook 消歧 + 7 个执行分支 + DEPOSIT_TYPE_LABELS 导入）
改动  src/components/agent-home.tsx      （6 类审批卡预览分支）
新增  src/lib/__tests__/reading-notes-tools.test.ts（25 项）
改动  src/lib/__tests__/fix-01-agent-pipeline.test.ts（写工具清单 += 5）
```

## 6. 能力矩阵更新口径

| 编号 | 旧状态 | 本轮后 | 剩余缺口 |
|---|---|---|---|
| R01 | 部分接通 | **已接通**（详细读取+消歧） | — |
| R03 | 未见接通 | **已接通**（目标编辑预览+应用） | 路线重排联动仍走页面 |
| R04 | 未见接通 | **部分接通**（节点顺序） | 切路线类型/增补节点需模型生成，仍走页面 |
| R05 | 未见接通 | **已接通**（章节+全书状态，读完≠掌握） | 验收判定仍走页面（属 R06） |
| R07 | 仅通用笔记工具 | **已接通**（带章节来源的沉淀） | 迁移复查仍走页面 |
| N04 | 未见接通 | **已接通**（双链） | 反向链接视图是页面能力 |
| N05 | 未见接通 | **已接通**（队列读/加入移出/真实表现记录） | — |

## 7. 仍未完成（下批次）

1. **R02**（修改/删除书籍）：store 有 `updateBook`/`removeBook`，工具未暴露——删除影响面大，需先定删除影响范围展示规则。
2. **R06**：材料讨论/节点检验/全书验收的首页接入（需带上下文交接或调用页面流程）。
3. **路线重生成**（R04 剩余）：切完整/核心/目标路线需模型生成新章节列表，参照 `regenerate_phase` 的「方案预览→批准→快照」模式另做。
4. **批次 D**：人生伙伴 C01–C06。
5. 真实模型端到端评测（与 in12/in16 两轮用例、UI 走查合并安排，等 D1 恢复）。
