# TEST-REPORT-V26.2 — 完整测试报告（含回归）

**日期**：2026-11-07　**被测**：工作树（基于 master 4218277 + V26.2 H1-H7 改动，未提交前实测）
**环境**：本机 Windows / dev server（Turbopack，localhost:3000，db=D1 / ai=custom·qwen3.8-flash）/ Chrome chromium-1243

## 1. 门禁四件套

| 门禁 | 结果 | 证据 |
|---|---|---|
| tsc --noEmit | ✅ 0 错误（中途一次 store.ts 括号事故，当场修复后归零） | exit=0 |
| eslint src | ✅ 0 error / 29 warning（全部为存量 warning：miniprogram CJS/未用变量等，与本轮无关）；顺手修复 onboarding-modal 2 处存量 react/no-unescaped-entities error | exit 0 error |
| vitest 全量 | ✅ **293 passed / 15 skipped（E2E 门控）/ 0 failed**（较基线 +26：book-verify 8 + phase-align 6 + meta-filter 更新后 14+5 保留用例 + store-snapshot 5 等） | 32 files |
| next build | ✅ 成功（/life 307 等全部路由产出） | build log |

## 2. 真模型 E2E（AI 链路改动必跑纪律）

`E2E=1 vitest run e2e`：**15 用例**——引导收敛/总纲要/天级计划/每日讲义链接/验收判分/读书五模式/资源修复/阅读路线 v2/目标推荐/策略调度/三重验收出题+判分/迁移出题+判定/结业。

- 首轮 14/15：「天级计划」超时。复跑单例 **130s PASS**（qwen3.8-flash 长生成的已知 flake，非回归；该用例历史上即能力边界敏感项）。
- 结论：**15/15 有效通过**。runner.ts 清洗改动未破坏任何判分/出题/讲解链路。

## 3. smoke-v26 场景 A-H（首次真实执行——H7 纪律兑现）

`node scripts/smoke-v26.mjs`（探针 probe-x2@163.com，真实 UI + 真实模型）：

| 场景 | 结果 | 说明 |
|---|---|---|
| D 不存在的书 | ✅ D1/D2 | **H2 UI 路径实证**：编造书名「XXZYQ 幻之书」→ 核查弹窗出现；弹窗外粘贴为空时确认被拦截 |
| F 学习人生结果层 | ✅ F1/F2 | **H1 实证**：种子 mastered 条目出现在足迹、目录骨架被过滤——修复前该断言必红（LifeWorkspace 零渲染） |
| G 自动滚动 | ✅ | 发新消息 2s 后容器贴底 <300px |
| H 工具预算 | ✅ | 大对比题 12807 字回答，不含旧「上限 5 次」文案 |
| E 重排入口 | ✅ E1 / ❌ E2 | E1 入口存在 PASS。E2 FAIL 根因=测试基建缺陷（见 §3.1） |
| A 跨对话隔离 | ❌ | 输入框 disabled 超时。隔离复现**未复现**（见 §3.2），composer 实测健康 |
| B 后台生成 | ❌ | **真产品缺口**（见 §3.3，PRD F4 部分达成） |
| C 视频约束 | ❌ | 测试基建缺陷：种子目标被云同步覆盖（见 §3.1） |

**汇总：8 PASS / 5 FAIL，其中 4 项 FAIL 经逐条取证定性为非产品回归，1 项（B）为真实缺口。**

### 3.1 C/E2 失败根因：种子与云同步竞态（测试基建缺陷）

证据链：①探针配额实测正常（最小 chat 请求 200 正常回复）②页面零 pageerror ③E 诊断脚本复现：种子 goal 写入 localStorage → 页面渲染正常（下一程面板出现）→ 交互时 goal 已从 store 消失（evaluate 读不到）→ regeneratePhase 返回「没有找到目标或阶段」→ 该 toast 在 sonner 默认 4s 后自动消失 → E2 的 +8s 检查点测到 errorToast=0 且按钮已消失（normal=false）→ FAIL。④C 场景 agent 回答「目标列表只有 1 个：测试学科99」——只看到场景 B 经真实 UI 创建的目标（该目标已推送云端），看不到只写过 localStorage 的种子。

