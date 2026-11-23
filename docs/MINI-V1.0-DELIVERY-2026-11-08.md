# Mentora Mini V1.0 最终交付报告（2026-11-08）

按《Mentora Mini V1.0 开发总指令》十步顺序执行完毕；学习教练功能经用户指令纳入 V1.0，与阅读功能同标准交付。**未提交 git、未部署**（小程序不经过 git 部署，需开发工具导入编译；是否入库由用户确认）。

## 1. 现状审计报告
→ [docs/MINI-V1.0-AUDIT-2026-11-08.md](./MINI-V1.0-AUDIT-2026-11-08.md)
小程序 11 页 + utils 层逐文件精读；Web master 363a01e（V26.2）数据模型/协议/门禁定点核查。

## 2. PRD 差距分析
→ [docs/MINI-V1.0-GAP-2026-11-08.md](./MINI-V1.0-GAP-2026-11-08.md)
P0 缺口 10 项（学习教练闭环 B1/B2、阅读系统 A1-A5、通用 C1/C3），全部关闭；不做清单如实列出。

## 3. 技术架构与 API 映射
→ [docs/MINI-V1.0-PLAN-2026-11-08.md](./MINI-V1.0-PLAN-2026-11-08.md)
零新后端、零新依赖、零 Web 端改动；全部复用 /api/chat 现有 task、/api/sync（plain=1）、/api/search、/api/auth/*。

## 4. 实际修改文件清单（16 文件）

| 文件 | 改动 |
|---|---|
| `miniprogram/utils/schema.js` | **新增**：splitGoalReply（目标卡双形态解析）/ masterDraftToPlan / normPhaseList / phaseDraftToDay / normReadingGoal / normAssessGen / normAssessGrade / buildPhaseCtx / chapterJson / goalText / 兜底三题 / 四组中文标签常量——与 Web ai/client.ts schema、lib/plan.ts 逐字段对齐 |
| `miniprogram/utils/store.js` | +10 写路径（addGoal/updateGoal/setPhaseCatalog/setDayDetail/setChapterStatus/addChapterAssessment/markChapterMastered/addBookDeposit/setBookReadStatus/addReadKnowledge）+ ingestKnowledge 统一入库通道（addLearnKnowledge 重构复用，语义不变） |
| `miniprogram/utils/chat.js` | t=end 断流校验（没收到 end 按失败处理，err.partial 保半截——与 Web client.ts 同语义） |
| `miniprogram/pages/coach/`（4 文件） | **新增学习教练引导页**：intake 多轮 → 目标卡（确认/继续聊）→ 总纲要生成（失败可重试且不重复建目标）→ 总纲要笔记入第二大脑（标题公式与 Web 一字不差） |
| `miniprogram/app.json` | 注册 coach 页 |
| `miniprogram/pages/learn/learn.js/.wxml` | 「开始一个新目标 / + 新的学习目标」入口；空态文案更新 |
| `miniprogram/pages/goal/goal.js/.wxml/.wxss` | 阶段天目录一键生成（phase-list，旧 id 沿用/新 id 补齐）、stub 天「详情待展开」、空路径文案更新 |
| `miniprogram/pages/day/day.js/.wxml` | stub 天「展开今天的计划」（phase-detail 单日，运行态继承），onUnload 取消在途流 |
| `miniprogram/pages/book/book.js/.wxml/.wxss` | 阅读系统 V1.0：认知概览（地图四区域/核实标注/五态条）、阅读目标（AI 推荐+四成果 chips 可改，改目标不清记录）、三重验收层（出题失败本地兜底三题、四级判定、全过=masteredAt+学习证据、档案落 book.assessments、misconception 两态）、节点状态（手动读完不写 masteredAt）、整本五态（读完/整本验收=复盘检验/确认已掌握）、沉淀（七类+待解决联动）、本章小结（流式→入第二大脑）、bookCtx 注入 map/goal/弱点/沉淀 |
| `miniprogram/README.md` | 功能范围更新至 V1.0 + 诚实边界刷新 |
| `scripts/smoke-mp-core.cjs` | 32→87 断言（+55）：协议归一化/计划构建/目录落库/单日回填/阅读写路径/五态/断流校验 |
| `docs/MINI-V1.0-*.md` | 审计/差距/方案/本报告 |

login 页激活码文案此前已是最新（P0-E 无需改动）。

## 5. P0 功能完成情况

| P0 项 | 状态 | 验证 |
|---|---|---|
| B1 引导建目标（intake→目标卡） | ✅ | e2e 场景二（真模型出卡双形态） |
| B2 总纲要/天目录/单日细节 | ✅ | e2e 场景二（三段真模型全链路） |
| A1 认知地图展示+上下文注入 | ✅ | e2e 场景一 + smoke |
| A2 阅读目标四成果 | ✅ | e2e 场景一（真模型推荐） |
| A3 三重验收（出题/判分/掌握写回/档案） | ✅ | e2e 场景一（判而附据、诚实门） |
| A4 节点+整本五态状态机 | ✅ | smoke + e2e |
| A5 沉淀七类+recap 入脑+待解决 | ✅ | smoke + e2e |
| C1 注册激活码文案 | ✅（既有） | — |
| C3 t=end 断流校验 | ✅ | smoke 2 断言（半截拒绝+完整放行） |
| C2 跨端同步 | ✅（既有+回归） | e2e 场景三 |

## 6. 自动化测试结果

- `node scripts/smoke-mp-core.cjs`：**87 passed / 0 failed**（wx stub 逻辑冒烟，含历史回归锁：真门/解锁链/结业/防抖窗口）
- `node scripts/check-mp-wxml.cjs`：**OK**；`check-mp-wxss.cjs`：**OK（15 文件）**
- 全部 JS `node --check`：**通过**

## 7. 三个真实场景验收结果（腾讯云生产 192.144.181.171:3000，真模型，探针账号注册→测→自删）

**33 passed / 0 failed**（`.tmp-mini-e2e.log`）：

- **场景一·阅读闭环（14/14）**：reading-plan 真模型建《影响力》→ map 四区域落库 → 目标推荐 → assess-gen 三题双维度 → assess-grade 逐题四级+判而附据 → 未全过时不写 masteredAt（诚实门）→ 沉淀+待解决联动 → recap ≥80 字 → 入第二大脑（source=read+进复习队列）→ 五态 finished/mastered 联动
- **场景二·学习教练闭环（8/8）**：intake 两轮内出目标卡（标记/裸 JSON 双形态兼容）→ 总纲要阶段公式与 Web 一致 → 天目录（maxDays 钳制、stub 占位、首天激活）→ 单日细节（资源/方法/验收齐备、active 继承）
- **场景三·跨端同步（7/7）**：MP 快照推/拉无损（map/goal/readStatus/assessments/deposits/catalog/单日细节/recap 笔记）；Web 形状快照（planHistory/routeType/transfers/旧版 chapter.verification/**fsrs**）字段全保全——FSRS 接管前提成立

## 8. 未解决问题和风险（如实）

1. **UI 层真机验收未做**：本机无法程序化驱动微信开发者工具（项目已知边界）。**需用户在开发工具点「编译」后手测**，清单：
   - 学习：学习 tab → 开始一个新目标 → 引导对话 → 目标卡确认 → 总纲要 → 目标页「生成本阶段学习日」→ 点第 1 天 → 「展开今天的计划」→ 生成讲义 → 答疑 → 验收 → 迁移门 → 解锁
   - 读书：学习 tab 书架 → 添加一本书（核查弹窗三态）→ 读书页顶部「认知地图与目标」展开 → 推荐目标/点 chip 改目标 → 章节抽屉「验收」→ 三题作答 → 判分（全过=已掌握徽标）→ 「沉淀」写一条 → 「本章小结」→ 存入第二大脑 → 标记读完 → 整本验收（自动切复盘检验）→ 确认已掌握
   - 同步：网页端改任意笔记 → 小程序下拉刷新可见；小程序写沉淀 → 网页端读书页可见
2. **迁移任务/复检、结业回路、策略推荐、加节点、路线重排、阶段重排、RAG 注入不在 V1.0**（Web 端完成、数据互通，见差距文档不做清单）——未经确认不扩范围
3. 快照 4.2MB 服务端上限：新增 assessment/deposit 数据后大库用户更接近上限（现网无案例，风险低）
4. 每日 AI 配额 60 次/用户与 Web 共享：小程序重度使用会触限，文案已人话透传
5. 本次 e2e 消耗一张激活码（探针注册用），探针账号已自删、激活码作废，无残留数据
6. 阅读验收判分依赖用户真实作答质量（真模型判定有随机性）；「全过才掌握」纪律已在提示词与本地双侧锁死

## 9. 发布记录

- 代码：工作树已改（master 363a01e 之上，未 commit）；小程序不走 git 部署
- 上线动作 = 用户在微信开发者工具重新导入/编译 `miniprogram/`（AppID wx6f1576b29864c3a6 已固化）；后端零改动、双生产站无需重新部署
- 回退：`git checkout -- miniprogram/ scripts/smoke-mp-core.cjs` 即回到 V26.2 小程序版本（无后端/数据回退需求；新增数据字段对旧代码只读不破坏）
