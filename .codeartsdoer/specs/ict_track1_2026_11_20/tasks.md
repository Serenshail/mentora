# Mentora 华为 ICT 创新赛赛题一参赛版 编码任务规划

| 项 | 值 |
| --- | --- |
| 任务文档标识 | `ict_track1_2026_11_20/tasks.md` |
| 版本 | 1.1 |
| 日期 | 2026-11-20 |
| 上游 | `spec.md`（73 条 EARS，P0 59 / P1 14）、`design.md`（E-1~E-12、B-1~B-10、D-1~D-11） |
| 基线 | 分支 `feature/huawei-cloud-upgrade`，HEAD `facf520`，工作区 507 项未提交变更 |
| 任务总数 | 54 个执行单元（11 个批次）；其中 44 个本轮可执行、10 个阻塞项单列（主编号 001~051 不变，T-ICT-007 拆为 007a~007d） |
| 证据根目录 | `docs/evidence/ict-track1-2026-11-20/`，仅 7 个子目录（见 16 章） |
| 状态口径 | `PASS / FAIL / BLOCKED / NOT_RUN` |

> 本文档只做任务规划，不含实现代码，不修改任何业务源码，不创建 git 提交。

## 0. 本轮修订说明

### 0.0 v1.2（2026-11-20，用户确认开工时追加的约束）

**A. 幂等与丢回执语义（T-ICT-007b / T-ICT-009）**
- 保留现有同步语义：同内容幂等判定必须**先于**基线校验，否则旧基线原样重发会被误判 409。
- 同一账户下，「初次写入成功但回执丢失 + 客户端用旧版本原样重发相同内容」→ 返回云端**当前版本**，版本号与归档条目均不增加。
- 旧版本提交**不同内容**→ 仍返回 409，不得因回执匹配而隐式放行。
- 上述用例为同一组定义，D1 与 RDS 各执行一次，结论分别归档。

**B. 客户端自动重推保护（T-ICT-020 / T-ICT-021）**
- 沿用现有 `acknowledgedUpload` / `rememberUpload` 保护，三条前置同时成立才可对齐：回执属于当前账户且命中本机 `recentUploads`；当前编辑晚于该次上传（`edit < 当前 edit`）；云端不存在本机缺失的文件/条目。
- 409 响应体不足以核实文件完整性时，先 `GET /api/sync` 读取云端状态逐项核对；核对不通过即进入冲突态，不重推。
- 重推最多一次；重推请求发出后产生的新编辑必须保留待同步标记，不得被本次成功回执清除。

**C. 批次 0 的降级顺序（T-ICT-001 / T-ICT-002）**
- 先尝试采集 D1 基线，但**只有确认使用隔离环境**（隔离键 + 隔离账号/库）才实测；否则记 `BLOCKED`。
- D1 不可用：暂停一切 D1 代码改动与实测对比，继续独立的本地 PostgreSQL 工作，不得用本地结论替代 D1 基线。
- 本地 PG 不可用：暂停依赖数据库的验证，继续代码审查（T-ICT-003）与可独立完成的准备工作。
- 占位脚本本轮不建，在 `docs/evidence/ict-track1-2026-11-20/INDEX.md` 标注「待实现」与解除条件。

**D. 命名与证据分工**
- 工作区「507 项」是 `git status` 的**目录折叠计数**（`.codeartsdoer/` 目录记为 1 项、内含 3 文件），不是文件数。
- 日志与业务证据沿用 7 个子目录：日志归 `gate/`，业务语义归 `rds/`。
- `T-ICT-007d` 只做事务提交层的最小并发验证；`T-ICT-026` 做同步接口的 20 轮复验；客户端丢回执恢复由 T-ICT-020/021 的客户端用例单独验证，三者不互相替代。
- 本轮不创建 git 提交。

### 0.1 v1.1（任务粒度、路径、命令、阻塞口径）

与 v1.0 相比只有四类改动，其余章节保持原样：

**A. 拆分（任务粒度）**
- `T-ICT-007` 原同时承载「advisory lock + 事务边界 + 读取顺序 + 判定顺序 + 409 字段 + 回滚 + 并发证据」7 条标准，无法独立验收，拆为四个可分别勾选、分别出证据的子任务，编号链不跳号：
  - `T-ICT-007a` 互斥键与事务边界（含回滚）；
  - `T-ICT-007b` 单查询读取与固定判定顺序（①~⑤）；
  - `T-ICT-007c` 409 载荷与冲突零副作用；
  - `T-ICT-007d` 提交路径并发自证（20 轮）。
- 依赖链变为 `006 → 007a → 007b → 007c → 007d`；全文对「T-ICT-007 完成」的引用一律改为对应子任务号（见 2.1、2.2、5.2、各任务前置依赖）。
- 未合并任何任务：008/009/010/011 仍独立，因其失败面不同（残留块 / 幂等 / 错误映射 / 归档）。

**B. 路径统一（证据目录）**
- 证据根目录下只保留 7 个子目录：`baseline/`、`pg-local/`、`rds/`、`d1/`、`gate/`、`cloud/`、`codearts/`；v1.0 的 `sync/`、`build/`、`deploy/`、`version/`、`diff/`、`demo/`、`quant/`、`materials/`、`history/`、`pending/` 全部并入，逐任务精确文件名见 **16.1**，该表为唯一权威。
- 实测 `docs/evidence/ict-track1-2026-11-20/` 当前**不存在**，本轮为首次创建，无存量文件迁移动作（不需要 mv/git mv）。
- 任务正文若出现 v1.0 旧前缀（`sync/`、`build/`、`deploy/` 等），一律按 16.1 表落到新子目录，不再作为写入目标。

**C. 命令修正（Windows + git-bash 实测口径）**
- `package.json` 核对结果：`test` = `vitest run`、`build` = `next build`、**无** `tsc`/`typecheck`/`lint:ci` 脚本；本地 `node_modules/.bin` 存在 `tsc`、`vitest`、`next`、`eslint`。
- 因此：类型检查用 `npx tsc --noEmit`；单测优先 `npm test -- <files>`（等价 `npx vitest run <files>`）；构建用 `npm run build -- --webpack`（等价 `npx next build --webpack`，已确认 `next` bin 支持该 flag，依据 `docs/CODEARTS-PRACTICE.md` 第四节第 1 条沙箱约束）。
- git-bash 取连接串的两道防线：脚本侧用 `process.stdout.write` 且不带尾随换行（T-ICT-002 验收 4）；若输出仍带 CR，终端用 `TEST_RDS_URL=$(node scripts/ict-test-pg.mjs url | tr -d '\r')` 兜底，否则 Windows 换行会污染 URL 导致连接失败。
- 共用同一测试库的批次追加 `--no-file-parallelism`（vitest 5.0.1 支持），代替 v1.0 的 `--sequence.concurrent=false`（后者只影响单文件内并发，不能阻止文件并行抢库）。
- `scripts/ict-*.mjs`、`scripts/verify-snapshot-rds.mjs`、`scripts/freeze-ict-snapshot.mjs` 由对应任务创建后才可执行；门禁表已标注「脚本前置」。

**D. 阻塞口径（B-1~B-10）**
- 每个阻塞项新增四栏：**阻塞期间可完成** / **不可完成** / **替代证据标注** / **解除后命令**，汇总见 **13.0**。
- 「解除后命令」逐条标注 `[脚本已存在]` 或 `[脚本待新增]`，避免把尚不存在的入口写成可执行事实。
- 替代证据一律带 `environment:` 前缀，且必须写明「不等同」对象（华为云 RDS / DCS / MaaS / 公网入口），不得因补栏把状态提升为 `PASS`。

---

## 1. 文档定位与执行口径

### 1.1 与 spec / design 的关系

- `spec.md` 定义外部可观察行为与验收条件（R00–R08、73 条 EARS）。
- `design.md` 定义实现模型、接口契约、事务规则与证据口径（E-1~E-12、2.6 测试策略、2.11 可执行清单）。
- 本文档把 design 的 E-1~E-12 展开为可勾选的执行单元，并把 design 2.11.3 的 T-A~T-K 映射为批次。
- 任何任务与 design 冲突时，以 `spec.md` 的行为约束为准，并在 `docs/evidence/ict-track1-2026-11-20/codearts/DEVIATIONS.md` 登记「设计点 → 偏差 → 理由 → 验证」。

### 1.2 四态与证据规则

1. 每个任务只允许四种结论：`PASS`（实测满足全部验收标准）、`FAIL`（已执行且不满足）、`BLOCKED`（外部条件缺失，附解除条件）、`NOT_RUN`（未执行，附计划时点）。
2. 本地临时 PostgreSQL 容器的结论统一标注 `environment: local-equivalent`，**不得**写「华为云 RDS 已验证」。
3. 真实 D1 的结论标注 `environment: real-d1`，不得与华为云条目合并统计。
4. 自动化检查通过只代表工程门禁通过，**不等于**用户验收通过；用户验收由 T-ICT-041 单独交付。
5. 失败与未执行条目必须保留原文，不允许删除、改写或只留成功项（REQ-08-03）。
6. 证据文件按任务编号命名：`<类别>/T-ICT-0NN-<slug>.<ext>`；同一任务多次执行追加 `-run2`，不覆盖首轮。

### 1.3 工作区与新增文件纪律

1. 本轮开始前记录一次只读基线：
   - `git rev-parse --short HEAD`
   - `git status --porcelain | wc -l`
   - `git status --porcelain | sha256sum`
   写入 `codearts/T-ICT-003-workspace-baseline.txt`。
2. **禁止**执行 `git clean`、`git checkout -- .`、`git reset`、`git stash`（含 `--include-untracked`）、`git add -A`/`git add .`。
3. 任何 git 命令必须显式指定路径；只允许 `status`、`diff -- <path>`、`show`、`ls-files`、`rev-parse`。
4. 本轮新增文件必须可独立识别：
   - 源码：文件名含 `snapshot-`、`version-token`、`sync-receipt`、`build-badge`、`ict-` 前缀；
   - 脚本：`scripts/ict-*.mjs`、`scripts/verify-snapshot-rds.mjs`、`scripts/freeze-ict-snapshot.mjs`；
   - 证据：仅落在 `docs/evidence/ict-track1-2026-11-20/`；
   - 测试：`src/lib/__tests__/{snapshot,sync-receipt,ict}-*.test.ts`。
5. 业务源码的修改范围限定为：`src/lib/server/db.ts`、`src/app/api/sync/route.ts`、`src/lib/auth-client.ts`、`src/app/layout.tsx`、`src/components/app-shell.tsx`；其余文件只新增不修改。
6. 上一轮 Codex 对 `db.ts`、`sync/route.ts`、`sync-conflict-409.test.ts` 的未提交修改属「初步修改」，本轮必须先经 T-ICT-003 审查再取舍，任何材料不得描述为码道本轮生成（REQ-02-03）。

### 1.4 编号、字段与路径约定

- 任务编号 `T-ICT-001` ~ `T-ICT-051` 全局唯一、不复用；组内编号（如 `3.1`）仅用于目录导航。
- 每个任务固定七个字段：目标、涉及文件、前置依赖、验收标准、证据产出、判定、预估改动范围。
- 「预估改动范围」的 `L` 行数为量级估计（`S ≤ 50`、`M 51–150`、`L 151–300`、`XL > 300`），执行后以实际 diff 为准。
- 所有命令默认工作目录为 `D:/zcode/agent/mentora`；shell 为 git-bash（Windows），PowerShell 等价写法在批注中给出。
- 各任务「证据产出」中的相对路径均相对 `docs/evidence/ict-track1-2026-11-20/`；`src/...`、`scripts/...` 为仓库路径，不在此列。
- **（v1.1）证据只允许写入 7 个子目录**：`baseline/`、`pg-local/`、`rds/`、`d1/`、`gate/`、`cloud/`、`codearts/`。子目录归属与逐任务精确文件名以 16.1 为准；任务正文出现 `sync/`、`build/`、`deploy/`、`version/`、`diff/`、`demo/`、`quant/`、`materials/`、`history/`、`pending/` 属 v1.0 旧写法，不得据此建目录。
- **（v1.1）命令基线**：所有命令在 `D:/zcode/agent/mentora` 下用 git-bash 直接执行；类型检查 `npx tsc --noEmit`（无 script）、单测 `npm test -- <files>`（script `test` = `vitest run`）、构建 `npm run build -- --webpack`（script `build` = `next build`，需显式传 `--webpack`）。

---

## 2. 任务依赖图与批次划分

### 2.1 依赖图

```text
[批次 0 · 串行首发]
T-ICT-001 D1 基线 ────────────────┐
T-ICT-002 PG 基座 ────────────────┤
T-ICT-003 初步修改审查 ───────────┘
        │
        ├──> [批次 1] T-ICT-004 令牌 ──> T-ICT-005 类型契约
        │                                   │
        │            ┌──────────────────────┘
        │            v
        ├──> [批次 2] T-ICT-006 事务外壳 ──> T-ICT-007a 互斥锁/事务边界
        │                                   ──> T-ICT-007b 单查询读取/固定判定
        │                                   ──> T-ICT-007c 409 载荷/零副作用
        │                                   ──> T-ICT-007d 提交并发自证（20 轮）
        │                                      ├──> T-ICT-008 首次创建/残留块
        │                                      ├──> T-ICT-009 幂等/版本
        │                                      ├──> T-ICT-010 失败映射
        │                                      └──> T-ICT-011 归档服务
        │                                                │
        ├──> [批次 3] T-ICT-012 分块读取 ──> T-ICT-013 缺块 503 ──> T-ICT-014 自愈迁移
        │            （依赖 007b）
        ├──> [批次 4] T-ICT-015 GET 接入 ──> T-ICT-016 POST/409 ──> T-ICT-017 403
        │            （依赖 007b/012）       └──> T-ICT-018 归档字段 ──> T-ICT-019 断言同步
        ├──> [批次 5] T-ICT-020 客户端对齐 ──> T-ICT-021 跨设备反例
        ├──> [批次 6] T-ICT-022 gate 残留块 ─┐
        │            T-ICT-023 d1Get 缺块 ───┼──> T-ICT-025 D1 对比回归（依赖 001）
        │            T-ICT-024 D1 details ───┘
        ├──> [批次 7] T-ICT-026 并发 20 轮 ──> 027 故障注入 ──> 028 分块/大快照
        │            ──> 029 归档/幂等 ──> 030 隔离/非快照 ──> 031 报告脚本
        │            （依赖 002 + 007d + 008~011）
        ├──> [批次 8] T-ICT-032 页脚 ── 033 冻结 ── 034 证据骨架 ── 035 量化 ── 036 演示脚本
        │            （与代码批次并行，互不依赖）
        └──> [批次 9] T-ICT-037 tsc ──> 038 vitest ──> 039 build ──> 040 INDEX/映射 ──> 041 验收交付
                     （依赖所有已完成批次）
```

串行硬约束（不可调换）：

1. `T-ICT-001` 必须是第一个执行单元；`T-ICT-002` 必须是第二个。理由：没有基线则「D1 不退化」不可证明；没有容器基座则所有 RDS 行为证据都无法产生。
2. `T-ICT-007c` 之前不得改 `sync/route.ts` 的写入分支，避免出现「路由已切事务、事务未就绪」的中间态。
3. `T-ICT-019` 必须在 `T-ICT-016/017` 之后，否则断言更新对象尚不存在。
4. `T-ICT-025` 必须在 `T-ICT-001` 且 `T-ICT-022/023/024` 之后。
5. `T-ICT-040` 必须在所有产生证据的任务之后；`T-ICT-041` 最后。

可并行关系：

- `T-ICT-004` 与 `T-ICT-005` 可并行（都只依赖批次 0 的结论）。
- `T-ICT-008/009/010/011` 在 `T-ICT-007c` 合入后可并行，但共用同一测试库，执行时必须加 `--no-file-parallelism`（vitest 5.0.1）串行跑文件。
- `T-ICT-022/023/024` 与批次 2~5 完全并行（D1 通道独立）。
- 批次 8 全部任务与代码批次并行。

### 2.2 批次表

