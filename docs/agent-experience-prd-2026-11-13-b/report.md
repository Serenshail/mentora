# 执行报告 · run-2026-11-13-b（同步安全 / 真实数据 fixture / 跨设备冲突 / 备份演练）

回应 [REVIEW-TENCENT-2026-11-13.md](../REVIEW-TENCENT-2026-11-13.md)。`run-2026-11-13-a` 保持原样未改。

## 1. 纠正上一轮的误报（复核 §1）

复核是对的：上一轮 `act-chain-mock.json` 里三条 PASS 是**空数据比较**——
`A04M-e 成绩=0`、`A04M-f note=undefined`、`A04M-h Rust=`。空数组与空数组相等，不能证明任何数据被保留。

**已修**：

1. **强制 fixture 完整性检查**（缺任一项立即抛错停止，不计通过率）：
   ```
   fixture 完整：成绩 1 条 / 笔记 "open() 用法笔记" 21 字 / Rust "Rust"
   ```
2. **快照带存在性标记**：`meta.goalExists / noteExists / rustExists / quizCount`，
   区分「对象不存在」与「对象存在但字段为空」。
3. **三条断言改为必须非空 + 内容一致**：
   ```
   A04M-e 成绩记录保留（必须非空且内容一致）  :: before=1 after=1
   A04M-f 笔记未被改动（必须存在且正文一致）  :: before=true after=true title=open() 用法笔记
   A04M-h Rust 干扰目标未被误改（必须存在）    :: before=true after=true Rust=所有权
   A04M-k 刷新后成绩与笔记仍在（非空且内容一致）:: 成绩=1 笔记存在=true
   ```

## 2. 同步写入路径（复核 §2 的五条）

### 2.1 把决策抽成纯函数，让行为可证明

新增 `src/lib/sync-decision.ts`：`decideSyncAction()` 输入「云端结果 + 本地状态 + 是否真被编辑」，
输出 `pull / push / none / conflict`。**18 条行为测试**（`sync-decision.test.ts`）覆盖复核点名的每条路径：

| 复核要求 | 测试 |
|---|---|
| GET 503/超时/异常时不得写入 | `status=error → none`（3 条，含「error 的 data 为 null 也不能当空」） |
| 拉取期间真编辑 → 不得静默覆盖 | `云端有数据 + 编辑过 + 本地有数据 → conflict` |
| 首次无数据 / 仅设置 / 仅对话 / 已有数据 | `hasSubstantialData` 5 条 |
| 业务指纹能区分水合与真编辑 | 4 条（内容相同→同指纹；增/换/加消息→变化） |

**明确删除了** `agent-autopush-firstsync-gate.test.ts`（源码正则，测试名与断言不符）——
复核指出它「不能证明失败不放行」，已由行为测试取代。

### 2.2 三条路径全部收敛到同一个决策函数

| 路径 | 原问题（复核点名） | 现状 |
|---|---|---|
| `bootSync` | catch 一切错误后 `return void`，调用方无法区分成败 | 返回 `"ready" \| "unsafe"`；用**业务指纹**而非 store 引用判断编辑 |
| `useAutoPush` | 无条件 `markReady` | 只有 `result === "ready"` 才放行 |
| `useFlushOnHide` | **完全绕过闸门**（复核 §2-2） | 加同一闸门；未就绪时 `flush` 直接 return |
| `syncAfterLogin` | 在检查 error **之前**就用引用变化决定推送（§2-3） | 走同一纯函数；推送必须在决策之后 |

接线断言在 `sync-wiring.test.ts`（8 条，含反向断言「catch 里不得 pushCloud」）。
**行为正确性**由 `sync-decision.test.ts` 证明，**接线正确性**由 `sync-wiring.test.ts` 证明——两者分开，不再用正则冒充行为证据。

## 3. 跨设备冲突（复核 §3）：11/11 通过

**根因**（比复核推测的更具体）：`rdsPut` 完全忽略 `sha` 参数，PG 通道**没有任何并发控制**；
`/api/sync` 传的 `sha: cur?._sha` 是死参数。而且 PG 的 `dbGet` 返回的 `_sha` 是占位符 `"rds"`，不是真哈希。

**修法**：用 `updatedAt` 作为版本标识（每份快照自带、单调递增、客户端拿得到）——
GET 返回 `version`，POST 接受 `baseVersion`，**服务端原子比对**，不一致返回 409。

`scripts/verify-cross-device-conflict.mjs`（两个独立 BrowserContext + 两个独立 token，真实 HTTP，零模型请求）：

