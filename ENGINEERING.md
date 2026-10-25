# Mentora 工程化手册：从 Demo 到生产

目标：把"提示词写得好"升级成"系统跑得稳"。本文回答六个工程问题，并标注哪些已落地、哪些是路线。

---

## 1. 教材/内容版本管理（"怎么保证是新教材而不是旧版"）

**已落地（数据模型）**：`KnowledgeItem` 增加 `version`（整数，内容性修订递增）与 `updatedAt`（ISO）。
- 写入点：`store.ts` 的 `addKnowledge`/`createKnowledge` 初始 `version=1`；`updateKnowledge` 仅在 patch 触及 `title`/`body` 时 `version+1` 并刷新 `updatedAt`（复习状态等元数据更新**不算**改版）。
- 旧数据无这两个字段时按 `version=1` 兼容（读取处全部 `?? 1`）。

**版本策略（路线）**：
- 教材类笔记建议在正文 frontmatter 或标签里带来源版本（如 `#py3.12`、`#react19`），导入 Obsidian 时解析进 `tags`。
- 当上游教材大版本更新：新建一篇 `version=n+1` 的笔记，旧篇保留但打 `#deprecated` 标签；检索层对 `#deprecated` 降权（见 §3 的标签先验，加一条负权重即可）。

## 2. 同一知识点多文档冲突"听谁的"

**已落地**：`rag.ts` 的 `dedupeConflicts()`——按归一化标题分组，组内保留 `version` 更高者；同版本取 `updatedAt` 更新者。检索前先裁决，旧版不会和新版一起混进上下文。
原则：**听更新、听版本更高的**；无法自动裁决时（同版本同时间）保留两者并在上下文里标注"存在冲突版本"，交给模型提示用户。

## 3. 检索策略（"用户问题模糊时怎么办"）

**已落地**：`retrieve()` = 冲突裁决 → BM25（中文二元组）→ 轻量先验重排（标签命中 +0.5、更新度微小加分 ≤0.3，不压过相关性）。
**模糊查询的应对**：
- 查询侧把"用户原话 + 当前章节 focusQuestion + coreIdea"拼成查询（`read/[id]/page.tsx` 已如此），用上下文消歧。
- 召回放宽（`k*2`）再重排取 top-k，降低单点误判。
**路线（向量混排）**：`retrieve()` 是唯一入口；接入 embedding 提供商后在此做 BM25+向量 RRF 混排，上层无感。模糊语义查询靠向量补，精确术语靠 BM25。

## 4. 引导沟通成本（"别问太长"）

**已落地**：`prompts.ts` 的 `SOCRATIC_INTAKE` 从"B 类 8 项、6-9 轮"收紧为**只问 3 项关键信息（目的/基础/每周时间），首问合并一次问完，最多再追问 1 轮（理想 1 轮、上限 2 轮）**；其余一律 AI 推导或写进 `assumptions`。用户 anytime 说"开始/你定"立即出目标卡。

## 5. 工具调用与异常处理（"模型报错/工具返回错误码怎么办"）