| 批次 | 名称 | 任务 | 执行方式 | 进入条件 | 主要产出 |
| --- | --- | --- | --- | --- | --- |
| 0 | 基线与验证基座 | 001–003 | 串行 | 无 | D1 基线 JSON、PG 容器脚本、初步修改审查记录 |
| 1 | 并发契约层 | 004–005 | 可并行 | 批次 0 完成 | 令牌纯函数、类型与错误契约 |
| 2 | RDS 事务提交 | 006–011（含 007a–007d） | 006→007a→007b→007c 串行；007d 与 008~011 可并行 | 批次 1 完成 | `snapshot-store.ts`、事务外壳、锁与判定、409 载荷、归档服务 |
| 3 | 分块兼容与自愈 | 012–014 | 串行 | 007 完成 | `readSnapshot`、缺块错误、自愈用例 |
| 4 | 路由接入与错误码 | 015–019 | 串行 | 007、012 完成 | `/api/sync` 新契约、403、archive、断言更新 |
| 5 | 客户端丢回执 | 020–021 | 串行 | 016 完成 | 一次对齐重推 + 反例测试 |
| 6 | D1 对齐与回归 | 022–025 | 022/023/024 并行 → 025 | 001 完成 | D1 三处语义对齐、对比报告 |
| 7 | 行为级集成证据 | 026–031 | 串行（共享测试库） | 002 + 007–011 | 并发/故障/分块/归档/隔离报告 |
| 8 | 交付物与展示 | 032–036 | 可并行 | 无（032 依赖 016 的版本语义） | 页脚标识、冻结脚本、证据骨架、量化模板、演示脚本 |
| 9 | 收尾门禁 | 037–041 | 串行 | 1–8 已完成部分 | 门禁日志、INDEX、映射表、验收清单 |
| 10 | 阻塞项 | 042–051 | 不执行云端动作 | — | 阻塞登记与解除后执行包 |

**E-1~E-12 覆盖映射（与 design 2.11.1 对齐）**

| 设计项 | 任务 | 覆盖说明 |
| --- | --- | --- |
| E-1 快照服务层契约 | T-ICT-004、T-ICT-005 | 令牌纯函数、`Expectation`/`CommitOutcome`/错误类型 |
| E-2 RDS 事务提交 | T-ICT-006~011（007 拆为 007a~007d）；证据载体 T-ICT-026~031 | 专用连接、互斥锁、事务边界、条件判定、409 载荷、回滚、归档 |
| E-3 分块读取与自愈 | T-ICT-012~014；用例 T-ICT-028 | 识别、拼接、缺块报错、写一次即迁移 |
| E-4 路由接入与错误码 | T-ICT-015~019；隔离用例 T-ICT-030 | 409 字段、403、`archive`、结构化事件 |
| E-5 客户端对齐重推 | T-ICT-020、T-ICT-021 | 一次对齐 + 跨设备反例 |
| E-6 D1 三处对齐 | T-ICT-022~024；回归 T-ICT-025 | gate 块检查、缺块报错、冲突 details、基线对比 |
| E-7 页脚运行标识 | T-ICT-032 | 服务端取值、只读展示、同源校验 |
| E-8 冻结脚本与重建 | T-ICT-033；门禁 T-ICT-037~039 | manifest、密钥扫描、四步重建 |
| E-9 证据骨架与模板 | T-ICT-034；回填 T-ICT-040 | 7 类子目录（v1.1）、七字段、INDEX |
| E-10 量化模板 | T-ICT-035 | 任务、指标、样本、结论约束 |
| E-11 演示脚本与采集点 | T-ICT-036 | 七步主线、异常路径、三元组 |
| E-12 本机门禁 | T-ICT-037、T-ICT-038、T-ICT-039 | tsc、vitest、build --webpack |

### 2.3 每批完成后的门禁命令

| 批次 | 门禁命令（Windows + git-bash 可直接执行） | 通过标准 |
| --- | --- | --- |
| 0 | `node scripts/ict-baseline-d1.mjs --capture`（脚本由 001 创建）；`node scripts/ict-test-pg.mjs start && node scripts/ict-test-pg.mjs schema && node scripts/ict-test-pg.mjs status`（脚本由 002 创建） | 基线 JSON 四项齐全；容器 `pg_isready` 通过；`kv` 表存在 |
| 1 | `npx tsc --noEmit && npm test -- src/lib/__tests__/snapshot-version-token.test.ts src/lib/__tests__/snapshot-expectation.test.ts` | tsc 0 错；单测全绿、0 skip |
| 2 | `export TEST_RDS_URL=$(node scripts/ict-test-pg.mjs url); npm test -- --no-file-parallelism src/lib/__tests__/snapshot-rds-tx-shell.test.ts src/lib/__tests__/snapshot-rds-lock-tx.test.ts src/lib/__tests__/snapshot-rds-decision.test.ts src/lib/__tests__/snapshot-rds-conflict-409.test.ts src/lib/__tests__/snapshot-rds-commit-concurrency.test.ts` | 事务/锁/判定/409/并发五组用例全绿；容器可用时 0 skip |
| 3 | `export TEST_RDS_URL=$(node scripts/ict-test-pg.mjs url); npm test -- --no-file-parallelism src/lib/__tests__/snapshot-rds-read.test.ts src/lib/__tests__/snapshot-rds-selfheal.test.ts` | 分块读回逐字节一致；缺块报错；自愈后块行 0 |
| 4 | `npm test -- src/lib/__tests__/sync-conflict-409.test.ts src/lib/__tests__/sync-post-conflict.test.ts src/lib/__tests__/sync-account-mismatch-403.test.ts src/lib/__tests__/audit-sync-stream-cap.test.ts && npx tsc --noEmit` | 断言同步完成；403 生效；tsc 0 错 |
| 5 | `npm test -- src/lib/__tests__/sync-receipt-recovery.test.ts src/lib/__tests__/sync-receipt-cross-device.test.ts` | 命中重推 1 次；不命中保持冲突；fetch 次数断言成立 |
| 6 | `node scripts/ict-baseline-d1.mjs --compare docs/evidence/ict-track1-2026-11-20/baseline/T-ICT-001-d1-baseline.json` | 无非预期差异；差异逐条解释 |
| 7 | `export TEST_RDS_URL=$(node scripts/ict-test-pg.mjs url); node scripts/verify-snapshot-rds.mjs --reuse --report` | 退出码 0（全通过且 skip=0）；否则 1/2 并记录原因 |
| 8 | `node scripts/freeze-ict-snapshot.mjs --dry-run && npx tsc --noEmit` | dry-run 不写工作区且清单统计合理；tsc 0 错 |
| 9 | `npx tsc --noEmit && npm test -- && npm run build -- --webpack` | 三条退出码均为 0；skip 数与已知基线一致 |

命令口径说明（v1.1）：

1. `npm test` 即 `package.json` 的 `test: vitest run`；`npm test -- <files>` 等价 `npx vitest run <files>`，`npm test --` 不带参数即全量。
2. `npm run build -- --webpack` 等价 `npx next build --webpack`；`build` 脚本本身是 `next build`（Turbopack），**必须**显式传 `--webpack`。
3. `npx tsc --noEmit` 无对应 script（`typescript` 在 devDependencies，`node_modules/.bin/tsc` 存在）。
4. 表格内命令依赖 `ict-test-pg.mjs url` 用 `process.stdout.write` 输出且**不带尾随换行**（T-ICT-002 验收 4），因此可整行复制执行。若该脚本输出带 CR，在终端改用兜底写法：`export TEST_RDS_URL=$(node scripts/ict-test-pg.mjs url | tr -d '\r')`（管道含 `|`，不写入表格以免破坏列）。
5. 批次 2/3/7 共用同一测试库，必须 `--no-file-parallelism`；跨批次串行执行。

PowerShell 等价（批次 2/3/7）：`$env:TEST_RDS_URL = (node scripts/ict-test-pg.mjs url).Trim(); npm test -- --no-file-parallelism <files>`

---

## 3. 批次 0：基线与验证基座（串行首发）

**批次门禁**：见 2.3 批次 0。本批任何 `BLOCKED` 必须在 `docs/evidence/ict-track1-2026-11-20/INDEX.md` 登记，且不得跳过后直接进入代码批次（T-ICT-003 例外：不依赖外部条件）。

### 3.1 T-ICT-001 采集改造前 D1 并发行为基线

- **目标**：在本轮任何 D1 代码改动之前，用真实 D1 通道采集「并发判定、归档、同内容幂等、普通写入」四项行为基线，形成可机读 JSON，作为 REQ-04-17「D1 不退化」的唯一比较基准。
- **涉及文件**：
  - 新增 `scripts/ict-baseline-d1.mjs`（采集与 `--compare` 对比入口）；
  - 只读 `src/lib/server/db.ts`（当前工作区版本，含上一轮 gate 改造）；
  - 证据 `docs/evidence/ict-track1-2026-11-20/baseline/T-ICT-001-d1-baseline.json`、`baseline/T-ICT-001-notes.md`、`baseline/T-ICT-001-head-db.ts.txt`。
- **前置依赖**：无（本任务必须是第一个执行单元）。需要 `.env.local` 中现有 D1 凭据，且已确认使用**隔离环境**（隔离键 + 隔离账号/库，见验收 1）；凭据缺失或无法确认隔离即 `BLOCKED`。
- **降级规则**：`BLOCKED` 时在证据 JSON 写 `blockedReason`，在 `INDEX.md` 登记；随后**暂停一切 D1 代码改动与实测对比**（T-ICT-022~025 的 D1 部分挂起），继续 T-ICT-002 的本地 PostgreSQL 基座与 T-ICT-003 的代码审查。不得用本地 PG 结论替代 D1 基线。
- **验收标准**（行为级）：
  1. 使用隔离键 `data/ict-baseline-<uuid>.json` 与 `versions/ict-baseline-<uuid>/`，不得读写任何真实用户路径；结束时删除隔离键并记录清理结果。
  2. 并发用例：两路独立请求基于同一基线并发提交，记录两个响应的 `status`、`conflict`、`currentVersion`、`updatedAt`；如出现双成功，如实写入 `doubleSuccess: true` 与两版内容哈希，不做修正。
  3. 归档用例：连续推进 3 次后记录归档条目数与每份内容哈希；原样重复提交后记录版本是否变化、归档是否新增。
  4. 普通写入用例：非快照路径的写、存在性写、读、删除各执行一次并记录返回值与读回结果。
  5. JSON 至少含：`capturedAt`、`branch`、`commit`、`d1EnvFingerprint`（不含凭据）、`gitStatusDigest`（`git status --porcelain` 的 sha256）、`cases[]`、`cleanup`。
  6. 额外留档：`git show facf520:src/lib/server/db.ts > docs/evidence/ict-track1-2026-11-20/baseline/T-ICT-001-head-db.ts.txt`（只读导出，不覆盖工作区），用于区分「HEAD 实现」与「当前工作区实现」。
- **证据产出**：`baseline/T-ICT-001-d1-baseline.json`、`baseline/T-ICT-001-notes.md`、`baseline/T-ICT-001-head-db.ts.txt`；基线 JSON 为后续 T-ICT-025 的输入。
- **判定**：`PASS` = 四项均有实测值且隔离键已清理；`FAIL` = 任一项抛错、缺项或写入真实路径；`BLOCKED` = D1 凭据缺失、网络不可达或无法确认隔离环境（JSON 内写 `blockedReason`）；`NOT_RUN` = 未启动。
- **预估改动范围**：新增脚本 L（约 200–280 行）+ 证据 3 文件；**0 行业务源码改动**。

### 3.2 T-ICT-002 临时 PostgreSQL 验证基座

- **目标**：提供可复现、有界、可显式跳过的临时 PostgreSQL 容器生命周期与 schema 初始化；容器不可用时必须显式 `SKIP/BLOCKED`，不得静默通过。
- **涉及文件**：
  - 新增 `scripts/ict-test-pg.mjs`（子命令 `start|stop|status|schema|url`）；
  - 复用只读 `scripts/init-rds-schema.mjs`（DDL 与运行时一致）；
  - 证据 `docs/evidence/ict-track1-2026-11-20/pg-local/T-ICT-002-container.json`、`pg-local/T-ICT-002-docker.log`。
- **前置依赖**：T-ICT-001 已执行（允许其结论为 `BLOCKED`，但顺序不可跳过）。
- **验收标准**：
  1. `start`：容器名 `ict-pg-verify`、镜像 `postgres:16-alpine`、端口 `55432`、密码为运行时随机值；先清理同名残留容器再启动。
  2. 就绪等待有界：`pg_isready` 最多 60 次、每次 1 秒；超时则输出 `docker logs --tail 50` 并以退出码 3 结束，打印 `BLOCKED: postgres container not ready`。
  3. `schema`：以临时连接串执行 `init-rds-schema.mjs`，随后查询 `to_regclass('public.kv')` 必须返回 `kv`。
  4. `url`：仅向 stdout 输出连接串（`process.stdout.write`，**不带尾随换行**，便于 `$(...)` 取值），不写入仓库、证据或日志；证据 JSON 只记录 `container/image/port/startedAt/readyMs/exitCode`。
  5. `stop`：容器消失；`status` 返回 `running|absent` 且退出码对应 0/3。
  6. 重复 `start` 幂等（先停旧再起新），不因残留容器失败。
- **证据产出**：`pg-local/T-ICT-002-container.json`、`pg-local/T-ICT-002-docker.log`；`pg-local/T-ICT-002-skip-policy.md` 记录「无 Docker / 无法拉镜像 / 端口占用」三类跳过判定。
- **判定**：`PASS` = 五个子命令均符合预期且 `kv` 可查；`FAIL` = 脚本异常或 schema 未建成；`BLOCKED` = Docker 守护进程不可用或镜像不可拉取（退出码 3）；`NOT_RUN` = 未执行。
- **降级规则**：`BLOCKED` 时在 `INDEX.md` 登记原因与解除条件；**暂停所有依赖数据库的验证**（T-ICT-007d、026~031、以及 007b/007c 的集成断言），继续 T-ICT-003 代码审查、契约定义（004/005）与文档/脚本准备。不得用源码正则测试冒充事务与并发证据。
- **预估改动范围**：新增脚本 L（约 160–240 行）；**0 行业务源码改动**。

### 3.3 T-ICT-003 上一轮初步修改审查与取舍登记

- **目标**：在改动任何代码前，对上一轮 Codex 留在工作区的三处初步修改逐 hunk 审查，形成「保留 / 修正 / 否决」结论与理由，确保本轮不把他人修改冒充为码道产出（REQ-02-03、REQ-08-06）。
- **涉及文件**：
  - 只读 `src/lib/server/db.ts`、`src/app/api/sync/route.ts`、`src/lib/__tests__/sync-conflict-409.test.ts`；
  - 只读导出 `git diff -- src/lib/server/db.ts src/app/api/sync/route.ts src/lib/__tests__/sync-conflict-409.test.ts`；
  - 产出 `docs/evidence/ict-track1-2026-11-20/codearts/T-ICT-003-pre-review.md`、`codearts/T-ICT-003-workspace-baseline.txt`、`codearts/T-ICT-003-pre-review.diff`。
- **前置依赖**：无；必须在任何源码改写之前完成。
- **验收标准**：
  1. 三个文件每个 hunk 均有一行判定（保留/修正/否决）+ 理由 + 对应设计决策（D-1~D-11）。
  2. 明确标注「来源：上一轮 Codex 未提交修改，非本轮码道产出」，并附 `git status` 与 `git diff --stat` 只读截图/文本。
  3. 列出本轮将改写或删除的具体行段（以当前工作区行号为准），与 T-ICT-004~019 的任务编号对应。
  4. 记录工作区基线：HEAD、`porcelain` 条目数、条目摘要 sha256；执行前后条目集合不减少。
  5. 本任务**不得**修改任何源码或测试文件。
- **证据产出**：审查表 + 差异导出 + 工作区基线；审查表须含「保留 `ConcurrentWriteError`」「修正 `dbGet(forSnapshotWrite)` 分块令牌」「否决 `overwriteOnConflict` 与 `compareSnapshot` 并存」等结论。
- **判定**：`PASS` = 三文件全部 hunk 有判定且无源码改动；`FAIL` = 存在未判定 hunk 或误改源码；`BLOCKED` 不适用；`NOT_RUN` = 未执行。
- **预估改动范围**：仅文档（0 行业务代码）。

---

## 4. 批次 1：并发契约层

**批次门禁**：见 2.3 批次 1。

### 4.1 T-ICT-004 版本令牌纯函数

- **目标**：建立唯一内部令牌口径 `VersionToken = md5(逻辑密文)`，能识别历史分块头并按序拼接，消除 `rdsGetSha`、`dbGet(_sha)`、D1 token 三套口径。
- **涉及文件**：
  - 新增 `src/lib/server/version-token.ts`；
  - 新增 `src/lib/__tests__/snapshot-version-token.test.ts`；
  - 只读 `src/lib/server/db.ts:252-303`（D1 现有 token 形态）。
- **前置依赖**：T-ICT-003 完成。
- **验收标准**：
  1. `parseChunkHeader('{"__chunks__":3}')` 返回 3；对普通密文、`{"__chunks__":0}`、带空格/额外字段的 JSON 返回 `null`。
  2. `versionToken(logical)` 对同一 `GZ1.` + Base64 文本恒等，且与 `crypto.createHash("md5")` 的 hex 完全一致（前缀统一为 `md5:`）。
  3. 分块拼接对顺序敏感：交换两块顺序后令牌不同；缺块时函数返回明确错误而不是拼接部分内容。
  4. 8MB 输入的令牌计算在 200ms 内完成（粗性能护栏，避免脆弱阈值）。
  5. 单测 0 skip，不依赖数据库。