```
PASS SEED   基线数据写入成功
PASS ①-a    B 的修改写入成功（有服务端版本）
PASS ①-b    A 基于旧版本提交被服务端拒绝（不静默覆盖 B）  status=409
PASS ①-c    冲突响应带 conflict 标记与当前版本
PASS ①-d    服务端最终保留 B 的修改（A 未覆盖）
PASS ②-a    A 重新读取后提交成功（冲突可恢复）
PASS ②-b    服务端最终是 A 的新修改
PASS ③-a    不带 baseVersion 的旧路径仍可写（兼容）
PASS ④-a    服务端有历史版本存档（覆盖前先归档）
PASS ⑤-A    设备 A 刷新后读到的服务端状态是最新版
PASS ⑤-B    设备 B 刷新后读到的服务端状态是最新版
```

**这是本轮第二个重要成果**：跨设备并发覆盖从「无保护」变成「服务端 409 + 可恢复」。

## 4. A03/A04 机制验证（真实非空 fixture）：15 PASS / 0 FAIL / 1 BLOCKED

```
fixture 完整：成绩 1 条 / 笔记 "open() 用法笔记" 21 字 / Rust "Rust"

PASS A03M-a 结构性修改先出审批卡（不静默写入）      :: 审批卡=1
PASS A03M-b 审批卡出现时对象尚未改变                :: 阶段数=2
PASS A03M-c 拒绝后业务对象完全不变                  :: 阶段=第一阶段/第二阶段
PASS A04M-a 出现审批卡                              :: 卡数=1
PASS A04M-b 批准前零写入
PASS A04M-c 批准后第二阶段变成 7 天                 :: 天数=7
PASS A04M-d 已完成天保留（标题相同沿用原 id）        :: 含 done-day=true
PASS A04M-e 成绩记录保留（必须非空且内容一致）      :: before=1 after=1
PASS A04M-f 笔记未被改动（必须存在且正文一致）      :: before=true after=true
PASS A04M-g 留下可恢复的历史版本                    :: history=1
PASS A04M-h Rust 干扰目标未被误改（必须存在）        :: before=true after=true Rust=所有权
PASS A04M-i 专业页能看到 7 天新目录                 :: 含新天=true
PASS A04M-j 刷新后修改仍保留
PASS A04M-k 刷新后成绩与笔记仍在（非空且内容一致）  :: 成绩=1 笔记存在=true
BLOCK A04M-l 本地 baseSignature 不感知云端并发变更（跨设备保护在服务端）
```

**A04M-l 改为 BLOCKED 并说明**：它测的是「本地 baseSignature 能否感知**云端**变更」——
不能，baseSignature 只比本地 store。真正的跨设备保护在服务端，已由第 3 节 11/11 验证。
上一轮把它同时写进「不是产品缺陷」和「真缺口」是自相矛盾，本轮改为单一结论 + 指向服务端证据。

## 5. 隔离备份恢复演练（复核 §4，已完成）

**全程在 sudo 内、只操作测试库，主站前后均正常（`db:d1` 未变）**。

| 项 | 结果 |
|---|---|
| 合成数据 | 6 类：user/plan/quiz/note/**300KB 长记录**/version，含中文与特殊字符 |
| pg_dump | 20K，自定义格式，`chmod 600` |
| 恢复到第二个库 `mentora_restore` | 成功 |
| **逐类 md5 比对** | **HASH_MATCH 6 行完全一致** |
| PG 重启后读取 | 6 行仍可读 |
| Redis TTL | 60 → 重启后 57（保留） |
| Redis 原子性 | INCR 两次 = 2 |
| Redis 持久键 | 重启后 `persist=keep` 存活 |
| 备份位置/权限 | `/var/backups/mentora-test/`，`-rw------- root root` |
| 磁盘 | 50G 用 17G，余 31G |

**注意**：这验证的是**通道层**（密文原样搬运 + 恢复完整性）。复核要求的
「真实加密→迁移→解密」需要走应用层加密函数，本轮用的是裸 SQL 写入——
这一点在 §7 列为未完成项，不冒充已验证。

## 6. 服务器到期时间

尝试从主机内查询未果（属腾讯云控制台信息，系统内不存在）。
**需要主人从控制台确认**。按要求未因此阻断隔离测试与备份演练。

## 7. 检查

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **257 files / 1635 tests passed，0 failed**（15 skipped） |
| `npx tsc --noEmit` | EXIT=0 |
| `npx eslint src` | 0 errors / 36 warnings |
| `npx next build` | EXIT=0 |

## 8. 明确未完成

1. **A03/A04 真实模型链路未跑**（本轮全是 mock 上游）；A01-E4 未跑
2. **应用层加密的迁移解密未验证**（备份演练只验证了通道层密文搬运）
3. **正式迁移未执行**，主站仍 `d1`；`DB_CHANNEL=huawei` 需要 PG **和** Redis 两个变量，方案里已写明
4. **停写窗口实际耗时未知**（5–15 分钟仍是估算）
5. **服务器到期时间未知**
6. **单机承载正式负载未压测**
7. 切换后新写入的反向同步/回退方案仍是设计，未演练
