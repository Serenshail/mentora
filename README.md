# Mentora · 学习教练 × 第二大脑 × 读书伙伴 × 人生伙伴

> 把「学会任何东西」变成日常的系统：教练排计划、盯验收，笔记自己织成网，读书有人陪，困惑有人给你真话。

**线上**：华为云 Demo（见 [部署指导](docs/DEPLOY-HUAWEICLOUD.md)，部署后回填 URL） ｜ [https://mentora-orpin.vercel.app](https://mentora-orpin.vercel.app)（Vercel 旧入口） ｜ **技术栈**：Next.js 16 · React 19 · Tailwind CSS 4 · TypeScript · zustand 5 · 自研 AI 流式层 · 华为云 ModelArts MaaS（DeepSeek 多服务商 BYOK）· RDS/DCS 双通道存储

未登录访客看到的是产品落地页（手写体标题动效 + 产品讲解）；注册登录后进入应用。四个功能：

## 它能干什么

### 🎓 学习教练
你说想学什么，教练**先真正了解你**——目的、基础、时段习惯、学习风格、放弃史、性格倾向、约束（6-9 轮深挖）；行业标准类问题（学到什么程度能应聘）由 AI 自己推导，不反问用户。然后：

- **两级计划**：先生成总纲要（阶段 / 每阶段能力 / 8-15 条详尽大纲 / 范围与「不学」边界），每个阶段开始时再按你的画像 + 已掌握知识点 + 近期薄弱点生成精准的天级计划——不是一开始排死全部
- **每日一课**按「6 段教学模板」生成：直接可学的资料 → 知识点穷尽到方法级 → 完整可运行示范 → 逐步拆解 → 变体与易错 → **操作 + 默写双验收**。分领域模板：编程 / 人文（原文细读，禁代码）/ 语言 / 考试 / 数学 / 通识
- **验收门**：逐条评分，全部通过才解锁下一阶段；不通过给最小补救动作；硬要跳过需输入「跳过」二次确认并留痕
- 学习中可**随手记**（直入知识库）与**随时问教练**（即时答疑，按天保存）

### 🧠 第二大脑
Obsidian 式双链笔记库。每条知识是独立笔记，正文支持 `[[标题]]` 双链（未创建的显示虚线占位）；出链 / 反向链接面板；**力导向关系图谱**（拖拽 / 点击 / 邻居高亮）；**AI 建联**（在整库里找有思想联系的笔记并说明理由，宁缺毋滥）。学习计划本身也作为笔记进入图谱。复习调度用 **FSRS**（免费开源的记忆调度器，按你的每次回忆表现自适应定下一天），回忆式复习（AI 出题 → 凭记忆作答 → AI 对照笔记判定）；复习通过会推进掌握状态，最高到「长期保持」。

### 📖 读书伙伴
深度解剖一本书：先写**书籍档案**（这本书在解决什么问题 / 作者立场 / 思想谱系链条 / 争议），按论证逻辑选拆解方式（不默认按目录），每个单元带**核心论点 + 带读问题 + 其他思想家的交叉视角**（实测《思考，快与慢》带出塔勒布、塞勒、吉仁泽、达马西奥等 8 家）。陪读对话随机应变——不替你总结，挖出你自己的理解；「记下来」一句话把洞见存进第二大脑。

### 🧭 人生伙伴
反迎合内核（8 条判断纪律：第一句就是明确判断 / 挑战坏问题的框架 / 主动给最强反方 / 诚实标注无知 / 不给情绪安慰给可执行判断 / 不和稀泥 / 观点与身份解耦 / 永远附下一步动作）。**12 位深度蒸馏的智者**（Naval、乔布斯、芒格、费曼、塔勒布、Paul Graham、Karpathy、马斯克、张雪峰、张一鸣、MrBeast、Ilya——思想体系用 TA 自己的术语 + 语言指纹 + 招牌提问）。**圆桌研讨会**：与会者全员并行独立发言，主持人收拢成纪要（共识 / 真分歧 / 被遗漏的视角 / 下一步）。还可以**锻造任何你想对话的人**：输入一个名字，AI 确认身份后蒸馏出 1500-3000 字的本人级系统提示词（人生关键节点 / 三层思想体系 / 语言指纹 / 真实原话 / 样例对话 few-shot）——实测「王阳明」能对上「心即理」「知行合一」和「此事你是真知，还是只嘴上知道？」。

## 用户系统与数据安全

- **账号**：邮箱 + 验证码注册、密码登录（scrypt 单向加盐哈希，HMAC 签名 HttpOnly cookie）；「忘记密码」邮箱找回；改密/重置后旧设备会话全部吊销（版本号机制）
- **云同步**：登录后学习计划 / 笔记 / 对话自动加密同步；换设备登录即恢复；断网时本地排队、恢复后自动重发
- **加密存储**：华为云 RDS PostgreSQL + DCS Redis 为主通道（`DB_CHANNEL=huawei`），Upstash Redis / Cloudflare D1 / 私有 GitHub 仓库为可切换通道与兜底（同一套 key、同一套加密，`DB_CHANNEL` 一个变量随时平滑互迁）；所有数据 **AES-256-GCM 静态加密**，密文落库
- **版本快照**：云端覆盖写之前自动保留最近 10 份历史快照（`/api/sync?versions=1` 可列），多设备互抹不再等于数据消失
- **Key 隐私（BYOK）**：设置→模型填入你自己的 Key 后，请求头携带、服务端只转发不落盘、不受每日配额——真正生效（v17 接线；未填则走服务端配置的模型并计入每日限额）
- **作者后台**：`/admin`（管理密码门）查看全部注册用户与数据概况，行内菜单可删除用户（连云端数据一起清）
- **反馈**：应用内反馈直达作者（GitHub Issues 后端），断网排队自动重试

## 快速开始

```bash
npm install
npm run dev        # http://localhost:3000
```

无任何配置时以**演示模式**运行（内置脚本化 AI，全流程可体验、可验收）。

### 接入真实模型（BYOK，费用归你）

应用内 `设置` 页选择服务商并填 API Key（只存本机浏览器）：

| 服务商 | 默认模型 | 备注 |
|--------|----------|------|
| 华为云 ModelArts MaaS（部署默认） | DeepSeek-V3.1 | `AI_PROVIDER=maas`，OpenAI 兼容端点 |
| DeepSeek | deepseek-chat | |
| Z.ai（智谱 GLM） | glm-4.6 | 可选 glm-5.3 / glm-5.3-flash |
| Moonshot（Kimi） | kimi-k2-0905-preview | |
| OpenAI | gpt-5-mini | |
| 自定义 | — | 任意 OpenAI 兼容端点（OneAPI / Ollama / vLLM） |

### 部署（双路径）

| 路径 | 适用 | 指导 |
|------|------|------|
| 华为云（主） | 大赛部署：RDS/DCS/MaaS + CCE Autopilot（或 ECS）+ SWR 镜像 + FunctionGraph 定时 + LTS/Cloud Eye | [`docs/DEPLOY-HUAWEICLOUD.md`](docs/DEPLOY-HUAWEICLOUD.md) |
| Vercel（旧入口，保留） | 零运维快速上线 | 见下节 |

双通道设计：模型层（`AI_PROVIDER`：maas ↔ deepseek ↔ zai ↔ …）、存储层（`DB_CHANNEL`：huawei ↔ upstash ↔ d1 ↔ github）、发信层，全部**配置切换即生效，无需代码变更**；不配置华为云凭据时自动回退原通道，行为不变。

### 部署到 Vercel

```bash
vercel link && vercel --prod --yes
```

环境变量（全部可空，按需）：

| 变量 | 作用 |
|------|------|
| `AI_PROVIDER` / `DEEPSEEK_API_KEY` / `MAAS_API_KEY` 等 | 服务端模型兜底（让访客零配置可用） |
| `DB_CHANNEL` / `DATABASE_URL` / `REDIS_URL` | 存储通道（缺省 auto 隐式优先 Upstash→D1→GitHub；`huawei` 走 RDS+DCS） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 存储通道（免费档够用）；不配则自动落到 GitHub 后端 |
| `GITHUB_DB_TOKEN` / `GITHUB_DB_REPO` | 存储兜底（私有仓库，需 repo 权限）；`scripts/migrate-to-redis.mjs` 可把存量数据一键搬到 Redis |
| `AUTH_SECRET` | 会话签名与数据加密密钥 |
| `ADMIN_PASSWORD` | 作者后台密码 |
| `GITHUB_TOKEN` | 用户反馈的 GitHub Issues 后端 |

优先级：用户浏览器 BYOK → 服务端 env → 演示模式。

## 架构一览

```
src/
  app/
    page.tsx            # 登录墙：未登录=落地页，已登录=仪表盘
    login/ admin/       # 独立登录页 · 作者后台
    learn/              # 学习教练（引导 / 两级计划 / 每日文档 / 验收门）
    brain/              # 第二大脑（双链笔记 / 力导向图谱 / 间隔复习）
    read/ council/      # 读书伙伴 · 人生伙伴（12席+锻造+全员圆桌）
    api/chat            # 唯一 AI 端点：NDJSON 流式，11 种 task 显式分流
    api/auth  api/sync  # 注册登录（scrypt+HMAC） · 快照同步（AES-256-GCM）
    api/feedback        # 反馈 → GitHub Issues
  lib/ai/prompts.ts     # 全部系统提示词（核心资产）
  lib/server/           # 加密存储层（双通道：huawei=RDS+DCS / Upstash / D1 / GitHub 兜底，上层只见 dbGet/dbPut/dbList/dbDelete）
  components/brain/     # 图谱 / [[双链]] 渲染器
```

设计取舍与完整细节（演进决策日志、提示词全景、踩坑记录、38 条验收清单）见 [`docs/PROJECT-obsidian-doc.md`](docs/PROJECT-obsidian-doc.md)。

## 产品哲学

乔布斯式做减法 + 纳瓦尔式的具体：**第一句话就是判断**；文案像人话不像产品说明书（依据 Apple HIG Writing 与 Material 3 content design 清过全站）；验收不放水；不承诺做不到的日期——学习量由任务决定，投入多少走多快；数据归用户，随时可带走。

## Roadmap（下一步唯一主线）

### Founder-First：先让创始人自己愿意每天用

当前最高优先级不是继续堆功能，而是把首页变成**一个入口、一个主智能体、四个工作空间**：用户只需说出想学什么、想整理什么、想读懂什么或正在纠结什么，Mentora 负责识别意图、给出下一步，并把确认后的结果沉淀为目标、笔记、复习或决策资产。

- [ ] P0：统一首页主入口、意图识别、工作空间摘要、只读工具、提案卡、确认后写入
- [ ] P0：50 条以上意图黄金集、动作安全测试、Demo/真实模型同形状
- [ ] P1：计划 patch、双链提案、读书提案、Decision/ActionItem、Agent run 审计
- [ ] P1：软删除/撤销、冲突状态、断线恢复、移动端和无障碍回归

**规划文档**：[Founder-First PRD](docs/PRD-2026-10-24.md)

**发布门禁**：[Founder-First Acceptance](docs/ACCEPTANCE-FOUNDER-FIRST-2026-10-24.md)

**Obsidian 插件渠道执行规格**：[PLUGIN-EXECUTION-2026-10-24.md](docs/PLUGIN-EXECUTION-2026-10-24.md)

**今天就能开始**：[DOGFOODING-7D.md](docs/DOGFOODING-7D.md)（7 天自用记录表，用来判断到底值不值得继续做）

**重要说明**：上述 Founder-First 主智能体均为规划项，不代表当前版本已经实现或通过验收。当前已实现功能的基线仍以 [`ACCEPTANCE.md`](ACCEPTANCE.md) 为准。

### 暂缓项

- [ ] 读书伙伴：EPUB·PDF 上传
- [ ] 同步升级：快照 last-write-wins → 字段级合并；数据量大后再评估 Postgres
- [ ] Token 计量与用量面板 / 移动端 PWA + 复习推送
- [ ] 增长：内容获客 / SEO

## 开发过程（想法到应用）

本项目以华为云 CodeArts 智能体完成本次华为云升级：需求规格 → 实现方案 → 任务规划 → 代码生成 → 问题修复 → 部署上线，全程按环节留痕（git 提交历史与 `docs/evidence/`）。

- **实践文档**：[`docs/CODEARTS-PRACTICE.md`](docs/CODEARTS-PRACTICE.md)（五环节真实故事与证据索引）
- **演示素材**：OBS 公开桶（视频/截图集，部署后回填链接；桶内无密钥、无真实用户数据）

## License

MIT（代码）。标题动效 PopText 为作者自研 skill（复刻自博客标题动效，逐帧辨识）；3D 物件图为 Microsoft Fluent 3D emoji（MIT）与视频抠图。