- **证据产出**：`gate/T-ICT-004-vitest.log`（含用例清单与耗时）。
- **判定**：`PASS` = 单测全绿；`FAIL` = 任一口径不一致；`BLOCKED/NOT_RUN` 不适用。
- **预估改动范围**：新增 2 文件，M（约 120–180 行），纯函数无 I/O。

### 4.2 T-ICT-005 期望值与错误类型契约

- **目标**：用可辨识联合替代 `string | null | undefined` 三态，明确「期望不存在 / 匹配版本 / 无条件」三种写入意图，并统一冲突、缺块、通道不可用三类错误。
- **涉及文件**：
  - 新增 `src/lib/server/snapshot-types.ts`；
  - 修改 `src/lib/server/db.ts:388-393`（扩展 `ConcurrentWriteError.details`，保持旧构造签名）；
  - 新增 `src/lib/__tests__/snapshot-expectation.test.ts`。
- **前置依赖**：T-ICT-004 完成（复用 `VersionToken` 类型）。
- **验收标准**：
  1. 类型可同时被 `snapshot-store.ts` 与 `app/api/sync/route.ts` 导入，`npx tsc --noEmit` 0 错，无循环依赖。
  2. `new ConcurrentWriteError(path)` 旧调用仍编译通过；新增 `details` 含 `reason`、`currentVersion`、`currentUploadId?`。
  3. 错误对象 `JSON.stringify` 后不含快照内容、完整账号标识或连接串。
  4. `Expectation` 三态在类型层互斥：构造 `{mode:"absent", token:"x"}` 必须编译失败（用 `@ts-expect-error` 用例锁定）。
  5. 「`baseVersion === undefined`」不得被推断为 `absent`（用单测断言映射函数结果）。
- **证据产出**：`gate/T-ICT-005-tsc.log`、`gate/T-ICT-005-vitest.log`。
- **判定**：`PASS` = tsc 0 错且单测全绿；`FAIL` = 类型逃逸或语义混淆仍存在；其余不适用。
- **预估改动范围**：新增 2 文件 + `db.ts` S（约 15 行）。

---

## 5. 批次 2：RDS 事务提交（E-2）

**批次门禁**：见 2.3 批次 2。本批所有集成用例必须满足：容器可用时 0 skip；容器不可用时显式 skip 并记录原因。

### 5.1 T-ICT-006 专用连接与事务外壳

- **目标**：让 RDS 快照路径能取得**专用连接**并在其中执行事务，避免 `pool.query` 每次另取连接破坏原子性。
- **涉及文件**：
  - 修改 `src/lib/server/db.ts:402-420`（`PgPool` 最小类型扩展为 `query + connect`）；
  - 新增 `src/lib/server/rds-tx.ts`（或 `db.ts` 内导出 `rdsTx`）；
  - 新增 `src/lib/__tests__/snapshot-rds-tx-shell.test.ts`。
- **前置依赖**：T-ICT-005 完成。
- **验收标准**：
  1. `rdsTx(fn)` 依次执行 `connect → BEGIN → SET LOCAL lock_timeout / statement_timeout → fn(client) → COMMIT`；异常路径必须 `ROLLBACK` 后 `release`。
  2. 连接不可用时 `release(true)`（销毁而非回池），池中不出现 `idle in transaction` 连接。
  3. 事务内调用 `rdsQuery` 会被测试检出（用池连接计数断言事务期间未额外取连接）。
  4. 事务内抛错后 `kv` 表无任何变化；重复调用不泄漏连接（连续 20 次后 `pg_stat_activity` 连接数回到基线）。
  5. 事务超时参数可被环境变量覆盖，默认 `lock_timeout=2000ms`、`statement_timeout=8000ms`。
- **证据产出**：`rds/T-ICT-006-tx-shell.json`（用例结果 + 连接数快照）。
- **判定**：`PASS` = 集成用例全绿（`environment: local-equivalent`）；`BLOCKED` = 无 `TEST_RDS_URL`（测试名含 `SKIP: TEST_RDS_URL 未提供`）；`FAIL` = 连接泄漏或事务未回滚。
- **预估改动范围**：`db.ts` M（约 50–70 行）+ 新增测试 M（约 80 行）。

### 5.2 T-ICT-007a 互斥键与事务边界

> 拆分说明见 0.A：T-ICT-007 拆为 007a~007d 四个 `###` 同级任务，代码在 `snapshot-store.ts` 同文件增量演进。

- **目标**：在专用连接上以路径级 advisory lock 互斥，并保证事务边界正确、失败整体回滚；本子任务不实现判定逻辑。
- **涉及文件**：`src/lib/server/snapshot-store.ts`（`commitSnapshot` 骨架 + 锁与边界）；新增 `src/lib/__tests__/snapshot-rds-lock-tx.test.ts`。
- **前置依赖**：T-ICT-006 完成。
- **验收标准**：
  1. 事务第一句为 `pg_advisory_xact_lock(hashtextextended($path, 0))`；PG 版本不支持时回退 `('x'||md5($path))::bit(64)::bigint`，选择逻辑集中一处并登记 `codearts/DEVIATIONS.md`。
  2. 锁键只由 `path` 决定，不含用户前缀；同 path 串行、不同 path 互不阻塞（用 `pg_locks` 与等待时长断言）。
  3. `BEGIN` 后立即取锁、`COMMIT` 为最后一句；任何异常先 `ROLLBACK` 再抛错；事务内禁止调用 `rdsQuery`（用池连接计数断言未额外取连接）。
  4. 注入 SQL 异常后主行与块行逐字节不变；连续 20 次调用后 `pg_stat_activity` 无 `idle in transaction`。
- **证据产出**：`rds/T-ICT-007a-lock-tx.json`（锁等待时长、`pg_locks` 快照、回滚前后哈希、连接数）。
- **判定**：`PASS` = 4 项通过（`environment: local-equivalent`）；`FAIL` = 未回滚或事务内二次取连接；`BLOCKED` = 无 `TEST_RDS_URL`（测试名含 `SKIP: TEST_RDS_URL 未提供`）。
- **预估改动范围**：新增 M（约 80 行）+ 测试 M（约 100 行）。

### 5.3 T-ICT-007b 单查询读取与固定判定顺序

- **目标**：一次查询取齐主行与全部块行并按 `k` 分类，实现 ①~⑤ 固定判定与幂等分支；409 载荷组装留给 007c。
- **涉及文件**：`src/lib/server/snapshot-store.ts`（`readCommitState` + `decide`）；新增 `src/lib/__tests__/snapshot-rds-decision.test.ts`。
- **前置依赖**：T-ICT-007a 完成。
- **验收标准**：
  1. 事务内只发 1 条 SELECT 同时取主行与全部 `path#p*`（语句计数断言，禁止逐块查询）。
  2. ① 主行是分块头 → 校验块数与连续性，缺块立即 `SnapshotIncompleteError`（不写、不删）。
  3. ② `expect.mode === "absent"`：主行存在**或**任一 `path#p*` 存在 → `ConcurrentWriteError(reason:"exists" | "residual-block")`。
  4. ③ **幂等判定先于基线校验**：内容与云端当前快照等价 → `kind:"idempotent"`，返回当前版本，不推进、不归档。此顺序是既有同步语义，旧基线原样重发依赖它才不会误判 409。
  5. ④ `expect.mode === "match"`：幂等未命中后，先比 `baseVersion`（若提供）与 `updatedAt`，再比令牌（若提供）与逻辑密文令牌；任一不符 → 冲突，不抛通用 `Error`。
  6. ⑤ 通过 → 先 `UPSERT` 主行，再 `DELETE` 全部旧块。
  7. 判定为纯函数（输入读取结果 + `Expectation`，输出 decision），可脱离数据库单测，覆盖 8 组判定矩阵，其中至少 2 组专测「旧基线 + 同内容」与「旧基线 + 不同内容」。
  8. 同一组幂等/旧基线用例必须在 D1 与 RDS 上各执行一次，结论分别写入证据。
- **证据产出**：`rds/T-ICT-007b-decision.json`（判定矩阵输入/输出、语句计数）。
- **判定**：`PASS` = 8 项通过；`FAIL` = 判定越序（**幂等晚于基线校验**）、发生多次查询，或旧基线同内容被误判 409；`BLOCKED` = 容器不可用。
- **预估改动范围**：新增 L（约 100–140 行）+ 测试 L（约 140 行）。

### 5.4 T-ICT-007c 409 载荷与冲突零副作用

- **目标**：冲突异常携带 `currentVersion/currentUploadId`，且冲突前后存储字节级不变。
- **涉及文件**：`src/lib/server/snapshot-store.ts`（用 007b 已读值组装 details）、`src/lib/server/snapshot-types.ts`；新增 `src/lib/__tests__/snapshot-rds-conflict-409.test.ts`。
- **前置依赖**：T-ICT-007b 完成。
- **验收标准**：
  1. `details.currentVersion` 等于当前快照 `updatedAt`；`details.currentUploadId` 取当前 payload 的 `uploadId`（不存在则不设置该字段）。
  2. 数据来自同一事务内已读值，禁止二次查询（查询计数断言）。
  3. 冲突后主行内容哈希、块行集合、版本标识与失败前逐字节一致。
  4. 冲突异常 `JSON.stringify` 后不含快照内容、完整账号标识或连接串。
  5. 同一路径连续 5 次冲突后 `pg_locks` 无残留、连接全部归还。
- **证据产出**：`rds/T-ICT-007c-conflict-409.json`（5 组冲突前后哈希对照 + 响应字段）。
- **判定**：`PASS` = 5 项通过；`FAIL` = 缺 `currentVersion`、二次查询或哈希变化；`BLOCKED` = 容器不可用。
- **预估改动范围**：`snapshot-store.ts` S（约 40 行）+ 测试 M（约 80 行）。

### 5.5 T-ICT-007d 提交路径并发自证（20 轮）

- **目标**：用锁闸门在 commit 主路径上自证「成功 1 / 409 1」，为批次 2 提供收口证据（大快照、归档、隔离由 026~030 扩展）。
- **涉及文件**：新增 `src/lib/__tests__/snapshot-rds-commit-concurrency.test.ts`（可复用 `helpers/ict-pg.ts`）。
- **前置依赖**：T-ICT-007c 完成。
- **验收标准**：
  1. 20 轮双连接（非同一 pool），第三条连接先持同键 `pg_advisory_lock`，两请求进入等待后释放以制造同瞬间竞争。
  2. 每轮成功恰 1、409 恰 1；双成功 0、双 409 0。
  3. 每轮 409 的 `currentVersion` 等于同轮成功响应的 `updatedAt`；胜出方读回内容哈希与提交内容一致。
  4. 终态主行 1 行、块行 0、无 `idle in transaction`、无锁残留。
  5. 单轮 P95 ≤ 3 秒（本地记录，标注非云端）。
- **证据产出**：`rds/T-ICT-007d-commit-concurrency.json`（逐轮状态、版本、哈希、耗时）。
- **判定**：`PASS` = 5 项通过（`environment: local-equivalent`、`cloudEquivalent:false`）；`FAIL` = 任一回合双成功或终态不符；`BLOCKED` = 容器不可用；`NOT_RUN` = 未执行。
- **预估改动范围**：测试 L（约 160 行）；**0 行业务源码**（业务代码已在 007a~007c 交付）。

### 5.6 T-ICT-008 首次创建竞争与残留分块

- **目标**：让「主行缺失但存在块行」被判定为已占用，首次创建竞争只产生一个成功者，失败方不留任何行。
- **涉及文件**：`src/lib/server/snapshot-store.ts`；新增 `src/lib/__tests__/snapshot-rds-absent.test.ts`。
- **前置依赖**：T-ICT-007c 完成。
- **验收标准**：
  1. 手工构造「仅 `#p0..#p2`、无主行」的路径 → `expect=absent` 写入返回冲突，块行数量与内容哈希不变。
  2. 主行存在、块行缺失的分块形态 → 读取/写入均报 `SnapshotIncompleteError`，不得按首次创建处理。
  3. 两路 `absent` 并发 → 成功 1、冲突 1；终态该路径只有一份内容，无重复块行。
  4. 冲突方的 409 携带胜出方 `currentVersion` 与 `currentUploadId`。
  5. 互斥失效的极端情况下，`kv.k` 主键唯一约束仍使第二路失败而非覆盖（用「先插主行再让第二路进入」的用例验证）。
- **证据产出**：`rds/T-ICT-008-absent.json`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 残留块被删除或出现双成功；`BLOCKED` = 容器不可用。
- **预估改动范围**：`snapshot-store.ts` S（约 40 行）+ 测试 M（约 120 行）。

### 5.7 T-ICT-009 幂等判定与版本推进边界

- **目标**：明确「相同内容不推进、不归档」在事务内的兜底语义，并锁定版本标识由谁生成、由谁比对。
- **涉及文件**：`src/lib/server/snapshot-store.ts`；`src/app/api/sync/route.ts`（仅约定，改动在 T-ICT-016）；新增 `src/lib/__tests__/snapshot-rds-idempotent.test.ts`。
- **前置依赖**：T-ICT-007c 完成。
- **验收标准**：
  1. 原样重复提交 → `kind:"idempotent"`，返回 `version` 等于当前版本，存储 `md5(逻辑密文)` 不变，归档数不变。
  2. `version` 由 route 在提交前生成（`max(now, previous+1ms)`），`commitSnapshot` 只负责校验与回写，不二次生成（避免双时钟）。
  3. 连续两次不同内容成功提交 → 两个 `version` 严格递增（ISO 时间字符串可直接 `Date.parse`）。
  4. 客户端把 GET 返回的 `version` 原样作为 `baseVersion` 提交 → 无并发时成功；篡改任一字符 → 409。
  5. 幂等分支不取归档、不写块行、不更新 `uploadId`。
  6. **旧基线 + 原样内容**（丢回执场景）：`baseVersion` 为已过期的 V1、内容与云端 V2 等价 → 返回 200 且 `version === V2`；存储哈希不变、归档数不变。该断言为 REQ-04-13 的核心，必须先于基线校验成立。
  7. **旧基线 + 不同内容**：`baseVersion` 为 V1、内容与云端不同 → 409，携带 `currentVersion:V2`；云端内容与归档均不变。
  8. 上述 6、7 两组用例由同一份用例定义驱动 D1 与 RDS 各执行一次，结论分别归档（`rds/T-ICT-009-idempotent.json` 记录两通道结果与 `environment` 字段）。
- **证据产出**：`rds/T-ICT-009-idempotent.json`。
- **判定**：`PASS` = 8 项通过（含 D1/RDS 双通道）；`FAIL` = 幂等产生新版本/新归档，或旧基线原样重发被误判 409；`BLOCKED` = 容器不可用（此时双通道结论均记 `BLOCKED`，不得只报 RDS）。
- **预估改动范围**：`snapshot-store.ts` S（约 30 行）+ 测试 M（约 80 行）。

### 5.8 T-ICT-010 事务失败映射与重试边界

- **目标**：把锁超时、序列化失败、连接中断映射为稳定的业务错误，避免 route 层散落 SQLSTATE 判断。
- **涉及文件**：`src/lib/server/snapshot-store.ts`、`src/lib/server/snapshot-types.ts`；新增 `src/lib/__tests__/snapshot-rds-failures.test.ts`。
- **前置依赖**：T-ICT-007c 完成。
- **验收标准**：
  1. 锁超时（SQLSTATE `55P03`）→ `ConcurrentWriteError(reason:"lock-timeout")`，存储不变，route 可映射 409。
  2. 序列化失败（`40001`/`40P01`）→ 自动重试 1 次；仍失败 → 冲突错误，不无限重试。
  3. 连接被杀（`pg_terminate_backend`）→ `DbUnavailableError`，route 映射 503 `DB_UNAVAILABLE`；重连后数据一致。
  4. 错误消息不得包含 SQL 参数、连接串或快照内容；只允许固定语句头部。
  5. 每个错误路径都必须 `ROLLBACK`（用连接状态断言无 `idle in transaction`）。
- **证据产出**：`rds/T-ICT-010-failures.json`（四类注入的 SQLSTATE、映射结果、终态哈希）。
- **判定**：`PASS` = 四类映射正确；`FAIL` = 出现未回滚或错误映射为 200；`BLOCKED` = 容器不可用。
- **预估改动范围**：M（约 60 行）+ 测试 M（约 120 行）。

### 5.9 T-ICT-011 归档服务（仅创建 + 滚动裁剪）

- **目标**：把「先查后写」的归档改为「仅创建」语义，消除 TOCTOU，并保证同时间戳不重复、总数 10 份、失败不阻断主写入。
- **涉及文件**：
  - 新增 `src/lib/server/snapshot-archive.ts`；
  - 复用 `dbPutIfAbsent`/`dbList`/`dbDelete`（`db.ts` 既有导出）；
  - 新增 `src/lib/__tests__/snapshot-archive.test.ts`。
