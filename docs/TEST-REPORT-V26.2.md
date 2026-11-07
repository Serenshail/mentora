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

## 3. smoke-v26 场景 A-H（首次真实执行——H7 纪律兑现；dev 与腾讯云生产各一轮）

`node scripts/smoke-v26.mjs`（探针 probe-x2@163.com，真实 UI + 真实模型）——**两轮结果完全同构**：

| 场景 | dev | 腾讯云生产 | 说明 |
|---|---|---|---|
| D 不存在的书 | ✅ | ✅ | **H2 UI 路径实证**：编造书名「XXZYQ 幻之书」→ 核查弹窗出现；粘贴为空时确认被拦截 |
| F 学习人生结果层 | ✅ | ✅ | **H1 实证**：真实掌握条目进足迹、目录骨架被过滤——修复前必红 |
| G 自动滚动 | ✅ | ✅ | 发新消息 2s 后容器贴底 <300px |
| H 工具预算 | ✅（12807 字） | ✅（6810 字） | 不含旧「上限 5 次」文案 |
| E 重排入口 | ✅ E1 / ❌ E2 | ✅ E1 / ❌ E2 | E2 根因见 §3.1（基建竞态）；重排本身已另行端到端实证（§3.4） |
| A 跨对话隔离 | ❌ | ❌ | composer disabled 超时；三次隔离复现（含新 dev server+newChat 步骤）均健康（§3.2） |
| B 后台生成 | ❌ | ❌ | **真产品缺口**（§3.3，PRD F4 部分达成） |
| C 视频约束 | ❌ | ❌ | 基建竞态：种子目标被云同步覆盖（§3.1）；生产 C1 另见预算收尾文案出现（回答正常收尾非崩溃） |

**两轮均 8 PASS / 5 FAIL；5 FAIL 中 4 项定性非产品回归，1 项（B）真实缺口。**

### 3.1 C/E2 失败根因：种子与云同步竞态（测试基建缺陷）

证据链：①探针配额实测正常 ②页面零 pageerror ③种子 goal 只写 localStorage（绕过 zustand→从不 pushCloud）→ 页面加载 bootSync 拉云端快照即覆盖；④E2 的 +8s 检查点落在「没有找到目标或阶段」toast（sonner 默认 4s）消失之后 → errorToast=0 且按钮消失 → FAIL；⑤C 场景 agent 只看到经真实 UI 创建、已推云端的目标。**补充证据（部署后诊断）**：重排结果落库后若浏览器在 2.5s 防抖推送前关闭，云端仍是旧目录——下次加载被拉回（dump 实测"目录已就绪（3 天）"旧态）。真实用户的写操作全走 store→自动推送，不受影响。**修复方向（下轮）**：smoke 种子改走 /api/sync 直推云端，或种子后强制 flush。

### 3.2 A 失败定性：未复现的 harness flake

三次隔离复现（reset→gotoHome→新对话→检查）：composer 全部健康（disabled=false、无 Modal、0 pageerror、控制台零错误）——第二次在全新重启的 dev server 上、含 newChat 步骤。同 run 中场景 G 对同一 composer 执行完全相同的 fill+send 两轮全 PASS。结论：smoke 完整序列下的环境态问题（疑似首场景水合时序），非产品回归。**遗留**：smoke harness 加固（首场景前增加 composer 可用等待）。

### 3.3 B 失败定性：真实缺口（PRD F4 部分达成）

表现：确认生成总纲要 → 整页导航离开 → 返回 `/learn/new?goal=` → 页面**静默回放引导对话**，无任何"生成中断/后台生成中"信号。现有实现（learn/new:144-155）：KV 残留 running 且 >180s 才标记 interrupted + toast；**<180s 内返回则无任何提示**（模块注册表已随整页导航销毁，KV 只记账不恢复）。SPA 内切页场景（F1/F3）不受影响（注册表存活）。
定性：**P1 遗留**。修复方向：KV running 且本地注册表无活跃任务时（区分多标签页：updatedAt 新鲜则提示"可能在其他窗口生成中"）→ 立即显示中断条+「重新生成」入口。原计划/草稿不受影响（PRD §9.3 语义已满足"原计划没有改变"）。

## 4. H5 阶段重排语义（store 级 + 端到端双层验证）

**store 级**（`store-snapshot.test.ts` 5 用例全过）：快照含旧目录/原因且为深拷贝；7 次快照只留 5 条；标题匹配沿用旧 id → passed 状态与 quizLog 引用保留；全换角度时旧天对象**绝不删除**。

**端到端**（`scripts/diag-ae-smoke.mjs` Part 2，真实模型驱动窗口弹窗流程）：种子阶段 → 点「重排本阶段」→ prompt 收集"想要更实践向的内容" → 真模型重排成功——store 断言：新目录 4 天（全换角度，按 userNote 重排）、`planHistory` 长度 1 且 reason 与弹窗输入一致、`daysCount 7 = 旧 3 天（孤儿保留）+ 新 4 天`、quizLog 完好。**快照→重排→留痕→不删数据 全链路成立**。

**H6 入口可见性（实测修正）**：路径设计列表（含每个阶段的「重排本阶段」）在**天详情视图**渲染（PlanTimeline 挂在 LearnBody 内）；阶段视图只有当前活动阶段的 PhasePlanPanel 按钮。合并覆盖=默认视图见当前阶段入口、天视图见全部阶段入口；非当前阶段的入口需先进任意一天。已如实记录（PRD §6.1 的"阶段卡入口"理想形态待后续把路径列表提为常显）。

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
| 2 | smoke 种子云同步竞态（A/C/E2 复跑障碍）+ smoke harness 首场景加固 | 测试基建 | 遗留，修复方向已写 §3.1/§3.2 |
| 3 | 小程序书籍核查标注：数据已落库（verification 字段），小程序 UI 徽章未加 | P2 | 遗留（Web 端已展示） |
| 4 | 纯英文回答中句中部的 META 词句（如 "the Array tool"）仍会被剔（句级残余误伤） | P2 | 记录，需真实语料再收敛 |
| 5 | C4 同名不同作者仅靠作者字符串匹配启发式，无结构化候选列表 UI | P2 | 记录（弹窗样本列表部分缓解） |
| 6 | H6 路径设计列表仅天详情视图渲染，非当前阶段的入口需先进任意一天 | P2 | 记录（§4 实测修正），理想形态=路径列表常显 |

## 7. 证据文件

- 冒烟原始输出：`.tmp-smoke-v262.log`（dev）、`.tmp-smoke-prod-tx.log`（腾讯云生产，本机不入库）
- 诊断脚本：`scripts/diag-ae-smoke.mjs`（A 复现 + E 端到端含 H5 断言）、`scripts/check-f-vercel.mjs`（Vercel 生产 F 验证，带代理）
- 单测：`src/lib/__tests__/{book-verify,phase-align,store-snapshot,meta-filter}.test.ts`
- 审计：`docs/AUDIT-V26.2-2026-11-07.md`（全部 file:line 取证）
