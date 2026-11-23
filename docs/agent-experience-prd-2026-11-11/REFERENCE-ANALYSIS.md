# 星瑶源码研究与 Mentora 差距

研究日期：2026-11-11。本文是静态源码研究，不是参考产品运行测评，也不声称逐行读完其 1355 个受版本控制文件。

## 1. 来源与范围

- GitHub：<https://github.com/fengchen122123-sudo/xingyao-y-code>
- 主人提供的 Gitee 地址：<https://gitee.com/feng-chenhao/xingyao-y-code>；本轮网页工具读取失败，未比较镜像提交。
- GitHub dev 固定提交：`f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b`。
- 本地只读参考副本：`D:/zcode/agent/output/xingyao-reference-2026-11-11`；未安装依赖、执行应用或修改参考项目。
- LICENSE 原文为 MIT，版权 `Copyright (c) 2026 feng-chenhao`。若移植源码须保留该声明与许可；本轮没有复制参考实现进业务代码。

阅读方式：system_prompt_gui 的身份/核心/输出/工作流段；context_builder 的稳定/动态装配；sessionRuntime 与 useChatScroll 完整实现；MessageBubble 的思考块和 live headline；InputArea 的发送/停止分支；appStore 的会话归属与 delta/final 分支；tool_pipeline 的 RepeatCallGuard 与并发上下文传播；progress_guard 判定；tool_cache 缓存作用域/限额；memory_compressor 的配置与入口；turn_limits 配置；resume_policy 的重放分类。大型模块只做与任务相关的定点读取，不宣称完整审计。

## 2. 借鉴矩阵（链接固定到提交）

| 源码 | 实际观察 | Mentora 决策 |
|---|---|---|
| [sessionRuntime.ts](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/frontend/src/stores/sessionRuntime.ts) | 会话级草稿、附件、streamingText、thinkingText、running、用量和面板状态 | 借鉴作用域，增加 Mentora 自身 user/session/run/action 身份；不照搬 Vue store |
| [appStore.ts](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/frontend/src/stores/appStore.ts) | thinking_delta/token_delta/message_final 分离，处理会话事件和后台任务 | 借鉴事件归属；最终校正采用明确版本/序号，不复制“只接受更长全文”的全部细节 |
| [MessageBubble.vue](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/frontend/src/components/MessageBubble.vue) | 消息内折叠思考块、折叠时最新行预览、用户展开偏好、真实计时 | 借鉴消息内过程交互；使用可公开摘要/执行事件；不无条件转储内部推理或照搬悬停才显露入口 |
| [InputArea.vue](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/frontend/src/components/InputArea.vue) | 同位发送/停止；其 sendStopMode 为 running 且无输入，输入新内容会切换排队发送 | 只采用同位入口；Mentora 运行中无论是否有草稿均保留停止，Enter 不隐式排队 |
| [useChatScroll.ts](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/frontend/src/composables/useChatScroll.ts) | 区分真实用户滚动意图与程序布局，force 回底，帧合并，防向上意图与增量竞态 | 直接借鉴行为设计；Mentora 切会话恢复位置，主动发送才强制回底 |
| [context_builder.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/core/context_builder.py) | 稳定前缀与动态运行上下文分离，避免每轮无意义变动破坏缓存 | 借鉴分层，替换为学习背景、对象版本、用户事实；不引入桌面 Shell/技能权限规则 |
| [tool_pipeline.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/core/harness/tool_pipeline.py) | 参数规范化签名；同签名成功两次后抑制第三次；并行调用传递会话等上下文 | 借鉴规范化与归属传播；业务版本变化使缓存失效，不能盲禁所有重复读取 |
| [progress_guard.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/core/harness/progress_guard.py) | 用快照/提交/有界新读取判断进展，避免无限换目标 | 转换为业务任务进展；不复制大代码库调查的 12 stalled steps、48 reads 门槛 |
| [tool_cache.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/core/tool_cache.py) | 会话作用域共享缓存、条数/单项/总字节上限 | Mentora 按用户权限和对象版本隔离，写入后失效；实际节省需计量 |
| [memory_compressor.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/core/memory_compressor.py) | 按水位压缩、有界工具结果和压缩预算 | 不默认每轮增加副模型；先做事实摘要/相关选择，触发压缩才计入成本 |
| [turn_limits.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/core/harness/turn_limits.py) | 默认 200 provider steps，可配置 | 明确不照搬；Mentora 应先减少无效调用，不能靠扩大循环修复计划编辑 |
| [resume_policy.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/core/harness/resume_policy.py) | 读取与副作用分开，未知状态不自动重放 | 借鉴幂等与恢复约束，不移植整个 SQLite journal |
| [system_prompt_gui.md](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/f1d13c31c5b30154b8f6c6fab6f5d18993a89e6b/system_prompt_gui.md) | 诚实、阶段汇报、证据、输出与工具规则；定位为编程搭档，包含鲜明人格 | Mentora 已有类似核心/输出规则；不能据此推断再次复制即可提高教学质量；不引入人格口癖 |

## 3. 当前 Mentora 定点证据

基线 HEAD 为 `facf520def63bb0419197dc94b5c4b5877c82212`，有大量未提交改动。以本包 source-manifest.json 的文件摘要为本轮观察快照，不能仅用 HEAD 识别部署版本。

| 位置（读取时行号） | 事实 | 对应要求 |
|---|---|---|
| src/components/agent-home.tsx:184–202 | runSessionId、busy、pending、abortRef、滚动 ref 位于单个组件 | CX-01/02 |
| 同文件:279、824、831 | send 与输入按钮受全局 busy 限制 | CX-01、UI-01 |
| 同文件:342 | onReasoning 为空回调 | UI-02；需定义安全可展示摘要，而非直接取消隔离 |
| 同文件:759 | 思考标签仅判断 busy/runPhase，不同于其他分支的会话条件 | U05、S02 |
| 同文件:311 | 本轮直接历史固定最近 9 条 | CTX-01；其他记忆路径是否补回要实测 |
| 同文件 buildCtx | 默认取首个 active goal | ACT-01、C03 |
| 同文件 send/scroll | 上滚后暂停跟随，发送分支未见重置 following | UI-03 |
| src/lib/agent/runner.ts | 有结构化工具/计划/过程回调、非相邻重复未由 lastRoundSigs 完整覆盖 | RUN-01，保留现有协议优点 |
| src/lib/agent/protocol.ts:475 | MAX_TOOL_ROUNDS=5；实际请求还含收尾分支 | COST-01，记录真实请求数 |
| src/lib/ai/prompts-lite.ts | 深讲由关键词/图片触发 | ANS-01，补追问上下文测试 |
| src/lib/ai/prompts.ts 的 AGENT 提示词 | 简洁规则与强制深讲骨架并存 | 按任务统一规则优先级，以固定题验证 |

以上事实不能证明所有线上根因，需执行者在主人使用的构建版本复现。不得将本报告误称为“星瑶全项目逐行审计”或“真实模型已经验证”。