- **前置依赖**：T-ICT-007c 完成（`previous` 来源确定）。
- **验收标准**：
  1. 归档写入走「仅创建」：同 `versions/<uid>/<ts>.json` 已存在时返回 `exists`，内容哈希不变（不覆盖）。
  2. 连续 12 次推进 → 归档 10 份，最旧两份被删除；顺序正确。
  3. 归档失败（注入写失败）→ 返回 `failed`，主写入保持成功，事件 `sync.archive_failed` 可检索。
  4. 归档内容为密文；读回需解密，日志与证据不含明文。
  5. 归档路径与快照路径同表不同前缀，`dbList('versions/<uid>')` 能列出且不混入其他用户。
  6. 归档不占用提交事务连接、不加 advisory lock，不与主事务交叉持锁。
- **证据产出**：`rds/T-ICT-011-archive.json`、`rds/T-ICT-011-archive-events.log`。
- **判定**：`PASS` = 6 项通过；`FAIL` = 覆盖同时间戳或归档失败导致主写入回滚；`BLOCKED` = 容器不可用。
- **预估改动范围**：新增 M（约 100 行）+ 测试 M（约 120 行）。

---

## 6. 批次 3：历史分块兼容与写入自愈（E-3）

**批次门禁**：见 2.3 批次 3。本批必须同时证明「读得回」「缺块报错」「写一次即迁移」「旧版本可读新数据」。

### 6.1 T-ICT-012 历史分块快照读取

- **目标**：识别主行 `{"__chunks__":N}`，按 `#p0..#p(N-1)` 顺序拼接为逻辑密文，返回内容、令牌、版本与回执。
- **涉及文件**：`src/lib/server/snapshot-store.ts`（新增 `readSnapshot`）；新增 `src/lib/__tests__/snapshot-rds-read.test.ts`。
- **前置依赖**：T-ICT-007b 完成（复用事务读与令牌）。
- **验收标准**：
  1. 3 块快照读回内容与写入前逐字节一致（比较 SHA-256，不只比较长度）。
  2. 缺中间块（删除 `#p1`）→ 抛 `SnapshotIncompleteError`，携带 `declaredChunks=3`、`foundChunks=2`，不返回部分内容。
  3. 块索引空洞/重复/非法后缀 → 视为不完整，不猜测顺序。
  4. 主行缺失但存在 `#p*` → 抛 `SnapshotIncompleteError(reason:"orphan-chunks")`，不得返回 `null`（避免把有数据误判为不存在；此细化登记 `DEVIATIONS.md`）。
  5. 单行形态读取不回归：内容、`version`、`uploadId` 与改造前一致。
  6. 令牌不出现在任何 HTTP 响应或日志中。
- **证据产出**：`rds/T-ICT-012-read.json`（三组数据的 SHA-256 对比）。
- **判定**：`PASS` = 6 项通过；`FAIL` = 返回部分内容或误判不存在；`BLOCKED` = 容器不可用。
- **预估改动范围**：M（约 100 行）+ 测试 M（约 120 行）。

### 6.2 T-ICT-013 缺块错误到 503 的映射

- **目标**：把 `SnapshotIncompleteError` 稳定映射为 503 `SNAPSHOT_INCOMPLETE`，GET 与 POST 行为一致。
- **涉及文件**：`src/app/api/sync/route.ts`（错误映射，GET 在 T-ICT-015 接入）；`snapshot-types.ts`；新增 `src/lib/__tests__/snapshot-incomplete-mapping.test.ts`。
- **前置依赖**：T-ICT-012 完成。
- **验收标准**：
  1. GET 读到缺块 → 503、`code:"SNAPSHOT_INCOMPLETE"`，响应体不含 `data` 字段（不泄露部分内容）。
  2. POST 前置读缺块 → 503，且不进入事务、不产生写入。
  3. 归档版本读取缺块 → 同样 503，不静默返回空。
  4. 错误响应仍保留 `error` 中文字段，旧客户端可读。
  5. 日志只记录路径摘要（`data/<hash8>.json`）与块数，不含内容。
- **证据产出**：`rds/T-ICT-013-incomplete.json`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 返回空/部分数据或状态码错误；`BLOCKED` = 容器不可用。
- **预估改动范围**：S（约 30 行）+ 测试 S（约 60 行）。

### 6.3 T-ICT-014 写入自愈与回退兼容

- **目标**：任何一次成功推进都把「主行 header + 块行」改写为单行密文并删除块行，无需独立迁移脚本；同时证明旧版本能读新数据。
- **涉及文件**：`src/lib/server/snapshot-store.ts`（写入路径）；新增 `src/lib/__tests__/snapshot-rds-selfheal.test.ts`；证据 `rds/T-ICT-014-selfheal.md`。
- **前置依赖**：T-ICT-012、T-ICT-013 完成。
- **验收标准**：
  1. 分块 3 块 → 一次成功推进后：主行不再匹配分块头、`#p*` 行数为 0、读回内容 SHA-256 等于写入内容。
  2. 二次推进走单行路径，事务内块行查询结果为 0，性能不劣化（记录语句数与耗时）。
  3. 回退兼容：测试内直接 `SELECT v` + `decrypt`（模拟旧版 `rdsGet`）能解出新主行；旧版写入单行后新版本可读。
  4. 自愈失败（删块失败）→ 整体回滚，形态保持原样（由 T-ICT-027 故障注入覆盖，本任务引用其结果）。
  5. 证据记录「迁移前后主行形态、块行数、内容哈希、旧版读取结果」四元组。
- **证据产出**：`rds/T-ICT-014-selfheal.md` + `rds/T-ICT-014-selfheal.json`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 迁移后残留块或旧版不可读；`BLOCKED` = 容器不可用。
- **预估改动范围**：S（约 30 行）+ 测试 M（约 100 行）。

---

## 7. 批次 4：路由接入与错误码（E-4）

**批次门禁**：见 2.3 批次 4。本批完成后 `/api/sync` 的对外契约冻结，后续只允许新增字段。

### 7.1 T-ICT-015 GET 接入 readSnapshot

- **目标**：拉取路径统一走 `readSnapshot`，保留既有字段与体积闸，新增缺块错误映射。
- **涉及文件**：`src/app/api/sync/route.ts:74-142`；新增 `src/lib/__tests__/sync-get-snapshot.test.ts`。
- **前置依赖**：T-ICT-012、T-ICT-013 完成。
- **验收标准**：
  1. `?versions=1` 行为不变（列表、降序、非法值忽略）。
  2. 主路径响应 `{data, updatedAt, version, uploadId}`，`version === updatedAt`，不再出现 `_sha`。
  3. `?v=<ts>` 读取归档；归档缺失仍返回 `{data:null}`（不改为 404）。
  4. 体积闸不变：明文分支按 UTF-8 字节计 4.2MB；gzip 分支超过 1MB 压缩且结果 ≤4.2MB；超限 413。
  5. 缺块 → 503 `SNAPSHOT_INCOMPLETE`；通道不可用 → 503 `DB_UNAVAILABLE`。
  6. 账户头不一致的 403 在 T-ICT-017 接入，本任务不改变现有 409（避免中间态断言冲突）。
- **证据产出**：`rds/T-ICT-015-get.json`、`gate/T-ICT-015-vitest.log`。
- **判定**：`PASS` = 6 项通过；`FAIL` = 字段缺失或体积闸放宽；`BLOCKED` = 容器不可用（缺块用例）；`NOT_RUN`。
- **预估改动范围**：route S（约 30 行）+ 测试 M（约 80 行）。

### 7.2 T-ICT-016 POST 接入 commitSnapshot 与 409 载荷

- **目标**：把写入路径切到事务提交，冲突响应携带 `currentVersion/currentUploadId`，成功响应携带 `archive`。
- **涉及文件**：`src/app/api/sync/route.ts:145-257`；`src/lib/server/snapshot-store.ts`；新增 `src/lib/__tests__/sync-post-conflict.test.ts`。
- **前置依赖**：T-ICT-007c、T-ICT-015 完成。
- **验收标准**：
  1. `baseVersion` 映射固定：
     - `null` → `{mode:"absent"}`；
     - ISO 字符串 → `{mode:"match", baseVersion, token: 可选}`；
     - `undefined`（旧客户端）→ `{mode:"unconditional"}`，响应与日志均不得声称该路径具备并发保护。
  2. 409 响应体固定含 `{error, conflict:true, currentVersion}`；有当前回执时含 `currentUploadId`；`currentVersion` 必须等于冲突时存储中的实际版本。
  3. 两条冲突来源（前置比对、事务内令牌）响应形态一致，差异只体现在日志 `reason`。
  4. 成功响应 `{ok:true, updatedAt, version, archive}`；`archive` 取 `archived|exists|failed`。
  5. 冲突与幂等分支均不调用归档（用 spy 断言 0 次）。
  6. 体积闸、`sanitize`（`apiKey` 清空、`folders` 截断 10000）、限流（60/分）行为不变。
  7. 401/400/413/429 语义不变。
- **证据产出**：`rds/T-ICT-016-post-409.json`（20 轮响应对）、`rds/T-ICT-016-contract.md`。
- **判定**：`PASS` = 7 项通过；`FAIL` = 409 缺 `currentVersion` 或旧客户端被误当 `absent`；`BLOCKED` = 容器不可用；`NOT_RUN`。
- **预估改动范围**：route M（约 80 行）+ 测试 M（约 140 行）。

### 7.3 T-ICT-017 跨账户隔离改为 403

- **目标**：账户头与认证账户不一致时返回 403 `ACCOUNT_MISMATCH`，与并发 409 解耦，不泄露对方数据。
- **涉及文件**：`src/app/api/sync/route.ts:78`、`:149`；新增 `src/lib/__tests__/sync-account-mismatch-403.test.ts`；修改 `src/lib/__tests__/audit-sync-stream-cap.test.ts`（既有 409 断言）。
- **前置依赖**：T-ICT-016 完成。
- **验收标准**：
  1. GET 与 POST 均返回 403、`{error, code:"ACCOUNT_MISMATCH"}`。
  2. 响应体不含对方 `userId`、快照内容、块行信息。
  3. 未认证仍 401；认证且账户一致不受影响。
  4. 既有测试中针对「账户头不一致 → 409」的断言逐条更新，不保留双重标准。
  5. 限流计数不被越权请求污染（越权请求在限流前拒绝）。
- **证据产出**：`rds/T-ICT-017-403.json`、`gate/T-ICT-017-vitest.log`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 仍返回 409 或泄露数据；`NOT_RUN`。
- **预估改动范围**：route S（2 行）+ 测试 M（约 80 行）。

### 7.4 T-ICT-018 归档结果字段与结构化事件

- **目标**：把归档结果显式回传，并统一 `sync.*` 结构化事件，满足 REQ-04-08/09/20。
- **涉及文件**：`src/app/api/sync/route.ts:45-70, 251-253`；`src/lib/server/snapshot-archive.ts`；新增 `src/lib/__tests__/sync-archive-outcome.test.ts`。
- **前置依赖**：T-ICT-011、T-ICT-016 完成。
- **验收标准**：
  1. 仅 `kind === "advanced"` 调用归档；`previous` 来自 `commitSnapshot` 返回值，不二次读存储。
  2. 响应 `archive` 与归档服务返回值一一对应；归档失败仍 200，但 `archive:"failed"`。
  3. 事件字段固定：`ev:"sync"`、`msg`（`archive_ok|archive_exists|archive_failed|conflict|idempotent|incomplete`）、`pathDigest`（路径 sha256 前 8 位）、`result`、`ms`；不含快照内容与完整 `userId`。
  4. 冲突、缺块、通道不可用各产生一条事件，可通过事件检索定位。
  5. 归档裁剪到 10 份的行为在路由层可见（连续 12 次推进后 `?versions=1` 返回 10 项）。
- **证据产出**：`rds/T-ICT-018-events.log`、`rds/T-ICT-018-archive-outcome.json`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 归档失败改变成功语义或事件含敏感信息；`BLOCKED` = 容器不可用。
- **预估改动范围**：route M（约 40 行）+ 测试 M（约 100 行）。

### 7.5 T-ICT-019 既有断言同步更新与证据口径降级

- **目标**：让既有源码匹配测试与新契约一致，并明确其「契约结构锁」定位，不作为并发正确性证据（REQ-04-19）。
- **涉及文件**：
  - `src/lib/__tests__/sync-conflict-409.test.ts`（全量重写断言）；
  - `src/lib/__tests__/audit-sync-stream-cap.test.ts:13,39-50`；
  - 视 mock 签名变化同步 `sync-gzip.test.ts`、`sync-plain-byte-cap.test.ts`；
  - 证据 `codearts/T-ICT-019-test-migration.md`。
- **前置依赖**：T-ICT-016、T-ICT-017、T-ICT-018 完成。
- **验收标准**：
  1. `sync-conflict-409.test.ts` 文件头写入「本文件为契约结构锁，不作为 REQ-04-19 并发证据；并发证据见 `docs/evidence/.../rds/T-ICT-026~031`」。
  2. 删除对 `overwriteOnConflict` 三元表达式、`rdsPut(expectSha)` 具体语句的断言；改为断言：路由调用 `commitSnapshot`、`Expectation` 映射、409 含 `currentVersion`、403 含 `ACCOUNT_MISMATCH`。
  3. 所有受影响测试 `npm test -- src/lib/__tests__/sync-conflict-409.test.ts src/lib/__tests__/audit-sync-stream-cap.test.ts` 全绿，0 skip。
  4. 新增断言：`/api/sync` 源码中不存在将 `baseVersion === undefined` 映射为 `absent` 的表达式（可用行为测试替代源码正则）。
  5. 迁移记录逐条列出「旧断言 → 新断言 → 理由」，并标注哪些断言被删除、为什么不再具有证据价值。
- **证据产出**：`codearts/T-ICT-019-test-migration.md`、`gate/T-ICT-019-vitest.log`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 仍有测试依赖已删除的源码形态；`NOT_RUN`。
- **预估改动范围**：3–5 个测试文件，M~L（约 100–160 行改写）；**0 行业务源码改动**。

---

## 8. 批次 5：客户端丢回执恢复（E-5）

**批次门禁**：见 2.3 批次 5。本批必须同时证明「命中可对齐」「不命中不覆盖他人」，且重推硬上限 1 次。

### 8.1 T-ICT-020 409 对齐一次并重推

- **目标**：当 409 的 `currentUploadId` 命中本机 `recentUploads` 时，把水位对齐到 `currentVersion` 并只重推一次；否则保持冲突态。
- **涉及文件**：
  - 新增 `src/lib/sync-receipt.ts`（纯函数判定，便于测试）；
  - 修改 `src/lib/auth-client.ts:34-61, 399-470`（409 分支）；
  - 新增 `src/lib/__tests__/sync-receipt-recovery.test.ts`。
- **前置依赖**：T-ICT-016 完成（409 字段已存在）。
- **验收标准**：
  1. 判定函数输入（409 响应体 + `recentUploads`）输出 `{realign:boolean, version?:string}`；仅当 `conflict===true`、`currentVersion` 为非空 ISO 串、`currentUploadId` 命中回执时为真。
  2. 命中 → `markSyncWatermark(currentVersion)` → 立即重推 1 次（使用新 `uploadId`、新基线、当前 `localData()`）。
  3. 重推成功 → 正常清 dirty；重推仍 409 → 进入冲突态，不再递归。
  4. 不命中 → 不请求第二次，保持 `syncStatus="conflict"`，本机数据与 dirty 标记不变。
  5. 重推次数硬上限 1（用局部 flag 或计数断言）；`uploadId` 仍满足 `/^[a-z0-9-]{8,80}$/i`。
  6. 任何路径都不得用云端数据覆盖 `localData()`。
  7. **三条保护同时成立才对齐**：① 回执命中本机 `recentUploads` 且账户与当前登录账户一致；② 当前编辑晚于该次上传（`edit < 当前 edit`），无新编辑则只对齐水位、不发第二次请求；③ 本机快照包含云端当前快照的全部文件/条目，不存在「云端有、本机缺失」的对象。
  8. 409 响应体不足以核实文件完整性时，先 `GET /api/sync` 读取云端状态逐项核对；核对不通过 → `realign=false`，保持冲突态，不重推。
  9. 重推请求发出后产生的新编辑必须保留 dirty 标记：重推成功不得无条件 `clearDirty`，须按编辑序号判断「清除的是本次上传的那批」。
- **证据产出**：`rds/T-ICT-020-receipt.json`、`gate/T-ICT-020-vitest.log`。
- **判定**：`PASS` = 9 项通过；`FAIL` = 出现无限重推、本地被覆盖，或三条保护缺一仍重推；`NOT_RUN`。
- **预估改动范围**：新增纯函数 S（约 60 行）+ `auth-client.ts` M（约 40 行）+ 测试 M（约 120 行）。

