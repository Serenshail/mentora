# 参考项目与现状诊断

## 1. 来源与阅读边界

- GitHub：[xingyao-y-code](https://github.com/fengchen122123-sudo/xingyao-y-code)。2026-11-15 实际拉取 dev，固定提交 **e827a976caf04aee9ba6d8d03486b7ee1c0524fd**。
- 用户提供的 [Gitee 地址](https://gitee.com/feng-chenhao/xingyao-y-code) 本轮网页工具读取失败；不声称两个镜像内容一致。
- 只读参考目录：`D:/zcode/agent/output/xingyao-reference-2026-11-15`。稀疏获取 core、frontend/src、tests 及根文件，未安装依赖、执行参考软件或修改其实现。
- 阅读重点：MessageBubble 的过程块与状态标题；useChatScroll 的 rAF/强制回底/用户意图；相关滚动测试；thinking_stream 的句界缓冲；reasoning_stream 的通道分流；context_builder 的稳定/动态上下文。不是参考项目全文件逐行审计，也没有实际运行其产品体验。
- 根 LICENSE 为 MIT，版权 2026 feng-chenhao。确实移植代码时须保留版权和许可、记录原文件与提交；仅借鉴设计也要记映射。不要复制 Vue 运行环境、Python 引擎、桌面 Shell/插件权限或整份编程助手提示词到 Mentora。

## 2. 具体借鉴

| 参考实现 | 可借鉴内容 | Mentora 落点 / 不照搬部分 |
| --- | --- | --- |
| [MessageBubble.vue](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/e827a976caf04aee9ba6d8d03486b7ee1c0524fd/frontend/src/components/MessageBubble.vue) | 每条消息内部折叠块、当前状态行、过程和正文区分、内部滚动 | React 共享过程组件；展示真实执行步骤、依据和适合公开的简短摘要。不照搬原始隐藏推理正文及其存储字段 |
| [useChatScroll.ts](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/e827a976caf04aee9ba6d8d03486b7ee1c0524fd/frontend/src/composables/useChatScroll.ts) | 同帧 force 优先、执行帧再次检查跟随权、明确用户滚动意图、无容器保留待执行意图、卸载取消 rAF | 首页消息容器控制器；保持会话与账户归属；不改成全局 window 滚动 |
| [useChatScroll.test.ts](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/e827a976caf04aee9ba6d8d03486b7ee1c0524fd/frontend/src/composables/useChatScroll.test.ts) | 排队帧与退出跟随竞态、force 升级、容器为空等行为用例 | 将同等行为移植为 React/浏览器验收，不直接拿 Vue 测试冒充已验证 |
| [thinking_stream.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/e827a976caf04aee9ba6d8d03486b7ee1c0524fd/core/thinking_stream.py) | 显示文本按句界/长度缓冲，减少逐 token 抖动 | 仅用于已允许公开的摘要/事件文案显示；不能把缓冲隐藏推理当作公开摘要生成器 |
| [context_builder.py](https://github.com/fengchen122123-sudo/xingyao-y-code/blob/e827a976caf04aee9ba6d8d03486b7ee1c0524fd/core/context_builder.py) | 稳定前缀与动态状态分开，减少重复注入，利于前缀缓存 | Mentora 按学习对象、用户约束、证据版本组装上下文；不导入星瑶的身份和工具策略 |

参考项目把 reasoning_content 显示出来这一事实，不证明照抄后模型就会更准确，也不意味着所有供应商都会返回同种通道。执行者必须先做供应商能力与输出语义核对，不能把私有推理转成另一种名字绕过公开边界。

## 3. Mentora 已证实的实现事实

| 编号 | 位置 / 事实 | 意义 |
| --- | --- | --- |
| D01 | `agent-home.tsx` 中 `onReasoning: () => {}`；runner 中 onThink 已传给 onReasoning | 首页在界面层丢弃该事件；不能仅改服务端就声称用户已能看见过程 |
| D02 | `session-runtime.ts` 的 describeHeadline 无可显示摘要时回退“正在等待模型响应”；LiveRun 仅有步骤时才显示过程按钮 | 没工具步骤的请求容易只剩一句等待。需要给等待真实计时、阶段与恢复行为，不虚构“在分析什么” |
| D03 | `chat/route.ts` 将 delta.reasoning_content 作为 think 事件并 slice(0,200)；客户端 h 与正文 d 分开 | h 既不是业务步骤，也不天然等于公开摘要。协议必须区分心跳、公开摘要和实际工具活动，避免误接线 |
| D04 | selectHistory 以 6000 字符选择近期消息，但较早用户摘录每条 200 字再全部拼接 | 不是真正的全局 token 上限，长历史仍可能膨胀；较早代码/模型解释可能丢失 |
| D05 | runner 同时维护 convo 与 toolLog，并把 toolLog 重新拼进 ctx | 存在重复证据注入风险，需要按最终请求指纹实测重复量；尚未量化节省比例 |
| D06 | AGENT_CHAT 有 deep 分支；ASK_COACH 仍有 100–200/200–400 字默认指导；前端用 wantsDeepExplanation 判模式 | 各入口深讲规则可能不一致。不能只优化首页而说“学习教练已经达标” |
| D07 | trimMetaEdges 会修剪中文段落首尾的无汉字行；stripMetaSentences 还逐句处理 | 混合语言合法内容可能被误伤，须用最终显示正文与原始用户可见正文比对；这是风险假设，需反例复现，未据此宣称所有英文都会丢 |
| D08 | 首页已有发送时 setFollowing(true)、scrollToBottom；一般流式输出也按 following 跟随 | 用户反馈不能归因“没有回底代码”。需要查首次没有容器、rAF 晚执行、旧会话帧、滚动事件及正文撑高的竞态 |
| D09 | 首页仅渲染最近 10 条 shown，并提示早期折叠；上下文另走 selectHistory | UI 历史与模型上下文必须分开验收；不能通过减少显示历史掩盖滚动问题 |

## 4. 质量不足的待验证因素

模型/版本与采样参数、推理能力配置、深讲路由误判、上下文不足或重复、工具读取对象不对、检索证据不可用、回答清洗误删、流截断、演示模式误入都可能影响结果。只凭界面不能确定哪一个占主因，更不能承诺“换一份提示词就提高到 90%”。实施前对每条基线保存 task、provider、model、实际请求哈希、上下文构成与最终正文，再做单因素比较。

用户原样例中 k=0 的三次反转说明存在边界错误；验收保留教学特征并纠正该错误，不能把模仿错误当成贴近样例。