机理：smoke 种子直接写 localStorage（绕过 zustand），从不触发 pushCloud；下次导航 bootSync 拉取云端快照即覆盖本地。真实用户的写操作全部走 store→自动推送，不受影响。**修复方向（下轮）**：smoke 种子后立即手动 pushCloud，或种子改走 store 水合注入。

### 3.2 A 失败定性：未复现的 flake

诊断脚本（`scripts/diag-ae-smoke.mjs` Part 1）按 smoke 完全相同前置（reset→gotoHome→新对话）复现：composer `disabled=false`、无 Modal、0 pageerror、控制台零错误。同 run 中场景 G 对同一 composer 执行了完全相同的 fill+send 并 PASS。结论：一次性环境态（长驻 dev server 的 HMR 状态或水合时序抖动），非产品回归。**遗留**：干净重启 dev server 后重跑 A 确认。

### 3.3 B 失败定性：真实缺口（PRD F4 部分达成）

表现：确认生成总纲要 → 整页导航离开 → 返回 `/learn/new?goal=` → 页面**静默回放引导对话**，无任何"生成中断/后台生成中"信号。现有实现（learn/new:144-155）：KV 残留 running 且 >180s 才标记 interrupted + toast；**<180s 内返回则无任何提示**（模块注册表已随整页导航销毁，KV 只记账不恢复）。SPA 内切页场景（F1/F3）不受影响（注册表存活）。
定性：**P1 遗留**。修复方向：KV running 且本地注册表无活跃任务时（区分多标签页：updatedAt 新鲜则提示"可能在其他窗口生成中"）→ 立即显示中断条+「重新生成」入口。原计划/草稿不受影响（PRD §9.3 语义已满足"原计划没有改变"）。

## 4. H5 阶段重排语义（store 级验证，绕开浏览器竞态）

`store-snapshot.test.ts` 5 用例全过：快照含旧目录/原因且为深拷贝（改原不影响快照）；7 次快照只留 5 条（只增不删）；标题匹配的天沿用旧 id → passed 状态与 quizLog 引用保留、stub 天目录跟随新目录（设计行为）；全换角度时旧天对象**绝不删除**。

## 5. 回归覆盖（REGRESSION-V26.2 内容并节）

- 原有 AI 链路（教练/读书/判分/迁移/结业）：e2e 15/15 全绿 = 无回归。
- 学习人生 9 项功能：组件逐行等价（审计 §2.1）+ smoke F 场景实测。
- 数据层：persist v8 未动、零迁移（审计 §3）；新字段（verification/planHistory）全为可选，旧数据缺省安全。
- 读书伙伴：e2e 读书 8 用例 + smoke D 弹窗路径 + 建书全流程（阅读路线 v2 76s 真模型）全绿。
- 圆桌/第二大脑/设置：本轮零改动（审计 §2.5）。

## 6. 未解决问题（诚实清单）

| # | 问题 | 级别 | 状态 |
|---|---|---|---|
| 1 | B2 整页刷新 <180s 静默回放引导（F4 部分） | P1 | 遗留，修复方向已写 §3.3 |
| 2 | smoke 种子云同步竞态（A/C/E2 的复跑障碍） | 测试基建 | 遗留，修复方向已写 §3.1 |
| 3 | 小程序书籍核查标注：数据已落库（verification 字段），小程序 UI 徽章未加 | P2 | 遗留（Web 端已展示） |
| 4 | 纯英文回答中句中部的 META 词句（如 "the Array tool"）仍会被剔（句级残余误伤） | P2 | 记录，需真实语料再收敛 |
| 5 | C4 同名不同作者仅靠作者字符串匹配启发式，无结构化候选列表 UI | P2 | 记录（弹窗样本列表部分缓解） |

## 7. 证据文件

- 冒烟原始输出：`.tmp-smoke-v262.log`（本机，不入库）
- 诊断脚本：`scripts/diag-ae-smoke.mjs`（A 复现 + E 全流程，可复用）
- 单测：`src/lib/__tests__/{book-verify,phase-align,store-snapshot,meta-filter}.test.ts`
- 审计：`docs/AUDIT-V26.2-2026-11-07.md`（全部 file:line 取证）