### 8.2 T-ICT-021 跨设备不覆盖他人改动的反例

- **目标**：证明「`currentUploadId` 不属于本机」时绝不冒充自我对齐，避免把他人写入当成自己的上一批。
- **涉及文件**：新增 `src/lib/__tests__/sync-receipt-cross-device.test.ts`；复用 `sync-receipt.ts`。
- **前置依赖**：T-ICT-020 完成。
- **验收标准**：
  1. `currentUploadId` 不在 `recentUploads` → `realign=false`，fetch 调用次数为 1（无重推）。
  2. `currentVersion` 为 `null`/空串/非 ISO → 不对齐。
  3. 伪造 `currentUploadId` 为 `__proto__`、超长串、空串 → 判定为不命中，且不污染 `recentUploads`。
  4. 回执列表只保留最近 8 条，命中判定使用 `edit < 当前 edit` 语义（与 `acknowledgedUpload` 一致）。
  5. 冲突态下刷新后本机改动仍可见（用 store 快照断言，不依赖浏览器）。
  6. **完整性核对分支**：当 409 缺少可核对的文件清单、或本机缺失云端条目时，必须先 `GET /api/sync` 拉取云端状态比对；比对发现云端有本机缺失对象 → 不重推、不改水位、保持冲突态。该分支须有独立用例，不得以「假设 409 足够」跳过。
- **证据产出**：`rds/T-ICT-021-cross-device.json`。
- **判定**：`PASS` = 6 项通过；`FAIL` = 不命中仍重推、本地被覆盖，或完整性核对缺失仍重推；`NOT_RUN`。
- **预估改动范围**：测试 M（约 100 行）；**0 行业务源码改动**。

---

## 9. 批次 6：D1 通道对齐与回归（E-6 / REQ-04-17）

**批次门禁**：见 2.3 批次 6。D1 凭据缺失时本批全部 `BLOCKED`，但代码改动仍必须完成并通过类型检查与 mock 单测；真实 D1 结论单独标注。

### 9.1 T-ICT-022 D1 gate 检查残留分块

- **目标**：`d1WriteSnapshot` 的 gate 条件覆盖「主行存在或任一 `#p*` 存在」，使残留块不被当作不存在。
- **涉及文件**：`src/lib/server/db.ts:270-303`；新增 `src/lib/__tests__/ict-d1-residual-chunks.test.ts`。
- **前置依赖**：T-ICT-001 完成（基线可比）。
- **验收标准**：
  1. 构造仅 `path#p1` 存在（无主行、无 `#p0`）→ `expect=absent` 写入被拒，抛 `ConcurrentWriteError`，块行内容不变。
  2. 构造主行 + `#p0..#p2` → 正常推进仍成功，布局（header + 块行）不变，旧版本仍可读。
  3. 单行小内容快车道（`content.length <= D1_CHUNK_SIZE && first === null`）行为不变。
  4. gate 行在任何失败路径都不残留（`#p-gate-*` 数量为 0）。
  5. batch 语句数量随块数线性增长，无额外语句。
- **证据产出**：`d1/T-ICT-022-d1-residual.json`。
- **判定**：`PASS` = 真实 D1 五条通过（`environment: real-d1`）；`FAIL` = 残留块被清或 gate 残留；`BLOCKED` = D1 凭据缺失（测试名含 `SKIP: D1 凭据未提供`）；`NOT_RUN`。
- **预估改动范围**：`db.ts` S（约 10–20 行）+ 测试 M（约 100 行）。

### 9.2 T-ICT-023 d1Get 缺块改为报不完整

- **目标**：移除 `d1Get` 的 `?? ""` 静默补空，缺块统一抛 `SnapshotIncompleteError`。
- **涉及文件**：`src/lib/server/db.ts:305-327`；`src/lib/__tests__/ict-d1-incomplete.test.ts`。
- **前置依赖**：T-ICT-005（错误类型）、T-ICT-022 完成。
- **验收标准**：
  1. 主行 header 声明 3 块、实际缺 `#p1` → 抛 `SnapshotIncompleteError(declaredChunks=3, foundChunks=2)`。
  2. 完整 3 块读回逐字节一致；单行内容行为不变。
  3. `d1ReadSnapshot` 的缺块错误从通用 `Error("云端快照不完整")` 收敛到同一错误类型，消息保持中文可读。
  4. 归档读取路径缺块同样报错，不返回空字符串。
- **证据产出**：`d1/T-ICT-023-d1-incomplete.json`。
- **判定**：同 T-ICT-022。
- **预估改动范围**：`db.ts` S（约 10 行）+ 测试 S（约 60 行）。

### 9.3 T-ICT-024 D1 冲突补读当前版本

- **目标**：D1 条件写失败时补读一次当前快照，把 `currentVersion/currentUploadId` 填入冲突异常，使 409 载荷与 RDS 一致。
- **涉及文件**：`src/lib/server/db.ts:270-303`；`src/lib/__tests__/ict-d1-conflict-details.test.ts`。
- **前置依赖**：T-ICT-005、T-ICT-022 完成。
- **验收标准**：
  1. 条件写失败 → `ConcurrentWriteError.details.currentVersion` 等于当前快照 `updatedAt`，`currentUploadId` 等于当前 payload 的 `uploadId`（若有）。
  2. 补读失败（注入读异常）→ 仍抛原冲突错误，`details` 为空，不把读异常冒泡成 503。
  3. 成功路径不增加额外查询（用请求计数断言）。
  4. 不修改 D1 batch 语句形态与块布局。
- **证据产出**：`d1/T-ICT-024-d1-details.json`。
- **判定**：同 T-ICT-022。
- **预估改动范围**：`db.ts` S（约 20 行）+ 测试 S（约 60 行）。

### 9.4 T-ICT-025 D1 与改造前基线逐项对比

- **目标**：用 T-ICT-001 的同一脚本、同一隔离键策略复测，逐项对比并发、归档、幂等、普通写入，证明「不退化」而非「能跑通」。
- **涉及文件**：`scripts/ict-baseline-d1.mjs`（新增 `--compare`）；证据 `d1/T-ICT-025-d1-regression.json`、`d1/T-ICT-025-diff.md`。
- **前置依赖**：T-ICT-001、T-ICT-022、T-ICT-023、T-ICT-024 完成。
- **验收标准**：
  1. 每个基线 case 输出 `same|diff|not-run` 三态之一，并附改造后实测值。
  2. 允许的预期差异仅限：409 响应新增 `currentVersion/currentUploadId`、缺块错误类型变化；其余差异一律判定为非预期。
  3. 归档条目数与幂等行为必须完全一致（逐项相等）。
  4. 非预期差异必须逐条给出根因与处置；无法解释即 `FAIL`，不得改基线迁就实现。
  5. 隔离键清理完成，D1 无残留 `ict-baseline-*` / `ict-verify-*` 键。
- **证据产出**：对比 JSON + 人读 diff 表。
- **判定**：`PASS` = 无非预期差异；`FAIL` = 存在未解释退化；`BLOCKED` = D1 凭据缺失（注明「无法证明不退化」）；`NOT_RUN`。
- **预估改动范围**：脚本 S（约 80 行）+ 证据 2 文件；**0 行业务源码改动**。

---

## 10. 批次 7：行为级集成证据（E-2 / E-3 / E-4 载体）

**批次门禁**：见 2.3 批次 7。本批所有用例必须真实建立连接、真实执行写入、断言存储终态；**禁止**以源码文本匹配、mock 通道或「接口返回 200」替代并发结论（REQ-04-19）。

### 10.1 T-ICT-026 同版本并发 20 轮

- **目标**：用两个独立 `pg.Client` 与锁闸门稳定复现竞争，证明「成功 1、409 1」在 20 轮内恒成立。
- **涉及文件**：新增 `src/lib/__tests__/snapshot-rds-concurrency.test.ts`；工具函数可放 `src/lib/__tests__/helpers/ict-pg.ts`。
- **前置依赖**：T-ICT-002、T-ICT-007d、T-ICT-008 完成。
- **验收标准**：
  1. 每轮两个独立连接（非同一 pool），`Promise.allSettled` 同时发起；第三条连接先持 `pg_advisory_lock(同键)`，两请求进入等待后释放，制造同一瞬间争锁。
  2. 20 轮统计：成功轮次恰为 20，双成功轮次为 0，双 409 轮次为 0。
  3. 每轮 409 的 `currentVersion` 等于同轮成功响应的 `updatedAt`；`currentUploadId` 等于成功方提交的回执。
  4. 每轮终态：主行 1 行、`#p*` 0 行、归档 1 份、内容 SHA-256 等于成功方提交内容。
  5. 20 轮结束后无 `idle in transaction` 连接，锁已释放（`pg_locks` 无残留）。
  6. 单轮耗时记录 P95，冲突判定不超过 3 秒（DFX 4.1 第 4 条）。
- **证据产出**：`rds/T-ICT-026-concurrency.json`（逐轮状态、版本、哈希、耗时）。
- **判定**：`PASS` = 20 轮全部满足（`environment: local-equivalent`，`cloudEquivalent:false`）；`FAIL` = 任一回合双成功或终态不符；`BLOCKED` = 容器不可用（`SKIP: TEST_RDS_URL 未提供`）；`NOT_RUN`。
- **预估改动范围**：测试 L（约 180 行）+ 可选 helper S。

### 10.2 T-ICT-027 故障注入（清理/主行/锁/连接）

- **目标**：用测试库触发器与连接终止注入四类故障，证明「失败即无副作用」，且不修改业务源码、不引入生产后门（D-9）。
- **涉及文件**：新增 `src/lib/__tests__/snapshot-rds-fault-injection.test.ts`。
- **前置依赖**：T-ICT-007a、T-ICT-008、T-ICT-010 完成。
- **验收标准**：
  1. **清理失败**：`BEFORE DELETE ON kv` 触发器对 `data/ict-fail-cleanup%` 抛错 → 写入失败；主行仍为旧值、块行仍在、归档未新增；错误可映射为 503/409 中已定义的一类。
  2. **主行失败**：`BEFORE INSERT OR UPDATE ON kv` 触发器对 `data/ict-fail-main%` 抛错 → 块行未被删除、主行未变。
  3. **锁超时**：`SET LOCAL lock_timeout=1` + 第三条连接持锁 → 409（`reason:"lock-timeout"`），存储不变。
  4. **连接中断**：`pg_terminate_backend` 杀掉事务连接 → 503 `DB_UNAVAILABLE`；重连后读回与写入前一致。
  5. 每个用例结束后删除触发器（`finally`），测试库无残留对象；连续执行两次结果一致（可重复）。
  6. 四类用例均断言「无部分提交」：主行与块行的组合状态只允许全旧或全新。
- **证据产出**：`rds/T-ICT-027-fault-injection.json`（每类 SQLSTATE、映射结果、终态哈希）。
- **判定**：`PASS` = 四类全部满足；`FAIL` = 出现部分提交或错误被吞；`BLOCKED` = 容器不可用；`NOT_RUN`。
- **预估改动范围**：测试 L（约 220 行）；**0 行业务源码改动**。

### 10.3 T-ICT-028 历史分块与大快照并发

- **目标**：覆盖 3 块历史快照、缺块、残留块、自愈，以及 >1MB 快照的双路并发一致性（REQ-04-06/16）。
- **涉及文件**：新增 `src/lib/__tests__/snapshot-rds-chunks.test.ts`。
- **前置依赖**：T-ICT-012、T-ICT-014、T-ICT-026 完成。
- **验收标准**：
  1. 手工插入主行 `{"__chunks__":3}` 与 `#p0..#p2`（真实密文三段切分）→ 读回 SHA-256 与原始一致。
  2. 删除 `#p1` → 读取 503 `SNAPSHOT_INCOMPLETE`，POST 不写入。
  3. 仅块行无主行 → `absent` 写冲突，块行保留。
  4. `match` 写成功 → 主行变单行、块行为 0、内容哈希匹配。
  5. 构造解压后 >1MB 的明文快照 → 双路并发成功 1/冲突 1；胜出方完整读回、哈希匹配。
  6. 大快照提交与读回耗时各不超过 6 秒（本地记录，标注非云端）。
- **证据产出**：`rds/T-ICT-028-chunks.json`。
- **判定**：`PASS` = 6 项通过；`FAIL` = 缺块返回部分内容或大快照双成功；`BLOCKED` = 容器不可用。
- **预估改动范围**：测试 L（约 180 行）。

### 10.4 T-ICT-029 归档 12 次、幂等与版本单调

- **目标**：验证归档滚动 10 份、同时间戳不重复、同内容不推进、连续成功版本严格递增。
- **涉及文件**：新增 `src/lib/__tests__/snapshot-rds-archive.test.ts`。
- **前置依赖**：T-ICT-009、T-ICT-011、T-ICT-016、T-ICT-018 完成。
- **验收标准**：
  1. 连续 12 次不同内容推进 → 归档 10 份，最旧两份删除，顺序正确。
  2. 重复写同一 `updatedAt`（测试直接调用归档服务）→ 归档数不增，内容不覆盖。
  3. 原样重复提交 → 版本不变、存储哈希不变、归档不变。
  4. 两次成功提交 → 两个 `version` 可被 `Date.parse`，且严格递增。
  5. 归档读取（`?v=<ts>`）内容等于被替换版本；归档密文可解密。
- **证据产出**：`rds/T-ICT-029-archive.json`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 归档超 10 份或重复覆盖；`BLOCKED` = 容器不可用。
- **预估改动范围**：测试 M（约 140 行）。

### 10.5 T-ICT-030 跨账户隔离与非快照回归

- **目标**：证明跨账户 403 不泄露数据，且非快照四原语语义不变（REQ-04-15/18）。
- **涉及文件**：新增 `src/lib/__tests__/ict-account-isolation.test.ts`、`src/lib/__tests__/ict-nonsnapshot-regression.test.ts`。
- **前置依赖**：T-ICT-017 完成；T-ICT-002（PG 非快照回归可选择真实 PG 或既有 mock 通道）。
- **验收标准**：
  1. A 凭据请求 B 路径 → 403 `ACCOUNT_MISMATCH`；响应体不含 B 的 `userId`、`data`、`updatedAt`。
  2. 同一账户正常请求不受影响。
  3. 非快照路径：`dbGet`、`dbPut`、`dbPutIfAbsent`、`dbDelete`、`dbList` 在 RDS 上行为与改造前一致（返回值、覆盖语义、存在性语义）。
  4. 非快照写入不产生 `#p*` 块行、不产生归档、不触发 advisory lock（用 `pg_locks` 断言）。
  5. 删除目录语义不变（前缀删除只影响该目录）。
- **证据产出**：`rds/T-ICT-030-isolation.json`、`rds/T-ICT-030-nonsnapshot.json`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 泄露数据或非快照语义变化；`BLOCKED` = 容器/凭据不可用。
- **预估改动范围**：测试 L（约 160 行）。

### 10.6 T-ICT-031 验证报告脚本与四态映射

- **目标**：把上述集成用例包装为可重复执行的报告脚本，输出机读 JSON 与明确退出码，作为 R04 证据附件。
- **涉及文件**：新增 `scripts/verify-snapshot-rds.mjs`；证据 `rds/T-ICT-031-report.json`、`rds/T-ICT-031-run.log`。
- **前置依赖**：T-ICT-026~030 完成。
- **验收标准**：
  1. 脚本可 `--reuse`（复用已启动容器）或 `--start`（自启临时容器）；结束后按参数决定是否 `stop`。
  2. 执行指定 vitest 文件并解析 JSON reporter，输出 `{total, pass, fail, skip, skipReasons, env:{kind, cloudEquivalent}, startedAt, durationMs}`。
  3. 退出码：`0` = 全通过且 `skip=0`；`1` = 存在失败；`2` = 存在 skip 但无失败（**不得**为 0，防止静默通过）。
  4. `env.kind` 只能是 `local-container|huawei-rds|none`；`local-container` 时 `cloudEquivalent:false`。
  5. 报告不含连接串、密码、快照内容；只记录容器名、镜像、端口。
  6. 重复执行两次，pass/fail/skip 计数一致（除耗时）。
- **证据产出**：`rds/T-ICT-031-report.json` + `rds/T-ICT-031-run.log`。
- **判定**：`PASS` = 6 项通过；`FAIL` = 退出码语义错误或报告含凭据；`BLOCKED` = 容器不可用（`kind:"none"`，退出码 2）；`NOT_RUN`。
- **预估改动范围**：脚本 L（约 180 行）；**0 行业务源码改动**。

---

## 11. 批次 8：交付物与展示（E-7~E-11）

**批次门禁**：见 2.3 批次 8。本批与代码批次并行，不阻塞 RDS 改造；但 `T-ICT-032` 依赖 T-ICT-016 的 `version` 语义已定。

### 11.1 T-ICT-032 页脚只读运行标识

