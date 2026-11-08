# M3.3 检查轮 + M3.4 第一批报告

**日期：** 2026-11-09 ｜ **纪律：** 用户「先检查，再执行下一步」——检查 A/B/C 通过后执行 M3.4
**插件仓：** dca59cd（检查轮修复）→ 56c7e68（M3.4）｜ **门禁：** 10/10 全绿

## 检查轮（对 M3.3 成果）

### 检查 A：diff 逐 hunk 自查 → **抓出并修复 2 个真缺口**
1. **项目总览卡初始态空白**（`projBody` 创建时无内容；backfill 仅在 `mt.plan` 存在时触发）——未登录/工具关闭/开放令牌未配时卡片纯空白，违反 PRD 空状态要求。修复：`mkProjEmpty()` 初始挂载 + rollup 空时重建。
2. **状态 chip 词汇分支不全**（`if (r.plan)` 才走登录态词汇）——未登录未配置时仍显示旧「未配置」，与「未登录」语义脱节。修复：mentora 卡恒用 `mtSyncBadge`，planState 从 `r.state` 派生。
- 附带确认：`test/mtview.html` 是构建期生成的预览副产物（无害入库）；backfill 作用域/断言迁移 5→6 语义正确。

### 检查 B：补缺口测试 9+8 条，全 PASS
- run.js：项目卡存在 / goal 聚合 2 行（3 目标去重）/ 剩余天数·截止 chip / 迁移门 chip（stub 计划数据）
- xunji.js：工具全关→项目卡空态引导可见（不是空白卡）
- infra：mtSyncBadge 全量 5 词汇 + M3.4 新增徽章 HH:mm 时间戳 2 条 + 七态状态条 5 条

### 检查 C：真机（如实申报）
重启 Obsidian 后 CUA 报 `Computer control was stopped`（**会话级终止，requestAccess 亦无法恢复**，区别于上轮 surface_replaced）。真机空态未截屏 → 由 xunji.js 空态断言（工具全关场景 PASS）+ run.js rollup 3 断言代证；上轮（M3.2 检查 C）已有登录态投影/服务行/徽章真机铁证。M3.4 状态条真机渲染列下轮抽查首项。

## M3.4 第一批（检查通过后执行）

| 项 | 内容 |
|---|---|
| 七态同步状态条 | 新 `mtHomeSyncState(ctx)` 纯函数：连接态（已登录/开放令牌/未连接）⊥ 数据态（synced/offline/failed/idle），PRD 5.3 词汇直达首页；`vh-syncbar` 插在服务行与 grid 之间，状态点+连接+标签+细节（含同步时间） |
| 徽章时间戳 | `mtSyncBadge(planState, account, fetchedAt)`——TOOL_CACHE.mentora.ts 派生「· HH:mm 同步」，仅成功态追加；学习卡副标与状态 chip 双处接线 |
| 导出/样式 | mtHomeSyncState 入导出面；.vh-syncbar 系列令牌化 CSS |

### 本轮产物证据
- 10/10 门禁（新增 8 断言）；构建产物双写 hash 一致
- 断言迁移记录：面板计数 4→5/5→6（加卡必迁移，已记入报告）

## 遗留（下轮/后续）
1. M3.4 状态条真机渲染抽查（CUA 会话级终止待恢复）
2. CUA D3 toast 真机捕获（自动化敌对页面，人工 30 秒手测法已在 M3.3 报告）
3. 视觉 Token 全卡重肤 + G3 同场景截图对照
4. 直连腾讯云超时根因（间歇性，降级观察）
5. 用户 vault 显式 `tools.mentora.baseUrl=vercel` 待手改、正式使用前置 HTTPS 域名
