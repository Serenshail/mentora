# Mentora · 学习教练 × 第二大脑 × 人生伙伴

> 苏格拉底式学习教练 + 间隔重复第二大脑 + 读书伙伴 + 反迎合人生伙伴，一个应用四个功能。
> Next.js 16 · React 19 · Tailwind CSS 4 · TypeScript · zustand 5

## 产品能力（对应需求）

| 功能 | 实现 |
|------|------|
| **苏格拉底式目标引导** | `/learn/new`：教练一次只问一个问题，挖清动机→方向→基础→时间→期限→成功标准→领域类型，全部明确后才输出「目标卡」（可修改确认） |
| **领域化学习计划** | 3-5 阶段 → 每天：知识点 / 学习资源 / 教法 / 完整项目例子（编程）/ 2-4 条验收标准。编程=项目例子驱动，人文=大问题导读+费曼口述，语言=输入输出循环，考试=真题倒推，职业=作品集驱动 |
| **每日学习文档** | 按领域教法生成：今日掌握 → 讲解（编程必须通过完整可运行例子拆解）→ 常见的坑 → 验收前练习 |
| **验收门** | 逐条验收：讲解测试（自己的话讲清）/ 变体测试（新条件应用）/ 口述 / 短文 / 实战。全部通过才解锁下一阶段；**不通过就卡住**；硬要跳过需输入「跳过」二次确认并被记录（skipped） |
| **第二大脑** | 通过验收的知识点自动入库，按 **1/3/7/15 天**间隔重复提醒；回忆式复习（AI 出题→你凭记忆答→AI 判定）；搜索/领域筛选/连续学习天数 |
| **读书伙伴** | 书名或粘贴原文 → 生成「带着问题读」的章节计划；苏格拉底式陪读对话（不替你总结，追问到你有自己的理解）；一键提炼洞见 → 自动入第二大脑 |
| **人生伙伴** | 反迎合内核（8 条判断纪律：第一句必须是明确判断 / 挑战坏问题的框架 / 强制呈现最强反方 / 诚实标注无知 / 不给情绪安慰给可执行判断 / 不和稀泥 / 观点与身份解耦 / 永远附下一步动作）+ 12 位名人智慧蒸馏 persona（Naval、Jobs、芒格、费曼、塔勒布、Paul Graham、Karpathy、Musk、张雪峰、张一鸣、MrBeast、Ilya）+ 圆桌模式（共同判断 + 分歧现场 + 合成建议） |

## 快速开始

```bash
npm install
npm run dev        # http://localhost:3000
```

打开即是**演示模式**（内置脚本化 AI，无需任何 Key），可完整体验：引导 → 计划 → 每日文档 → 验收 → 复习 → 读书 → 圆桌。

### 连接真实模型（BYOK，费用归用户）

`设置` 页选择服务商并填入 API Key（只存在本机浏览器，请求时由服务端转发，服务端不落盘）：

| 服务商 | 默认模型 | 备注 |
|--------|----------|------|
| Z.ai (智谱 GLM) | glm-4.6 | 也可选 glm-5.3 / glm-5.3-flash |
| DeepSeek | deepseek-chat | |
| Moonshot (Kimi) | kimi-k2-0905-preview | |
| OpenAI | gpt-5-mini | |
| 自定义 | — | 任意 OpenAI 兼容端点（OneAPI / Ollama / vLLM） |

### 部署者全局 Key（可选，让用户零配置）

```bash
vercel env add AI_PROVIDER    # zai / deepseek / moonshot / openai / custom
vercel env add ZAI_API_KEY    # 或对应服务商的 Key
vercel env add AI_MODEL       # 可选，如 glm-4.6
```

优先级：用户浏览器里的 BYOK > 服务端环境变量 > 演示模式。

## 部署到 Vercel

```bash
npm i -g vercel
vercel login
vercel --prod
```

零配置（`vercel.json` 已内置 Functions 时长 60s）。

## 架构

```
src/
  app/
    page.tsx               # 仪表盘：今日任务 / 待复习 / 在读的书
    learn/                 # 学习教练（列表 / 引导 / 目标详情+验收门）
    brain/                 # 第二大脑（知识库 / 间隔复习 / 统计）
    read/                  # 读书伙伴（书架 / 阅读工作台）
    council/               # 人生伙伴（12 persona + 圆桌）
    settings/              # BYOK / 数据导出导入
    api/chat/route.ts      # 唯一 AI 端点：NDJSON 流式，BYOK 头转发，Demo 分流
  lib/
    ai/prompts.ts          # 全部系统提示词（含反迎合内核与 persona 蒸馏）
    ai/client.ts           # 流式客户端 + JSON 稳健提取 + zod schema
    ai/providers.ts        # 服务商注册表
    ai/demo.ts             # 演示模式脚本（无 Key 全流程可用）
    store.ts               # zustand + localStorage 持久化
    types.ts / plan.ts / utils.ts / use-chat.ts
```

**数据**：全部存本机 localStorage（隐私友好、零成本）；`设置` 页可导出/导入 JSON 备份。多端同步与账号体系是 v2 路线（接 Postgres/Neon 即可，数据层已收口在 store.ts）。

## 设计取舍

- **AI 层自研 120 行 OpenAI 兼容流式客户端**而非绑定某版 SDK：国内主流服务商（Z.ai/DeepSeek/Moonshot）全部 OpenAI 兼容，自研层零依赖锁定、BYOK 直通、Demo 分流干净。
- **Demo 模式是一等公民**：无 Key 可跑通全流程，既做产品 onboarding，也做回归验收。
- **验收不放水**：fail 就是 fail，反馈给出最小补救动作；强制跳过有摩擦（输字确认）且留痕。