分层原则：**能重试的重试、不能重试的降级、都要给用户一句人话**。
- **第三方 LLM API 超时/500**（已落地，`api/chat/route.ts`）：`fetchUpstream()` 带 45s 超时 + 最多 3 次指数退避（500ms→1s）；仅对瞬时故障（408/409/425/429/500/502/503/504/529、网络/超时）重试，4xx 确定性错误不重试；重试只发生在"尚未产出任何增量"之前（流式一旦开始不重发，避免重复内容）。全部失败 → NDJSON `{"t":"e"}` 给出带重试次数的可读错误，前端 toast 提示，绝不静默卡死。
- **结构化输出解析**（`client.ts extractJson`）：容忍 ```json 围栏/前后缀，括号配对扫描多候选；全失败才抛错。
- **工具/检索返回空或错**：检索为空 → 不注入上下文块（对话照常，不硬塞）；DB 不可用 → 会话类接口降级为"仅会话信息"而非判未登录（见 `api/auth/me`）。
- **约束怎么加**：把"必须/禁止"写进 schema（zod）而非只写进提示词；schema 校验失败 = 可重试的确定性错误，可带错误信息重发一次。

## 6. 服务化路线（延后项，用户指定"不着急"）

- **Docker 化**：Next standalone 输出（`output:'standalone'`）+ 多阶段 Dockerfile；env 注入 AI/DB 密钥。
- **接口限流**：按 session/user 的令牌桶（如 /api/chat 每用户 10 req/min），超限返回 429 + Retry-After；前端对 429 不重试、直接提示。
- **日志与监控**：结构化日志（route + task + 耗时 + 上游状态码）；对上游 5xx/超时率、p95 延迟打点；错误率告警。
- **成本控制**：按 task 选模型（ grading/autolink 用便宜档，plan/lesson 用强档）；缓存命中（同 query+同知识快照）直接复用；限制注入上下文字符数（`ragContext maxChars`）以控 token。

---

## 并发与降级总原则

- 客户端状态以 localStorage 仓为准、服务端会话以签名 cookie 为准；两者解耦，任一侧故障不拖垮另一侧。
- 任何外部依赖（LLM/DB/上游图片）都要有"失败时的次优路径"，而不是让整页白屏。
- 会话 cookie 只放小标识（<4096 字节），大字段（头像等）走响应体/按需回读——见 `api/auth/login` 注释与 2026-09-23 事故复盘。

---

## 7. LLMWiki 架构（技术护城河）

**从"RAG 检索散文档"升级为"LLM 编译+导航的知识 wiki"。** 知识库不是一堆等被相似性匹配的裸文档，而是一张由 LLM 持续编译、维护、可导航的互链网络；检索=沿网络导航，而非纯向量/词法相似度。随用户数据与链接密度复利增长，难复刻。

三件事：
1. **编译（ingest/compile）**：`wiki-compile.ts` + 服务端 `WIKI_COMPILE` 提示词。对孤立/新增笔记，LLM 返回 ops：`links`(建双链)/`mergeInto`(重复子集建议合并)/`conflict`(矛盾标记)/`summary`。客户端自动应用"建链"，合并与冲突作为建议交用户确认（不自动删改）。入口：第二大脑「AI 整理」。
2. **导航（retrieve/navigate）**：`rag.ts wikiRetrieve()` = 冲突裁决 → BM25 种子 → 沿 [[wikilink]] 一出(0.5)/一进(0.4)衰减扩展 → hub/MOC 与标签加权 → 重排。链接越密检索越准（复利）。读书对话已接入。
3. **维护（lint/maintain）**：MOC 自动目录（科目 hub）+ 版本/冲突裁决（dedupeConflicts）+「AI 整理」定期编译 = wiki 自愈合。

护城河逻辑：UI 可仿、单点提示词可抄，但**"用户数据 × 链接密度 × 编译维护"的复合资产**无法一次性抄走；检索质量随使用单调提升，形成切换成本。

---

## 8. 工程化基线（12-Factor 对齐，"去 demo 化"）

对照 12-Factor 与生产就绪清单落的基线（2026-09-24）：
- **测试（回归网）**：vitest 单测覆盖核心纯逻辑——`rag`(dedupeConflicts/wikiRetrieve 图导航/bm25 标题加权)、`utils`(rankResources 时效排序)、`ai/client`(extractJson 容忍围栏/前后缀/字符串内括号)、`mastery`(掌握状态机：判分/复习两条推进路径)。`npm run test`，CI 必跑。30 用例。
- **CI**：`.github/workflows/ci.yml`——push/PR 触发 install→`tsc --noEmit`→`npm run test`。类型+测试不过不进主干。
- **Config in env + fail-fast**：`server/config.ts envStatus()` 校验必需 env（AUTH_SECRET），可选通道只报数量不报内容（防泄露）；`/api/health` 暴露 ok/missing/optionalConfigured/build。
- **Logs as event streams**：`logEvent()` 结构化 JSON 写 stdout（Vercel 捕获）；/api/chat 记录上游状态/重试/失败与任务级错误。
- **Dependencies 显式声明**：补齐曾漏提交的依赖（qrcode.react/ts-fsrs/vitest/vite）。
- 圆桌纪要升级为详细七节结构化输出（问题重构/逐人立场/共识/分歧矩阵/遗漏视角/条件化决策/改判信号），1200-2000 字——"总结不到位"的工程化回应。

---

## 9. 部署与回退 SOP（2026-10-21 起，防 bug 硬要求）

**原则：每次生产部署必须有一个可一键回退的点，没有回退点不允许推送。**

1. **部署前**：四道门禁全绿（`tsc --noEmit` / `eslint src` 0 error / `vitest run` 全绿 / `npm run build`）；AI 链路有改动时另跑 `E2E=1 npx vitest run e2e`（dev server 起着）。
2. **打回退点**：`git add -A && git commit` 后 `git tag vX.Y.0`（每次部署一个新 tag，如 v21.0）。
3. **部署**：`git push origin master --tags`（Vercel 自动构建；代理不通时 `git -c http.proxy=http://127.0.0.1:7892 push ...`，或 `npx vercel --prod --yes` 直连并记下 deployment URL）。
4. **线上冒烟**：`/api/health` 200 + 本次改动的主路径各点一遍（圆桌=新建 3 席桌提一个问题到纪要完整）。
5. **回退（发现 bug 时，任选其一）**：
   - 代码回退：`git revert <tag 指向的 commit> && git push origin master`（生成反向提交，历史可追溯，首选）；
   - 平台回退：Vercel Dashboard → Deployments → 上一个绿色 Deployment → Promote to Production（秒级，用于代码回退还在跑时的止血）。
6. **记录**：CHANGELOG 记部署 tag 与 sha；出事故时补"回退原因+修复验证"一条。