- **目标**：在在线入口展示与镜像一致的运行标识，与 `/api/health` 的 `build` 同源（REQ-05-04）。
- **涉及文件**：
  - 修改 `src/app/layout.tsx`（服务端调用 `buildSha()`，作为 prop 传给 `AppShell`）；
  - 修改 `src/components/app-shell.tsx`（`AppShell` 新增可选 `build` prop，在 `<aside>` 底部、导航之后渲染）；
  - 新增 `src/components/build-badge.tsx`（纯展示，无业务逻辑）；
  - 新增 `src/lib/__tests__/build-badge.test.ts`（用 `react-dom/server` 的 `renderToStaticMarkup`，不引入 jsdom）。
- **前置依赖**：无（可与批次 2~6 并行）。
- **验收标准**：
  1. `buildSha()` 在 `deploy-env.ts` 中被 `server-only` 保护，客户端组件**不得**直接导入；只能通过 `layout.tsx` 传 prop。
  2. 页面渲染的标识等于 `buildSha()` 返回值（本地注入 `APP_BUILD_SHA=ict-verify-1234567` 时为前 7 位）。
  3. `APP_BUILD_SHA` 缺省时显示 `local`，不报错、不空白。
  4. 标识只读、不可点击、不触发请求；不新增鉴权面与数据读取。
  5. 桌面与移动布局均不溢出（截图证据，不改业务交互）。
- **证据产出**：`gate/T-ICT-032-footer.md`、`gate/T-ICT-032-footer.png`、`gate/T-ICT-032-vitest.log`。
- **判定**：`PASS` = 5 项通过（组件级本地）；`FAIL` = 标识与 health 不同源或客户端报错；`BLOCKED` = 无（云端展示在 T-ICT-045 判定）；`NOT_RUN`。
- **预估改动范围**：新增 2 文件 + 修改 2 文件，M（约 60 行）+ 测试 S（约 40 行）。

### 11.2 T-ICT-033 参赛快照冻结脚本

- **目标**：以只读方式生成参赛快照清单、摘要、密钥扫描与重建说明，满足 R01 且绝不触碰 507 项变更（REQ-01-02~06）。
- **涉及文件**：新增 `scripts/freeze-ict-snapshot.mjs`；证据 `gate/T-ICT-033-manifest.json`、`gate/T-ICT-033-SOURCES.sha256`、`gate/T-ICT-033-REBUILD.md`、`gate/T-ICT-033-EXCLUDED.md`。
- **前置依赖**：T-ICT-003（工作区基线）完成。
- **验收标准**：
  1. 输入为 `git ls-files -co --exclude-standard`；排除 `node_modules/`、`.next/`、`.git/`、`coverage/`、`dist/`、`.turbo/`、`.env*`、`*.pem`、`*.key`、`*.log`、`*.tmp`、`*.tsbuildinfo`、单文件 >20MB 的非证据文件。
  2. `--dry-run` 只打印统计（文件数、总字节、排除项计数），不写任何文件；正式运行才写 `gate/`。
  3. 密钥扫描：命中 `.env` 键名、连接串、`Bearer`、`sk-`、AK/SK 形态 → 退出码 4，列出路径（不打印值），阻止生成。
  4. 输出 `manifest.json` 含 `fileCount/totalBytes/perFile.sha256/branch/commit/generatedAt/command`；`SOURCES.sha256` 为清单摘要。
  5. 执行前后 `git status --porcelain` 的条目集合不减少；脚本内不调用 `clean/checkout/reset/stash/add/commit`（静态扫描脚本源码断言）。
  6. `T-ICT-033-REBUILD.md` 给出四步命令与预期退出码：`npm ci --legacy-peer-deps`、`npx tsc --noEmit`、`npm test --`、`npm run build -- --webpack`（构建脚本为 `next build`，必须显式传 `--webpack`）。
- **证据产出**：`gate/T-ICT-033-manifest.json`、`gate/T-ICT-033-SOURCES.sha256`、`gate/T-ICT-033-REBUILD.md`、`gate/T-ICT-033-EXCLUDED.md`、`codearts/T-ICT-033-freeze.log`。
- **判定**：`PASS` = 6 项通过；`FAIL` = 扫描命中未阻断或工作区被改；`BLOCKED` = 无（若 git 不可用则 `NOT_RUN`）；`NOT_RUN`。
- **预估改动范围**：脚本 L（约 260 行）；**0 行业务源码改动**。

### 11.3 T-ICT-034 证据目录骨架与模板

- **目标**：建立固定 7 类证据子目录、七字段模板与总索引，作为 R08 的可复核入口（v1.1 由 13 类收敛为 7 类，见 16 章）。
- **涉及文件**：`docs/evidence/ict-track1-2026-11-20/` 下 `INDEX.md`、`EVIDENCE-TEMPLATE.md`，以及 `baseline/`、`pg-local/`、`rds/`、`d1/`、`gate/`、`cloud/`、`codearts/` 七个目录（各放一个 `.gitkeep`）。
- **前置依赖**：无（与代码批次并行）。
- **验收标准**：
  1. 7 类目录全部存在，缺一即 `FAIL`（REQ-08-01）；不得额外创建 `sync/`、`build/`、`deploy/` 等 v1.0 旧目录。
  2. 模板七字段齐全：编号、日期、环境、步骤、预期、实际、证据路径、负责人；状态枚举为四态。
  3. `INDEX.md` 含条目表（编号/条目/状态/证据路径/负责人/日期）与「不得用作云端证据」单列小节；另设「待补与失败登记」区，等价承接 v1.0 的 `pending/`。
  4. `codearts/` 内单列「上一轮 Codex 修改（非本轮码道产出）」；历史原件缺失说明落在 `cloud/T-ICT-047-ORIGINALS-MISSING.md`，不再单建 `history/`。
  5. 失败与未执行条目在 `INDEX.md` 保留登记位，不预填成功结论。
- **证据产出**：`gate/INDEX.md`、`gate/EVIDENCE-TEMPLATE.md` + 7 个子目录。
- **判定**：`PASS` = 5 项通过；`FAIL` = 类别缺失、出现旧目录或模板缺字段；`NOT_RUN`。
- **预估改动范围**：新增 9 个文件/目录，M（约 80 行文档）。

### 11.4 T-ICT-035 量化评测模板（P1）

- **目标**：先落固定任务、指标定义、样本表与结论约束，使 R07 在样本到位后可直接执行。
- **涉及文件**：`docs/evidence/ict-track1-2026-11-20/gate/T-ICT-035-TASK.md`、`gate/T-ICT-035-METRICS.md`、`gate/T-ICT-035-SAMPLES.csv`、`gate/T-ICT-035-CONCLUSION.md`。
- **前置依赖**：无。
- **验收标准**：
  1. `TASK.md` 固定同一任务描述、同一输入材料地址、同一评判口径，两侧一致。
  2. `METRICS.md` 定义四项指标（完成率、到「可执行且已保存计划」的耗时、操作次数、约束满足项数/总数）及测量方法。
  3. `SAMPLES.csv` 含交叉顺序列（AB/BA）、失败原因列、样本特征列；空表预置表头。
  4. `CONCLUSION.md` 只有规则与回链格式，不写任何结论。
  5. 全部文件标注 `NOT_RUN` 与计划执行时点。
- **证据产出**：`gate/T-ICT-035-TASK.md`、`gate/T-ICT-035-METRICS.md`、`gate/T-ICT-035-SAMPLES.csv`、`gate/T-ICT-035-CONCLUSION.md`。
- **判定**：`PASS` = 5 项通过；`FAIL` = 出现预设结论或指标缺定义；`NOT_RUN`（内容本身为模板）。
- **预估改动范围**：新增 4 文件，M（约 100 行文档）。

### 11.5 T-ICT-036 演示脚本与证据采集点

- **目标**：把 R06 七步主线与异常路径写成可执行脚本，标注每步「写入前/写入后/界面状态」三元组采集点，供录屏时直接照做。
- **涉及文件**：`docs/evidence/ict-track1-2026-11-20/gate/T-ICT-036-SCRIPT.md`、`gate/T-ICT-036-CHECKLIST.md`。
- **前置依赖**：无（录屏执行受 MaaS 阻塞）。
- **验收标准**：
  1. 七步齐全：目标澄清 → 计划生成 → 首日学习与验收 → 提出收缩 → 差异查看与批准 → 笔记 → 复习；每步含操作、预期、采集点、失败判定。
  2. 异常路径单列：拒绝审批（断言无写入无归档）、生成中刷新（任务恢复）、写入失败（草稿保留）、他端改目标后审批（拒绝覆盖）。
  3. 录屏分段命名与步骤号对齐（`gate/T-ICT-036-step-01.mp4` 起）。
  4. 明确 MaaS 未配置时的替代口径：custom 通道验证业务链路，标注「不等同 MaaS」，R06 状态 `BLOCKED`。
  5. 提供 8 分钟与 5 分钟两套时长控制。
- **证据产出**：`gate/T-ICT-036-SCRIPT.md`、`gate/T-ICT-036-CHECKLIST.md`；录屏与状态证据待执行后补入。
- **判定**：`PASS` = 5 项通过；`FAIL` = 脚本无法按步执行或缺少断言；`NOT_RUN` = 录屏未执行（脚本任务本身可 PASS）。
- **预估改动范围**：新增 2 文件，M（约 120 行文档）。

---

## 12. 批次 9：收尾门禁与验收交付（E-12）

**批次门禁**：见 2.3 批次 9。本批只做验证与文档，不再改业务逻辑；若门禁失败，回到对应任务修复后重跑本批。

### 12.1 T-ICT-037 类型检查门禁

- **目标**：证明全仓 TypeScript 在改造后 0 错。
- **涉及文件**：无源码改动；证据 `gate/T-ICT-037-tsc.log`、`gate/T-ICT-037-exitcode.txt`。
- **前置依赖**：T-ICT-004~036 中本轮执行部分完成。
- **验收标准**：
  1. `npx tsc --noEmit` 退出码 0。
  2. 日志保留完整输出（含警告）；若有既有错误，逐条列明归属（本轮引入 / 既有），本轮引入的必须为 0。
  3. 记录 Node 版本、tsc 版本、执行时间与耗时。
- **证据产出**：日志 + 退出码 + 环境摘要。
- **判定**：`PASS` = 退出码 0；`FAIL` = 有本轮引入错误；`BLOCKED` 不适用；`NOT_RUN`。
- **预估改动范围**：0 行代码。

### 12.2 T-ICT-038 全量单元/集成测试门禁

- **目标**：跑通全量 vitest，并区分 passed/failed/skipped，skip 必须可解释。
- **涉及文件**：无源码改动；证据 `gate/T-ICT-038-vitest.log`、`gate/T-ICT-038-summary.json`。
- **前置依赖**：T-ICT-037 通过。
- **验收标准**：
  1. `npm test --`（即 `vitest run` 全量）完成，记录总数、通过、失败、跳过。
  2. 跳过项逐条列出原因（`TEST_RDS_URL 未提供`、`D1 凭据未提供` 等），并与「已知基线」比对；新增未知 skip 视为 `FAIL`。
  3. 本轮新增测试文件全部被收集（数量与 `src/lib/__tests__/snapshot-*.test.ts`、`sync-receipt-*.test.ts`、`ict-*.test.ts` 清单一致）。
  4. 若容器可用，集成用例不得以 skip 通过；skip>0 时 `T-ICT-031` 报告退出码必须为 2。
- **证据产出**：日志 + JSON 摘要。
- **判定**：`PASS` = 0 失败且 skip 全部有已知原因；`FAIL` = 失败或未知 skip；`BLOCKED` 不适用（容器缺失只影响集成子集，不阻断全量）；`NOT_RUN`。
- **预估改动范围**：0 行代码。

### 12.3 T-ICT-039 生产构建门禁

- **目标**：按本机既有构建约束完成构建，记录耗时与产物标识。
- **涉及文件**：无源码改动；证据 `gate/T-ICT-039-build.log`、`gate/T-ICT-039-summary.md`。
- **前置依赖**：T-ICT-038 通过。
- **验收标准**：
  1. 执行 `npm run build -- --webpack`（等价 `npx next build --webpack`；依据 `docs/CODEARTS-PRACTICE.md:41` 的本机构建约束，不是默认 Turbopack）。
  2. 退出码 0；记录耗时、路由清单、警告。
  3. 若使用 `APP_BUILD_SHA` 注入构建，记录注入值与产物中的运行标识；未注入则记为 `local`。
  4. 不得以「构建成功」替代云端部署验收（R05 仍为 `BLOCKED`）。
- **证据产出**：构建日志 + 摘要。
- **判定**：`PASS` = 退出码 0；`FAIL` = 构建失败；`BLOCKED` 不适用；`NOT_RUN`。
- **预估改动范围**：0 行代码。

### 12.4 T-ICT-040 INDEX 回填与 R00–R08 映射表

- **目标**：把 1–9 批的实际结果回填到证据索引，形成「需求 → 任务 → 证据 → 状态」可追溯表，并保留失败与未执行项。
- **涉及文件**：`docs/evidence/ict-track1-2026-11-20/gate/INDEX.md`、`gate/T-ICT-040-R00-R08-MATRIX.md`；校验脚本可新增 `scripts/verify-ict-evidence.mjs`（可选）。
- **前置依赖**：T-ICT-001~041 中本轮执行部分完成。
- **验收标准**：
  1. INDEX 每条含编号、条目、状态（四态）、证据路径、负责人、日期；路径必须真实存在。
  2. R00–R08 映射表每行含：需求条目 → 任务编号 → 证据路径 → 本轮状态 → 未通过原因/阻塞项。
  3. 本地等价、真实 D1、华为云三档分列；`INDEX.md` 单列「不得用作云端证据」小节，列出所有 `local-equivalent` 条目。
  4. 失败、`BLOCKED`、`NOT_RUN` 条目全部保留，且写明原因与解除条件。
  5. 上一轮 Codex 修改在 `codearts/` 中独立标注，不进入本轮码道成果计数。
  6. 若启用校验脚本：路径不存在、状态不在四态、字段缺失 → 退出码 1。
- **证据产出**：INDEX.md + 映射表（+ 可选校验报告）。
- **判定**：`PASS` = 6 项通过；`FAIL` = 路径失效、状态非法或丢失失败项；`NOT_RUN`。
- **预估改动范围**：文档 M（约 150 行）+ 可选脚本 M。

### 12.5 T-ICT-041 本地预览与用户验收清单

- **目标**：按 `AGENTS.md` 的交付约定，提供可访问的本地预览与可独立执行的验收清单，明确区分「本地预览 / 腾讯云线上 / 华为云待部署」。
- **涉及文件**：`docs/evidence/ict-track1-2026-11-20/gate/T-ICT-041-ACCEPTANCE-LOCAL.md`；必要时新增 `docs/evidence/ict-track1-2026-11-20/gate/T-ICT-041-PREVIEW.md`。
- **前置依赖**：T-ICT-037、038、039 通过；T-ICT-040 完成。
- **验收标准**：
  1. 起点命令明确（如 `npm run dev` 或 `npm run start`），给出 `http://localhost:<port>`；注明端口与启动前提。
  2. 清单逐项含：操作步骤、预期结果、判定口径、对应证据编号；至少覆盖页脚标识、并发冲突提示、冲突后本机改动保留、缺块提示、旧客户端仍可写。
  3. 明确声明：本地预览**不是** `http://192.144.181.171` 线上交付，也**不是**华为云 HTTPS 入口；云端条目状态仍为 `BLOCKED`。
  4. 明确声明：自动化门禁通过 ≠ 用户验收通过；需用户按清单操作并签字/回复确认。
  5. 提供「未验证项」单列（MaaS 真实调用、DCS 跨进程、SWR/ECS/CCE 部署、回退、公网入口）。
- **证据产出**：本地预览说明 + 验收清单 + 用户确认记录位。
- **判定**：`PASS` = 5 项通过且用户完成确认；`FAIL` = 清单不可独立执行或混淆环境；`BLOCKED` 不适用；`NOT_RUN` = 未交付。
- **预估改动范围**：文档 M（约 120 行）。

---

## 13. 阻塞项 B-1~B-10（单列，本轮不执行云端动作）

> 口径：阻塞项本身不产生 `PASS`。每个条目只登记「事实、解除条件、替代工作、证据标注」，解除后必须重新执行并更新状态（spec 8.1 第 3 条）。design 2.11.2 未列 B-6，本表按 spec 第 8 章补齐为 10 项。

### 13.0 四栏汇总（v1.1 新增）

「阻塞期间可完成」与「不可完成」互斥；「替代证据标注」中的结论只能标 `local-equivalent` / `local` / `NOT_RUN`，不得升格为 `PASS`；「解除后命令」的可用性按标注核对，未标注 `[脚本已存在]` 的一律视为尚未可执行。

