# 给执行智能体的任务包

日期：2026-11-11 · 版本：1.0 · 状态：仅完成研究和规格，未实施、未运行产品验收。

请按顺序阅读：

1. [PRD.md](./PRD.md)：产品决定、状态与数据契约、交互、回答质量、预算、完成定义。
2. [REFERENCE-ANALYSIS.md](./REFERENCE-ANALYSIS.md)：星瑶固定提交的借鉴依据、适配边界与 Mentora 当前证据。
3. [EXECUTION-PLAN.md](./EXECUTION-PLAN.md)：T0–T5 执行顺序、涉及模块与每批交付。
4. [ACCEPTANCE.csv](./ACCEPTANCE.csv)：确定性验收场景；初始全部 NOT_RUN。
5. [QUALITY-CASES.json](./QUALITY-CASES.json)：8 道固定质量题，含原样输入、背景、关键要点与禁止项；使用 [QUALITY-SCORECARD.csv](./QUALITY-SCORECARD.csv) 记录盲评。
6. [EVIDENCE-CONTRACT.md](./EVIDENCE-CONTRACT.md)：交付证据、盲评与 Codex 独立验收方式。
7. [source-manifest.json](./source-manifest.json)：研究时源码摘要；[package-manifest.json](./package-manifest.json)：规格与用例版本摘要。

## 可直接转交的指令

> 按本目录 PRD v1.0 实施。先冻结当前版本和首次失败证据，再按 T0–T5 推进；不要整套复制星瑶，不要改历史评分来凑通过。优先交付会话隔离、发送/停止与滚动、真实计划编辑，再以固定样本优化回答与成本。模拟测试、真实 UI 与真实模型分别报告。已有未提交修改不得覆盖。完成后提交 EVIDENCE-CONTRACT 要求的证据包，由主人交回当前 Codex 对话独立验收。未执行或缺证据的项目保留待验，不宣称全站完成。

本轮只有文档与只读研究副本，无业务代码修改。主人的已有用户体验要求由本 PRD 继承；后续变化新增版本和决定记录，不静默改验收标准。
