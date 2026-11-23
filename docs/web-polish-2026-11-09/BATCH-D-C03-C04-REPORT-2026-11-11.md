# 批次 D 主体实现报告：人物对话与圆桌讨论（C03/C04）

**日期：** 2026-11-11 ｜ **交付目标（用户设定）：** 「继续上次的讨论，加入费曼，重点讨论实施风险」→ 定位会话 → 明确安排 → 真实执行讨论 → 结果保存到原会话
**验收方式：** 模拟测试（可控 streamChat mock + 真实 store，14 项场景）已全部通过；**真实模型验收单列未执行**（D1 503 阻断账户 mint；真实上游行为差异需单独记录）。

## 1. 改动摘要

### 1.1 共享讨论引擎（新增 `src/lib/agent/council-engine.ts`）

从 council 页抽取的执行逻辑，首页智能体与人生伙伴页使用**同一套**：

| 纪律 | 实现 |
|---|---|
| 同会话互斥 | `activeRuns` 登记（页面与工具共用），并发发起直接拒绝 |
| 停止即停 | abort 后不再启动后续请求；迟到增量、迟到落库一律拒绝（signal 守卫） |
| 已删会话不复活 | store 写入对不存在会话天然 no-op |
| 失败残片不进纪要 | 有效发言（含保留 goodTakes）≥2 席才综合 |
| 部分失败可恢复 | 失败席位单独重试（已完成席位不重复调用/不重复保存）；主持失败复用已完成发言单独重试 |
| 跨入口重试 | `pendingRetry` 持久化到会话（`CouncilSession.pendingRetry`），全部完成时清空 |

引擎 API：`runDiscussion(opts, customOf)` → `DiscussionResult { status: done|partial|insufficient|failed|cancelled, goodTakes, failedSeatIds, hostText, hostFailed, savedMessages }`；单人模式走 `runSingleTurn`（历史上下文带入，与会话既有格式一致）。

### 1.2 council 页委托引擎（行为保持）

`roundtableSend` 重写为委托 `runDiscussion`：页面保留 runId 隔离 UI 写入、停止（abort）、补答横幅（结果驱动 + `rebuildRtRetry` 历史重建）；流式发言/主持总结/停止/重试全部经引擎回调驱动，原有 UI 语义不变。`rt-retry-clear.test.ts` 生命周期锁按新结构重写（4 项过）。

### 1.3 新工具（2 个）

- **`run_discussion`**（write, C03）：消歧定位会话 → 审批卡展示（会话/阵容/议题/新增约束/重试项）→ 批准后真实执行并**写回原会话**。继续讨论时合成上下文 `【原议题】+【最近讨论】+【本轮新增约束】` 发给席位；`retry=true` 消费 `pendingRetry`（失败席位重跑/主持单独重试）。EX-15 冲突检测：批准后阵容被改则拒绝旧批准。返回准确状态（完成/部分完成/不足两席/失败/已停止）+ `/council` 入口。
- **`set_participants`**（write, C04）：完整新名单消歧解析（内置注册表/自建人物，按名兜底），差异预览（新增/移出 + 「自下一轮讨论生效；历史发言全部保留」）；执行中拒绝换人；不足 2 席拒绝；人物不存在如实列出（提示 forge_persona）。

## 2. 验收场景验证结果（模拟测试，14/14 通过）

`src/lib/__tests__/council-engine.test.ts`（真实 store + 可控 streamChat mock）：

| 场景 | 观察结果 | 结果 |
|---|---|---|
| 同名会话 | 返回候选列表，不执行、不写错会话 | ✅ |
| 继续讨论 | 席位实际收到 原议题+最近讨论+新增约束；用户消息/3 席发言/纪要写回原会话；入口 /council | ✅ |
| 调整阵容 | 预览含新增/移出与「下一轮生效」；批准后 `participants` 更新、历史发言保留 | ✅ |
| 执行中换人 | 「正在执行」拒绝（不能中途偷换阵容） | ✅ |
| 一席失败 | 主持人 takes 只含完成席位（残片不进纪要）；失败消息写历史；`pendingRetry` 持久化 failedSeatIds+goodTakes | ✅ |
| 不足两席 | 不调用主持人；提示席位不足；pendingRetry 挂起 | ✅ |
| 重试失败席位 | 只重跑失败席位（已完成席位零调用）；补答后重出第二份纪要（标明席位数）；pendingRetry 清空 | ✅ |
| 主持单独重试 | hostFailed=true → 席位零调用、仅重跑主持、复用已完成发言 | ✅ |
| 用户停止 | cancelled；已完成发言保留；迟到结果未写入；主持未调用 | ✅ |
| 并发发起 | 第二轮 status=failed 且零写入；工具校验层同样拒绝执行中会话 | ✅ |
| 删除会话 | 执行中删除 → 迟到写入 no-op，会话不复活 | ✅ |
| 单人模式 | 历史与新增约束进入消息；回复写回原会话（格式与页面一致） | ✅ |

## 3. 回归与构建

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm test` 全量 | **1293 通过 / 0 失败**（203 文件）——含重写的 rt-retry-clear 生命周期锁（4 项）与 reading-notes 46 项 |
| `next build` | ✅ |
| eslint（新改文件） | 0 error（1 个 warning：council 页 `Badge` 未使用，属并发重构遗留，非本轮路径） |

## 4. 真实模型验收（单列，未执行）

以下必须在 D1 恢复（可 mint 隔离账户）后用真实上游补齐，**不能由模拟测试替代**：
1. 真实模型对合成上下文（原议题+历史+新约束）的发言质量与贴题度。
2. 真实多席位并发的流式稳定性、token/成本、耗时（PRD PERF-01 口径）。
3. 「加入费曼」类人物名解析在真实对话中的表现（按名兜底解析的召回）。
4. 首页审批卡 → 执行 → 学习页/人生伙伴页查看的端到端 UI 走查（含双标签页并发）。

## 5. 未完成事项

1. **C04 的「议题调整」**：本轮阵容调整已通；「修改下一轮讨论议题」当前通过 focus 传入（每轮独立），未做「预先设定下一轮议题」的持久化——如需可加 session.nextTopic。
2. **页面单人流未迁移**：council 页单人对话仍走 useChat（引擎 single 模式已具备同语义，供智能体用）；统一是后续清理项，不影响行为。
3. council 页 `Badge` 未使用告警（并发重构遗留）。
4. 批次 E：能力矩阵全覆盖、历史与大数据、辅助页面（用户指示本轮不扩展）。

## 6. 改动文件

```
新增  src/lib/agent/council-engine.ts        （共享引擎：互斥/停止/门槛/重试/pendingRetry）
改动  src/lib/types.ts                        （CouncilSession.pendingRetry）
改动  src/app/council/page.tsx               （roundtableSend 委托引擎，行为保持）
改动  src/lib/agent/protocol.ts               （run_discussion / set_participants 注册）
改动  src/lib/agent/tool-executors.ts         （resolveSeatPersonals/上下文合成/校验与执行）
改动  src/components/agent-home.tsx           （审批卡预览分支）
新增  src/lib/__tests__/council-engine.test.ts（14 项验收场景）
改动  src/lib/__tests__/rt-retry-clear.test.ts（生命周期锁 v2，4 项）
改动  src/lib/__tests__/fix-01-agent-pipeline.test.ts（写清单 += 2）
```

智能体工具累计 **32 个**（写工具 17）。