| 编号/任务 | 阻塞期间可完成 | 不可完成 | 替代证据标注 | 解除后命令 |
| --- | --- | --- | --- | --- |
| B-1 / 042 | T-ICT-002 容器基座 + 006~014、026~031 全套本地等价；重跑清单 | 真实 RDS 连接、云端持久化/并发/归档、`environment: huawei` 任何结论 | `cloud/T-ICT-042-RDS-BLOCKED.md`；引用 `rds/*` 时必须写 `environment: local-equivalent`，禁止「华为云 RDS 已验证」 | `export TEST_RDS_URL="$DATABASE_URL"; node scripts/verify-snapshot-rds.mjs --env huawei-rds --reuse --report` `[脚本由 031 提供]` |
| B-2 / 043 | 本地 Redis 容器语义验证（Docker 可用时）、两进程读取与过期复查脚本 | DCS 跨进程读取、TTL 过期实测、`environment: huawei` 结论 | `cloud/T-ICT-043-DCS-BLOCKED.md` 附本地等价摘要，逐条注明「不等同华为云 DCS」 | `export REDIS_URL=<连接串>; node scripts/verify-dcs-cross-process.mjs` `[脚本待新增]` |
| B-3 / 044 | custom 通道业务链路、T-ICT-036 演示脚本、采集字段格式 | 真实 MaaS 请求、流式片段、工具调用记录；REQ-06-06 证据 | `cloud/T-ICT-044-MAAS-BLOCKED.md`；custom 结果标 `environment: local`，写明「不等同 MaaS」 | `export MAAS_API_KEY=<key>; export MAAS_BASE_URL=<url>; npm test -- src/lib/__tests__/ict-maas-live.test.ts` `[测试待新增]` |
| B-4 / 045 | 本地镜像构建与摘要；`deploy/cce-mentora.yaml`、`deploy/docker-compose.hw.yml` 静态校验；tag 替换与 `PLACEHOLDER` 中止逻辑核对 | SWR 推送、ECS/CCE 部署、重启读回、回退演练、443 入口 | `cloud/T-ICT-045-DEPLOY-BLOCKED.md`，`environment: local`；云端条目全 `BLOCKED` | `node scripts/deploy-hw-build.mjs deploy --tag ict-<sha7>-<manifest8>` `[脚本已存在]` |
| B-5 / 046 | 六要素模板（格式/命名/大小/入口/阶段/截止），未确认一律「待核」 | 官方通知原文核对、附件要求确认、实际提交 | `cloud/T-ICT-046-R00-BLOCKED.md`，每条含「待核」与已尝试时间 | `node scripts/verify-ict-evidence.mjs` 校验回填完整性 `[脚本可选，由 040 提供]` |
| B-6 / 047 | 历史成果索引（写在 047 文件内）、git 历史列示、与本轮 `codearts/` 分列 | 历史 spec/design/tasks 原件出示 | `cloud/T-ICT-047-ORIGINALS-MISSING.md`，每条含引用出处 + 「原件缺失 B-06」 | `git log --oneline -- .codeartsdoer/specs/huawei_cloud_upgrade` 后核对目录是否恢复 `[git 已存在]` |
| B-7 / 048 | 反向代理与证书配置步骤；localhost 自签 HTTPS 功能验证 | 外网独立浏览器 HTTPS 验收、公网运行标识比对 | `cloud/T-ICT-048-DOMAIN-BLOCKED.md`；本地验证标 `environment: local` | `curl -sSI https://<域名>/api/health` 并比对页脚标识 `[curl 已存在]` |
| B-8 / 049 | `INFO-TABLE` 模板结构与字数限制；其余材料骨架 | 实名信息定稿、约 2MB 合照 | `cloud/T-ICT-049-INFO-TABLE.md`，缺失项标「待填」，禁止编造 | 人工填入后 `node scripts/verify-ict-evidence.mjs` 校验非空 `[脚本可选，由 040 提供]` |
| B-9 / 050 | T-ICT-035 任务脚本/指标/样本表；1 名试点校准计时口径 | ≥5 人 AB/BA 对照、结论外推 | `cloud/T-ICT-050-SAMPLES.csv` 记录实际人数与「样本不足」；结论列留空 | `node scripts/quant-report.mjs --samples cloud/T-ICT-050-SAMPLES.csv` `[脚本待新增]` |
| B-10 / 051 | 只读盘点脚本核对、资源台账模板；费用字段写 `unknown` | 创建云资源、费用估算确认、预算内结论 | `cloud/T-ICT-051-BUDGET-BLOCKED.md`，`monthlyEstimate: unknown`、`withinBudget: unknown` | `export ICT_BUDGET_LIMIT_CNY=<额度>; node scripts/audit-cloud-budget.mjs --dry-run` `[脚本待新增，见 design 2.7.2]` |

判定规则（四栏共用）：

1. 只完成「可完成」栏 → 任务状态仍是 `BLOCKED`，不得因为替代工作达标而改判。
2. 解除后先执行「解除后命令」，再补「不可完成」栏对应证据；同一编号保留两份记录（阻塞期 + 解除后），不覆盖。
3. 「替代证据标注」写错环境名（如本地结果标 `huawei`）即视为证据失实，按 `FAIL` 处理并登记 `codearts/DEVIATIONS.md`。

### 13.1 T-ICT-042（B-1）华为云 RDS 连接与云端并发验证

- **阻塞事实**：`.env.local` 无 `DATABASE_URL`；无法连接真实 RDS，无法执行持久化、并发、归档的云端验证。
- **影响需求/任务**：REQ-03-02、REQ-04-01~16 云端部分、REQ-05-05；T-ICT-026~031 的 `huawei-rds` 档。
- **解除条件**：提供独立可用实例的连接串、区域、账号与规格，并确认该实例不属于生产或其他参赛者。
- **阻塞期替代工作**：完成 T-ICT-002 容器基座与 T-ICT-026~031 的 `local-equivalent` 全套；准备 `DATABASE_URL` 注入后的重跑命令。
- **证据标注**：`cloud/T-ICT-042-RDS-BLOCKED.md` 记录 `status: BLOCKED`、`reason: DATABASE_URL 未配置`、`unblock: 提供连接串`、`after: node scripts/verify-snapshot-rds.mjs --env huawei-rds --reuse --report`；不得把本地结果写入该文件充当云端证据。
- **判定**：`BLOCKED`（固定）；解除后重跑达标才可改 `PASS`。

### 13.2 T-ICT-043（B-2）DCS 跨进程与过期验证

- **阻塞事实**：无 `REDIS_URL`；无法验证限流/配额跨进程读取与 TTL 过期。
- **影响需求/任务**：REQ-03-03；R03 证据。
- **解除条件**：提供 `REDIS_URL`、区域、实例规格，允许两进程访问。
- **阻塞期替代工作**：用本地 Redis 容器做语义验证（如 Docker 可用），标注 `local-equivalent`；准备两进程读取脚本与过期复查步骤。
- **证据标注**：`cloud/T-ICT-043-DCS-BLOCKED.md`，写明本地等价结果与「不等同华为云 DCS」；解除后重跑并保留两份记录。
- **判定**：`BLOCKED`。

### 13.3 T-ICT-044（B-3）MaaS 真实模型调用

- **阻塞事实**：无 `MAAS_API_KEY` / `MAAS_BASE_URL`；主线无法产生真实 MaaS 请求、流式片段与工具调用证据。
- **影响需求/任务**：REQ-03-04、REQ-06-06；R06 真实模型证据。
- **解除条件**：提供密钥、端点、可用模型标识与配额。
- **阻塞期替代工作**：用现有 custom 通道验证业务链路；完成 T-ICT-036 演示脚本；记录模型标识、请求时间、结构化字段的采集格式。
- **证据标注**：`cloud/T-ICT-044-MAAS-BLOCKED.md`，明确「custom 通道结果不等同 MaaS」；R06-06 状态 `BLOCKED`，其余 R06 条目可为 `NOT_RUN`。
- **判定**：`BLOCKED`。

### 13.4 T-ICT-045（B-4）SWR 推送与 ECS/CCE 部署、重启、回退

- **阻塞事实**：无 SWR 组织/登录方式、无可用 ECS/CCE、无 443 入口条件；镜像推送、部署、重启读回、回退均无法执行。
- **影响需求/任务**：REQ-05-01~06、REQ-03-01 计算侧；T-ICT-032 的云端比对。
- **解除条件**：提供 SWR 组织与登录方式、ECS 实例或 CCE 集群、443 入口条件；确认回退镜像可拉取。
- **阻塞期替代工作**：本地构建镜像并记录摘要；静态校验 `deploy/cce-mentora.yaml`、`deploy/docker-compose.hw.yml`；核对 `scripts/deploy-hw-build.mjs` 的 tag 替换与 `PLACEHOLDER` 中止逻辑；准备回退检查清单。
- **证据标注**：`cloud/T-ICT-045-DEPLOY-BLOCKED.md` 记录本地镜像摘要与静态校验结果，标注 `environment: local`；云端条目全部 `BLOCKED`。
- **判定**：`BLOCKED`。

### 13.5 T-ICT-046（B-5）官方赛题通知与提交入口

- **阻塞事实**：未取得官方通知原文、附件要求、截止时间与上传入口。
- **影响需求/任务**：R00 全部；R08 提交口径。
- **解除条件**：队长账号提供通知截图、附件六要素、截止时间与上传入口。
- **阻塞期替代工作**：在 `cloud/T-ICT-046-REQUIREMENTS.md` 落模板（格式/命名/大小/入口/阶段/截止），未确认项一律写「待核」，禁止经验推断。
- **证据标注**：`cloud/T-ICT-046-R00-BLOCKED.md`，每项含「待核」与已尝试时间；解除后逐项回填并保留历史版本。
- **判定**：`BLOCKED`（REQ-00-03 的模板规则可先 `PASS`）。

### 13.6 T-ICT-047（B-6）历史码道三件套原件缺失

- **阻塞事实**：`docs/CODEARTS-PRACTICE.md` 与 `docs/evidence/INDEX.md` 引用 `.codeartsdoer/specs/huawei_cloud_upgrade/`，但当前工作区不存在，历史 spec/design/tasks 无法出示原件。
- **影响需求/任务**：REQ-02-04、REQ-08-06 的「历史可出示强度」。
- **解除条件**：从历史会话或备份恢复该目录；或确认接受「文档转述 + git 历史」口径。
- **阻塞期替代工作**：在 `cloud/T-ICT-047-ORIGINALS-MISSING.md` 内设「历史成果索引」小节，按 `docs/CODEARTS-PRACTICE.md` 与 git 历史列出历史成果、版本、日期，明确标注「原件缺失 B-06」；与本轮 `codearts/` 物理分列。
- **证据标注**：`cloud/T-ICT-047-ORIGINALS-MISSING.md`，每条含引用出处与缺失说明；不得伪造历史文件。
- **判定**：`BLOCKED`（历史可出示性）；本轮产出不受阻。

### 13.7 T-ICT-048（B-7）公网域名与证书

- **阻塞事实**：演示域名与证书未确定，无法做外网独立浏览器 HTTPS 验收。
- **影响需求/任务**：REQ-05-03。
- **解除条件**：提供域名与证书，或明确接受 IP 直接访问的验收方式。
- **阻塞期替代工作**：准备反向代理与证书配置步骤；本地用 HTTPS 自签或 localhost 验证页面功能，标注非公网验收。
- **证据标注**：`cloud/T-ICT-048-DOMAIN-BLOCKED.md`；解除后补外网访问截图与运行标识比对。
- **判定**：`BLOCKED`。

### 13.8 T-ICT-049（B-8）团队实名信息与合照

- **阻塞事实**：学校、队伍名、成员、联系方式与约 2MB 合照未提供。
- **影响需求/任务**：REQ-08-05；信息表定稿。
- **解除条件**：队长提供上述信息与合照。
- **阻塞期替代工作**：保留 `cloud/T-ICT-049-INFO-TABLE.md` 模板结构与字数限制，缺失项留空；完成其余材料骨架（并入 `gate/` 与 `cloud/`）。
- **证据标注**：`cloud/T-ICT-049-INFO-TABLE.md` 中留空项标「待填」，并在 `gate/INDEX.md` 的「待补与失败登记」区登记；禁止编造。
- **判定**：`BLOCKED`（信息表结构可先 `PASS`）。

### 13.9 T-ICT-050（B-9）试用者样本不足 5 人

- **阻塞事实**：未组织 ≥5 名试用者，无法完成交叉顺序对照评测。
- **影响需求/任务**：REQ-07-03、REQ-07-05。
- **解除条件**：组织至少 5 名试用者并按 AB/BA 交叉顺序执行；不足时如实标注。
- **阻塞期替代工作**：完成 T-ICT-035 任务脚本、指标定义、样本表；先做 1 名试点验证测量方法与计时口径。
- **证据标注**：`cloud/T-ICT-050-SAMPLES.csv` 记录实际人数与「样本不足」；结论不得外推。
- **判定**：`NOT_RUN`（可执行但未执行）或 `BLOCKED`（人数不足且无法组织），按实际选择并写明理由。

### 13.10 T-ICT-051（B-10）预算与计费额度未确认

- **阻塞事实**：计费方式、可用额度与预算上限未确认；不允许在未确认前创建云资源。
- **影响需求/任务**：REQ-03-06、REQ-05-09；T-ICT-042~045 的资源创建动作。
- **解除条件**：确认计费方式、可用额度与预算上限（`ICT_BUDGET_LIMIT_CNY`）。
- **阻塞期替代工作**：只读盘点脚本与资源台账模板；费用字段一律写「未知」并注明原因；复用已确认独立的存量资源（若有）。
- **证据标注**：`cloud/T-ICT-051-BUDGET-BLOCKED.md`，含 `monthlyEstimate: unknown`、`withinBudget: unknown`；未设置预算上限时脚本**不得**产生创建动作。
- **判定**：`BLOCKED`。

---

## 14. 本轮实际执行范围声明

### 14.1 本轮执行（按批次推进，受条件约束）

| 范围 | 任务 | 执行前提 | 本轮目标状态 |
| --- | --- | --- | --- |
| 基线 | T-ICT-001 | D1 凭据可用 | `PASS` 或 `BLOCKED`（如实） |
| 验证基座 | T-ICT-002 | Docker 可用 | `PASS` 或 `BLOCKED` |
| 审查 | T-ICT-003 | 无 | `PASS` |
| 契约层 | T-ICT-004~005 | 无 | `PASS` |
| RDS 事务 | T-ICT-006~011（含 007a~007d） | 容器可用 | `PASS`（本地等价） |
| 分块自愈 | T-ICT-012~014 | 容器可用 | `PASS`（本地等价） |
| 路由接入 | T-ICT-015~019 | 容器可用（部分用例） | `PASS`（本地）/ 云端 `BLOCKED` |
| 客户端回执 | T-ICT-020~021 | 无 | `PASS`（单元） |
| D1 对齐 | T-ICT-022~024 | 无（代码）/ D1 凭据（真实用例） | 代码 `PASS`；真实 D1 `PASS/BLOCKED` |
| D1 回归 | T-ICT-025 | D1 凭据 + T-ICT-001 基线 | `PASS/BLOCKED` |
| 集成证据 | T-ICT-026~031 | 容器可用 | `PASS`（本地等价） |
| 交付物 | T-ICT-032~036 | 无 | `PASS`（模板/脚本/组件） |
| 门禁 | T-ICT-037~039 | 无 | `PASS` |
| 索引与验收 | T-ICT-040~041 | 前述完成 | `PASS`（本地），用户确认后收尾 |

### 14.2 本轮不执行（因阻塞）

| 不执行项 | 阻塞 | 处理方式 |
| --- | --- | --- |
| 华为云 RDS/DCS/MaaS 实测 | B-1/B-2/B-3 | T-ICT-042~044 只登记 `BLOCKED` 与解除后命令 |
| SWR 推送、ECS/CCE 部署、重启、回退 | B-4 | T-ICT-045 只做本地镜像与静态校验 |
| 公网 HTTPS 入口验收 | B-4/B-7 | T-ICT-048 登记；不得用本地预览替代 |
| 官方赛题材料定稿与提交 | B-5/B-8 | T-ICT-046/049 只落模板与留空 |
| R06 真实模型录屏 | B-3 | 脚本就绪（T-ICT-036），录屏 `NOT_RUN` |
| R07 ≥5 人对照评测 | B-9 | 模板就绪（T-ICT-035），评测 `NOT_RUN` |
| 历史三件套原件出示 | B-6 | T-ICT-047 以索引 + 转述 + 缺失说明替代 |

### 14.3 本轮交付边界（必须写进结论）

1. 本轮**不创建任何 git 提交**；新增与修改均留在工作区，按 1.3 的命名规则可识别。
2. 本轮**不清理、不重置、不覆盖**既有 507 项变更；T-ICT-003 的工作区基线用于前后比对。
3. RDS 相关结论统一为「本地等价验证通过，华为云待验证」；不得提升云端条目为 `PASS`。
4. D1 相关结论依赖真实凭据；凭据缺失时 `REQ-04-17` 记为 `BLOCKED`，不得以「脚本可运行」替代「不退化」。
5. 自动化门禁通过只代表工程门禁；用户验收由 T-ICT-041 单独进行。

