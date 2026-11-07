# ROLLBACK-V26.2 — 回滚说明

**回滚锚点**：tag `v26.1.5-isolation`（master `4218277`，V26.2 改动前的最后一个生产版本）。

## 数据回滚：不需要

本轮改动**零数据结构变化**：persist version 仍为 8、无迁移、新字段（`Book.verification`、`Goal.planHistory`）全部为可选字段，旧数据缺省即安全（不展示标记/历史）。回滚代码后新字段数据无害滞留。

## 代码回滚（按部署通道）

```bash
# Vercel（git 集成）：回滚到锚点
git revert <v26.2-merge-commit> && git push origin master
# 或使用 Vercel Promote 回到上一生产 build（不动 git）

# 腾讯云自托管：
#   ssh -i ~/.ssh/mentora-tencent.pem ubuntu@192.144.181.171
#   cd /opt/mentora && tar 恢复锚点版 src → CONTAINER_BUILD=1 npm run build
#   → cp public/.next/static → systemctl restart mentora
```

## 按项回滚（如只需撤销单项）

| 项 | 撤销方式 | 用户可见影响 |
|---|---|---|
| H1 学习人生入口 | revert learn/page.tsx 两处 | 学习人生回到不可达状态 |
| H2 书籍核查 | revert read-workspace/tool-executors/protocol/book-verify/miniprogram 三路径 | 回到「粘贴免检/agent 零核查」 |
| H3/H4 清洗 | revert runner.ts 过滤区 + agent-home onDelta + route.ts 错误文案 | 英文私语/上游报文可能再现 |
| H5/H6 阶段重排语义 | revert phase-regen/store.snapshotPhase/learn/[id]/actionPreview | 完成日显示清零问题回归 |

## 回滚演练

本地已验证：`git stash` → 工作树回到 4218277 → tsc/vitest/build 全绿（锚点自洽）；未在生产演练（等待部署批准后，若生产冒烟失败按上表执行）。
