# CHANGELOG

版本史此前散在 git log 与 Obsidian 项目志（v1→v16.5 见 `git log`，仓库首个带 tag 的版本是本文件记录的 v17）。

## v17.0 — 2026-10-11（外部评审后的集中还债）

依据 2026-10-11 产品评审（docs/PRODUCT-REVIEW-2026-10-11.md）按 P0→P1 逐条修复。

### 安全（发布阻断级）
- **/api/chat 提款机堵死**：模型 Key 与 baseUrl 必须同源——BYOK 模式只用客户端自己的 Key（custom 端点过公网 HTTPS + DNS 解析取证守卫）；服务端模式完全无视客户端头（此前 `provider+baseurl` 头组合可把部署者 DEEPSeek Key 的 Bearer 转发到攻击者 URL）
- **/api/chat 生产登录墙**：烧服务端 Key 的真实调用必须登录（演示脚本不限）；非 Vercel 环境放行保本地冒烟链路
- **BYOK 真接线**：客户端随请求携带用户 Key（此前是死码，README 卖点不成立）；BYOK 用户不受每日配额
- **生产注册旁路关闭**：未配 RESEND_API_KEY 时不再把验证码回给响应体（dev/preview 保留）——**生产恢复注册需要配 Key**
- **ADMIN_PASSWORD 明文出仓**：清理脚本改为强制从环境变量读取；旧密码已轮换
- **验证码/限流出进程**：存 D1/Upstash（跨 isolate 一致），dev 无 KV 自动回退内存——修多实例下注册验证码时好时坏的根因
- **登录账号维度防爆破**：同一邮箱 10 分钟内失败 8 次锁 15 分钟（找回通道不受影响）；/api/admin/overview GET 补限流
- **会话可吊销**：用户档案加 sv 版本号，改密/重置密码后所有旧设备 cookie 即刻作废（此前 30 天内照用）
- **SSRF 守卫统一**：linkcheck 与 BYOK custom 共用 url-guard（DNS 解析取证挡十进制 IP；重定向后复检落点）

### 账号与数据
- **忘记密码全链路**：send-code(purpose=reset，防账号枚举) → /reset-password → 登录页「重置密码」模式
- **云端版本快照**：/api/sync 覆盖写前自动保留最近 10 份历史（versions/<userId>/<ts>.json，`?versions=1` / `?v=<ts>` 可查可取）；请求体与解压体积双闸

### 学习闭环（判分认识论）
- 验收判分带参照物：当日讲义原文与知识点随 ctx 上行，QUIZ_GRADE 以讲义为准、覆盖不到判 ungradable（不再凭模型内建知识盲判）
- 复习判卷错位修复：出题改为钉死清单第 1 条，判卷材料带真题原文+笔记摘录；**评分服务异常不再默认通过**（重试即可，不灌水）
- **复习→掌握状态机接线**：recordReview 通过会推进 masteryStatus（masteryFromReview 从紧升级，失败不降级）；apply/build 无提示判对可达 transferable——六级状态机不再有永不可达的级
- **迁移题真门**：验收判过后当天成绩照常保存，但下一天须答迁移题才解锁；题目与答案持久化，刷新/换设备可补答
- 掌握状态机拆纯模块 mastery.ts + 9 条回归测试

### 崩溃与纪律
- 修复 learn/[id] 条件性 useState（React #310 白屏模式第三次复踩）
- ESLint 19 errors → 0（graph-view 渲染期读 ref ×5 改 viewStats+rAF 同步，顺带修复"缩放百分比标签不跟手"的真 bug；set-state-in-effect ×6；unescaped-entities ×6；purity；TDZ）
- CI 升级：npm ci（尊重 lockfile）+ lint 门禁 + build 验证；单测 21→30
- 死代码清理：固定阶梯 REVIEW_INTERVALS/nextReviewDate/nextReviewInterval（FSRS 已替代）；framer-motion（从未使用）

### 体验与可观测
- Modal 补 role=dialog/aria-modal/焦点陷阱/Esc/滚动锁/焦点归还；流式输出 5 处 aria-live；图标按钮 aria-label 补齐；落地页移动菜单 inert；hero 视频 preload 降 metadata
- token 计量：DeepSeek/OpenAI 流式回带 usage，逐次落 chat-usage 结构化日志（BYOK/配额/账号维度）
- @vercel/analytics 接入页面计数
- 文档纠偏：README 存储通道口径（D1 主通道）、FSRS 替代 1/3/7/15、BYOK 真实语义；ACCEPTANCE/ENGINEERING 同步；设置页 custom 端点提示修正

### 已知边界（诚实记录）
- AUTH_SECRET 一钥三用（会话 HMAC+数据加密+派生域）——密钥分离与轮换未做（P2）
- 无隐私政策/用户协议、无支付、大陆可达性（vercel.app 域名）——均待用户决策（P2）
- Sentry 未接（需账号）；Postgres 真源迁移未做（P2）