---

## 15. 需求 → 任务 → 证据 追溯矩阵（R00–R08）

| 条目 | 覆盖需求 | 主要任务 | 证据位置 | 本轮预期状态 |
| --- | --- | --- | --- | --- |
| R00 | REQ-00-01~04 | T-ICT-046、T-ICT-034 | `cloud/T-ICT-046-REQUIREMENTS.md`、`cloud/T-ICT-046-R00-BLOCKED.md` | `BLOCKED`（模板规则可 `PASS`） |
| R01 | REQ-01-01~06 | T-ICT-033、T-ICT-037~039 | `gate/T-ICT-033-manifest.json`、`gate/T-ICT-033-REBUILD.md`、`gate/T-ICT-037~039-*` | 本地 `PASS`；镜像比对 `BLOCKED` |
| R02 | REQ-02-01~05、REQ-04-19 | T-ICT-003、T-ICT-019、T-ICT-040、T-ICT-041 | `codearts/T-ICT-003-*`、`codearts/T-ICT-019-*`、`INDEX.md` | 部分 `PASS`；部署环节 `BLOCKED` |
| R03 | REQ-03-01~07 | T-ICT-042~045、T-ICT-051 | `cloud/T-ICT-042~045-*-BLOCKED.md`、`cloud/T-ICT-051-BUDGET-BLOCKED.md` | `BLOCKED`（REQ-03-05 规则可 `PASS`） |
| R04 | REQ-04-01~21 | T-ICT-004~031（007 含 007a~007d） | `rds/T-ICT-0NN*-*.json`、`d1/T-ICT-02N-*.json`、`gate/*` | 本地等价 `PASS`；云端 `BLOCKED`；D1 视凭据 |
| R05 | REQ-05-01~09 | T-ICT-032、T-ICT-045、T-ICT-048 | `gate/T-ICT-032-*`、`cloud/T-ICT-045-DEPLOY-BLOCKED.md`、`cloud/T-ICT-048-DOMAIN-BLOCKED.md` | `BLOCKED`（REQ-05-04 组件/05-07 扫描可 `PASS`） |
| R06 | REQ-06-01~08 | T-ICT-036、T-ICT-044 | `gate/T-ICT-036-SCRIPT.md`、`cloud/T-ICT-044-MAAS-BLOCKED.md` | 脚本 `PASS`；执行 `NOT_RUN`/`BLOCKED` |
| R07 | REQ-07-01~05 | T-ICT-035、T-ICT-050 | `gate/T-ICT-035-TASK.md`、`gate/T-ICT-035-METRICS.md`、`gate/T-ICT-035-SAMPLES.csv` | 模板 `PASS`；评测 `NOT_RUN` |
| R08 | REQ-08-01~08 | T-ICT-034、T-ICT-040、T-ICT-041 | `gate/INDEX.md`、`gate/EVIDENCE-TEMPLATE.md`、`gate/T-ICT-041-*` | 本地 `PASS`；材料定稿 `BLOCKED` |

追溯规则：

1. 每条需求至少映射到一个任务；每个任务至少映射到一个 R 条目（见各任务标题与本节）。
2. `PASS` 必须能在证据目录中按「条目 → 任务号 → 文件」三步定位。
3. 同一任务支撑多条需求时，逐条登记状态，不批量改判（spec 8.1 第 4 条）。

---

## 16. 证据目录约定

```text
docs/evidence/ict-track1-2026-11-20/
├── INDEX.md                    # 总索引：条目 → 状态 → 路径 → 负责人 → 日期
├── EVIDENCE-TEMPLATE.md        # 七字段 + 四态模板
├── baseline/                   # 改造前基线采集与对比输入（T-ICT-001）
├── pg-local/                   # 临时 PostgreSQL 容器基座与跳过策略（T-ICT-002）
├── rds/                        # RDS 通道语义证据：契约/事务/锁/判定/分块/归档/隔离（004~021、026~031）
├── d1/                         # 真实 D1 通道证据（022~025）
├── gate/                       # 交付物、冻结清单、tsc/vitest/build 门禁、INDEX、验收（032~041）
├── cloud/                      # 云端证据与全部外部阻塞登记（042~051，含非云阻塞）
└── codearts/                   # 码道过程：初步修改审查、断言迁移、偏差登记
```

归属规则（v1.1，七类互不重叠）：

| 子目录 | 收什么 | 不收什么 |
| --- | --- | --- |
| `baseline/` | 改造前基线（JSON/MD/HEAD 导出） | 改造后实测结果 |
| `pg-local/` | 容器生命周期、Docker 日志、跳过策略 | 任何业务语义断言 |
| `rds/` | RDS 通道的**业务语义**证据：判定矩阵、冲突载荷、分块读回、归档、隔离、契约（`environment: local-equivalent`） | tsc/vitest 原始日志（归 `gate/`）、真实 D1、华为云结果 |
| `d1/` | 真实 D1 语义对齐与对比（`environment: real-d1`） | 容器结果 |
| `gate/` | 构建与测试**原始日志**（tsc/vitest/build）、冻结清单、INDEX、映射表、验收清单、页脚/演示/量化模板 | 单条业务用例的语义结论（归 `rds/`） |
| `cloud/` | 云端实测与 B-1~B-10 阻塞登记（含材料/样本/域名等非云阻塞） | 本地结果充当云端证据 |
| `codearts/` | 过程记录：审查、迁移、DEVIATIONS、会话索引 | 需求验收证据 |

### 16.1 逐任务精确文件名（唯一权威）

任务正文若出现 v1.0 旧前缀（`sync/`、`build/`、`deploy/`、`version/`、`diff/`、`demo/`、`quant/`、`materials/`、`history/`、`pending/`），以下表为准，不再另建目录。

| 任务 | 子目录 | 精确文件名 |
| --- | --- | --- |
| T-ICT-001 | `baseline/` | `T-ICT-001-d1-baseline.json`、`T-ICT-001-notes.md`、`T-ICT-001-head-db.ts.txt` |
| T-ICT-002 | `pg-local/` | `T-ICT-002-container.json`、`T-ICT-002-docker.log`、`T-ICT-002-skip-policy.md` |
| T-ICT-003 | `codearts/` | `T-ICT-003-pre-review.md`、`T-ICT-003-pre-review.diff`、`T-ICT-003-workspace-baseline.txt` |
| T-ICT-004 | `gate/` | `T-ICT-004-vitest.log` |
| T-ICT-005 | `gate/` | `T-ICT-005-tsc.log`、`T-ICT-005-vitest.log` |
| T-ICT-006 | `rds/` | `T-ICT-006-tx-shell.json` |
| T-ICT-007a | `rds/` | `T-ICT-007a-lock-tx.json` |
| T-ICT-007b | `rds/` | `T-ICT-007b-decision.json` |
| T-ICT-007c | `rds/`、`codearts/` | `T-ICT-007c-conflict-409.json`、`DEVIATIONS.md`（锁键回退条目） |
| T-ICT-007d | `rds/` | `T-ICT-007d-commit-concurrency.json` |
| T-ICT-008 | `rds/` | `T-ICT-008-absent.json` |
| T-ICT-009 | `rds/` | `T-ICT-009-idempotent.json` |
| T-ICT-010 | `rds/` | `T-ICT-010-failures.json` |
| T-ICT-011 | `rds/` | `T-ICT-011-archive.json`、`T-ICT-011-archive-events.log` |
| T-ICT-012 | `rds/` | `T-ICT-012-read.json` |
| T-ICT-013 | `rds/` | `T-ICT-013-incomplete.json` |
| T-ICT-014 | `rds/` | `T-ICT-014-selfheal.md`、`T-ICT-014-selfheal.json` |
| T-ICT-015 | `rds/`、`gate/` | `T-ICT-015-get.json`、`T-ICT-015-vitest.log` |
| T-ICT-016 | `rds/` | `T-ICT-016-post-409.json`、`T-ICT-016-contract.md` |
| T-ICT-017 | `rds/`、`gate/` | `T-ICT-017-403.json`、`T-ICT-017-vitest.log` |
| T-ICT-018 | `rds/` | `T-ICT-018-events.log`、`T-ICT-018-archive-outcome.json` |
| T-ICT-019 | `codearts/`、`gate/` | `T-ICT-019-test-migration.md`、`T-ICT-019-vitest.log` |
| T-ICT-020 | `rds/`、`gate/` | `T-ICT-020-receipt.json`、`T-ICT-020-vitest.log` |
| T-ICT-021 | `rds/` | `T-ICT-021-cross-device.json` |
| T-ICT-022 | `d1/` | `T-ICT-022-d1-residual.json` |
| T-ICT-023 | `d1/` | `T-ICT-023-d1-incomplete.json` |
| T-ICT-024 | `d1/` | `T-ICT-024-d1-details.json` |
| T-ICT-025 | `d1/` | `T-ICT-025-d1-regression.json`、`T-ICT-025-diff.md` |
| T-ICT-026 | `rds/` | `T-ICT-026-concurrency.json` |
| T-ICT-027 | `rds/` | `T-ICT-027-fault-injection.json` |
| T-ICT-028 | `rds/` | `T-ICT-028-chunks.json` |
| T-ICT-029 | `rds/` | `T-ICT-029-archive.json` |
| T-ICT-030 | `rds/` | `T-ICT-030-isolation.json`、`T-ICT-030-nonsnapshot.json` |
| T-ICT-031 | `rds/` | `T-ICT-031-report.json`、`T-ICT-031-run.log` |
| T-ICT-032 | `gate/` | `T-ICT-032-footer.md`、`T-ICT-032-footer.png`、`T-ICT-032-vitest.log` |
| T-ICT-033 | `gate/` | `T-ICT-033-manifest.json`、`T-ICT-033-SOURCES.sha256`、`T-ICT-033-REBUILD.md`、`T-ICT-033-EXCLUDED.md`、`T-ICT-033-freeze.log` |
| T-ICT-034 | `gate/`（根目录） | `INDEX.md`、`EVIDENCE-TEMPLATE.md`（7 个子目录同级创建） |
| T-ICT-035 | `gate/` | `T-ICT-035-TASK.md`、`T-ICT-035-METRICS.md`、`T-ICT-035-SAMPLES.csv`、`T-ICT-035-CONCLUSION.md` |
| T-ICT-036 | `gate/` | `T-ICT-036-SCRIPT.md`、`T-ICT-036-CHECKLIST.md` |
| T-ICT-037 | `gate/` | `T-ICT-037-tsc.log`、`T-ICT-037-exitcode.txt` |
| T-ICT-038 | `gate/` | `T-ICT-038-vitest.log`、`T-ICT-038-summary.json` |
| T-ICT-039 | `gate/` | `T-ICT-039-build.log`、`T-ICT-039-summary.md` |
| T-ICT-040 | `gate/` | `INDEX.md`（回填）、`T-ICT-040-R00-R08-MATRIX.md`、`T-ICT-040-evidence-check.json` |
| T-ICT-041 | `gate/` | `T-ICT-041-ACCEPTANCE-LOCAL.md`、`T-ICT-041-PREVIEW.md`、`T-ICT-041-user-confirm.md` |
| T-ICT-042 | `cloud/` | `T-ICT-042-RDS-BLOCKED.md` |
| T-ICT-043 | `cloud/` | `T-ICT-043-DCS-BLOCKED.md` |
| T-ICT-044 | `cloud/` | `T-ICT-044-MAAS-BLOCKED.md` |
| T-ICT-045 | `cloud/` | `T-ICT-045-DEPLOY-BLOCKED.md` |
| T-ICT-046 | `cloud/` | `T-ICT-046-REQUIREMENTS.md`、`T-ICT-046-R00-BLOCKED.md` |
| T-ICT-047 | `cloud/` | `T-ICT-047-ORIGINALS-MISSING.md` |
| T-ICT-048 | `cloud/` | `T-ICT-048-DOMAIN-BLOCKED.md` |
| T-ICT-049 | `cloud/` | `T-ICT-049-INFO-TABLE.md` |
| T-ICT-050 | `cloud/` | `T-ICT-050-SAMPLES.csv` |
| T-ICT-051 | `cloud/` | `T-ICT-051-BUDGET-BLOCKED.md` |

命名规则：

1. 任务证据：`<子目录>/T-ICT-<编号>-<slug>.<ext>`，编号与本文档一致（子任务保留 `007a` 形式）。
2. 多轮执行：`-run2`、`-run3` 追加，不覆盖；`INDEX.md` 指向最新一轮并保留历史链接。
3. 机器可读优先：并发/归档/故障一律 JSON；人读说明另存同名 `.md`，两者编号一致。
4. 禁止落盘内容：连接串、密码、令牌、明文快照、完整账号标识、完整用户路径。
5. 状态字段只允许 `PASS / FAIL / BLOCKED / NOT_RUN`；`environment` 只允许 `local`、`local-equivalent`、`real-d1`、`tencent`、`huawei`。`gate/` 内日志不带 `environment` 时按 `local` 记。

---

## 17. 风险控制与回退

| 风险 | 触发点 | 控制措施 | 回退动作 |
| --- | --- | --- | --- |
| 事务占用连接导致池饥饿 | T-ICT-006~011 | 池上限 5、`statement_timeout 8s`、`lock_timeout 2s`；仅快照提交用专用连接 | 关闭 `DB_CHANNEL=huawei`，回 `auto`/D1 通道 |
| advisory lock 碰撞 | T-ICT-007a | 键仅由 path 生成；观测到碰撞切 64 位 `bit(64)` 方案 | 切换锁键实现，保留同一事务语义 |
| 死锁 | 提交与归档交叉 | 归档不使用提交连接、不加锁 | 死锁方 409/503 重试；归档失败不回滚主写 |
| 令牌口径回归 | T-ICT-004/009 | 单测锁「crypto 与 SQL 哈希一致」；集成锁「读令牌原样写成功」 | 恢复 `rdsGetSha` 单一口径，暂停分块令牌 |
| 跨账户码值变更 | T-ICT-017 | 客户端对 403/409 均不重试；变更登记 `codearts/DEVIATIONS.md` | 单点改回 409（仅应急，不作为长期方案） |
| 客户端误对齐覆盖他人 | T-ICT-020/021 | 仅回执命中才对齐；重推仍走完整条件写；上限 1 次 | 关闭对齐开关（保留冲突态），恢复旧行为 |
| 回退后数据不可读 | T-ICT-014 | 不新增存储形态，仅块行→单行；回退前执行旧版读取检查 | 使用归档 `versions/<uid>/<ts>.json` 找回 |
| 证据口径失实 | 全部任务 | 模板强制 environment 枚举；INDEX 单列「不得用作云端证据」 | 作废该条证据，重新执行并标注原因 |
| 工作区被误动 | T-ICT-001/033 | 脚本只读；禁止 clean/checkout/reset/stash；前后 status 比对 | 立即停止，按条目比对恢复；不执行全量回滚 |

整体回退粒度（从大到小）：

1. 代码：按文件回退本轮改动（`db.ts`、`sync/route.ts`、`auth-client.ts`、`layout.tsx`、`app-shell.tsx`、新增文件），不触碰其他 507 项。
2. 通道：`DB_CHANNEL=auto` 绕开 RDS 新事务路径；D1 旧实现完整保留。
3. 部署：切回上一镜像 tag，不重新构建（待 T-ICT-045 解除后执行）。
4. 数据：归档提供找回点；本轮不改变存储格式，无需数据回滚脚本。

---

## 18. 变更记录

| 日期 | 版本 | 变更 | 影响任务 |
| --- | --- | --- | --- |
| 2026-11-20 | 1.0 | 首次生成；按 E-1~E-12 展开 41 个执行任务，B-1~B-10 单列 10 项；明确基线与容器前置、D1 对比、四态证据与执行范围 | 全部 |
| 2026-11-20 | 1.1 | 重试修订：①T-ICT-007 拆为 007a~007d（锁与事务边界 / 读取与判定 / 409 载荷 / 并发自证），执行单元 51→54；②证据目录收敛为 7 类（baseline/pg-local/rds/d1/gate/cloud/codearts）并新增 16.1 逐任务精确文件名；③门禁命令按 `package.json` 实况修正（`npm test --`、`npm run build -- --webpack`、`tr -d '\r'`、`--no-file-parallelism`）；④B-1~B-10 补四栏口径表（13.0） | 007a~007d、008~011、012、015、016、026、027、032~041、042~051 |

后续任何任务范围调整必须：

1. 在本表追加一行（日期、版本、变更、影响任务）。
2. 同步更新第 15 章追溯矩阵与第 14 章执行范围。
3. 不删除已完成任务的证据；被取消的任务保留并标 `NOT_RUN` 及取消原因。