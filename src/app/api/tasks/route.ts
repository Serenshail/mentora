import { NextRequest } from "next/server";
import { verifySession } from "@/lib/server/auth";
import { dbPut, dbGet, dbList } from "@/lib/server/db";
import { rateLimitPersistent, type RateLimitOpts } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";

/* 计划生成任务状态持久化（V26.1 P0：整页刷新后仍可查询任务发生过）。
 * KV：tasks/<userId>/<taskId>.json（加密，userId 取自会话）。
 * 客户端 fire-and-forget 写入；这里只做归属校验与读写，不做执行。 */

interface TaskRecord {
  taskId: string;
  goalId: string;
  kind: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  error?: string;
}

const VALID_STATUS = new Set(["running", "completed", "failed", "interrupted"]);

/* taskId 字符白名单：真实 id 只出自 plan-tasks.ts startPlanTask（pt_ 前缀 + 36 进制
 * 时间戳/随机串），字符集 [A-Za-z0-9_-]。taskId 会拼进存储路径
 * tasks/<userId>/<taskId>.json，而 GitHub Contents 兜底通道（db.ts ghApi:504）把
 * 整条 path 原样拼进 api.github.com URL——WHATWG URL 规范化会消解 `..`：不设
 * 白名单时登录用户传 taskId=../../users/<24位emailHash> 可越权写任意用户档案
 * （覆盖 salt/hash，受害者无法登录），taskId=../../data/<userId> 可毁任意用户
 * 数据。KV 类通道（Upstash/D1/RDS/DCS）键是字面字符串、`..` 惰性无害，但校验
 * 在入口一次兜住五个通道。与 personal.ts isValidItemId 同款防护（v27.5 先例）。 */
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---- 路由级持久限流（rate-limit.ts:10-11「高危端点必须用持久桶」）----
 * 本组数据路由（memory 40/分/userId、redeem 5/分/IP、reminders 30/30s…）都有
 * rateLimitPersistent，本路由此前是唯一例外：只靠 proxy.ts 的全站进程内桶
 * （proxy 注释自认「防单实例被同 IP 打满的粗筛」，多实例下配额=每实例额度×实例数）。
 * 放大系数：GET 一次 = dbList + 最多 200 次 dbGet，任一登录用户持续打满即烧穿共享的
 * D1 日配额/GitHub 限流，拖垮全体用户的数据层。量级对齐 memory 读写分桶；
 * POST 是 fire-and-forget 状态写入 + 45s 心跳（plan-tasks.ts HEARTBEAT_MS=45s），30/30s 足够。
 * limited() 在限流器自身崩溃时放行（fail-open）——与 rateLimitPersistent 内部
 * 「KV 故障降级进程桶：限流失效好过功能不可用」同一取舍，不把限流器故障放大成路由 500。 */
const TASKS_READ_LIMIT: RateLimitOpts = { capacity: 40, refillPerSec: 40 / 60 };
const TASKS_WRITE_LIMIT: RateLimitOpts = { capacity: 30, refillPerSec: 30 / 60 };
async function limited(bucket: string, opts: RateLimitOpts): Promise<boolean> {
  try {
    return await rateLimitPersistent(bucket, opts);
  } catch {
    return true;
  }
}

/* 故障态必须与空态可区分：dbList/dbGet 在通道故障时抛错（db.ts:619/729 非 404
 * 即 throw，404 已在 db 层转成 null/[]）。旧实现用 .catch(() => []) 和逐条
 * .catch(() => null) 把故障折叠成空列表，响应与"这个用户确实没有任务"完全一致；
 * 而前端 learn/new/page.tsx 正是靠这份列表判断"上次生成被页面刷新中断"并弹重新
 * 生成引导——GitHub 通道被限流时用户既拿不到引导，也看不到任何失败提示。
 * 现在：列目录失败 → 503；有记录但一条都读不出来 → 503；部分失败 → 200 且带
 * degraded:true（能读到的照常返回，不因一条坏记录吞掉全部）。 */
export async function GET(req: NextRequest) {
  const session = await verifySession();
  if (!session) return Response.json({ error: "请先登录" }, { status: 401 });
  if (!(await limited(`tasks-read:${session.userId}`, TASKS_READ_LIMIT))) {
    return Response.json({ error: "操作太频繁，稍后再试" }, { status: 429 });
  }
  const goalId = req.nextUrl.searchParams.get("goalId") || "";
  let items: { name: string; sha: string }[];
  try {
    items = await dbList(`tasks/${session.userId}`);
  } catch {
    return Response.json({ error: "任务状态暂时不可用，稍后再试" }, { status: 503 });
  }
  /* 截断只允许发生在 goalId 过滤与 updatedAt 排序**之后**：taskId 形如
   * pt_<Date.now().toString(36)>_…（plan-tasks.ts:82），目录序（RDS ORDER BY k 升序 /
   * GitHub 文件名字母序）≈ 时间升序即最旧在前，而任务记录只有写入没有删除路径——
   * 旧实现先 slice(0, goalId ? 50 : 100) 再过滤/排序，某用户累计超限后，最近一次被页面
   * 刷新中断的生成记录恰在列表尾部被截掉，learn/new 的中断恢复引导静默消失。
   * 读取窗口从目录序尾部取（最新优先），200 条只为兜住「只增不删」目录的无界增长；
   * 最新记录永远落在窗口内，goalId 场景不再有「最新中断记录被截掉」的盲区。 */
  const READ_WINDOW = 200;
  const names = items
    .filter((it) => it.name.endsWith(".json"))
    .slice(-READ_WINDOW)
    .map((it) => it.name);
  const records: TaskRecord[] = [];
  let failed = 0;
  /* 分块并行读（块内 8、块间串行）：旧实现串行逐条 await dbGet（最多 100 次远程往返），
   * 与 personal.ts listMemory 修复过的同款反模式——100 条 × 100-300ms = 10-30s；
   * GitHub 兜底通道单次 dbGet 最坏 ~22s（4 次尝试 × 5s 超时 + 退避）时整个请求可挂数分钟。
   * MEMORY_READ_CHUNK=8 同口径（admin/members、weekly-digest 等既有分块读一致）。 */
  const READ_CHUNK = 8;
  for (let i = 0; i < names.length; i += READ_CHUNK) {
    const part = await Promise.all(
      names.slice(i, i + READ_CHUNK).map(async (name) => {
        try {
          return await dbGet<TaskRecord>(`tasks/${session.userId}/${name}`, { encrypted: true });
        } catch {
          failed++;
          return null; // 单条读失败只跳过该条（下方 failed 统一裁决），不阻断整份列表
        }
      })
    );
    for (const t of part) if (t) records.push(t);
  }
  /* 先过滤（goalId）再排序再截断——顺序不能颠倒（见上方 READ_WINDOW 注释） */
  const matched = goalId ? records.filter((t) => t.goalId === goalId) : records;
  matched.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const tasks = matched.slice(0, goalId ? 50 : 100);
  /* 有失败且一条都没读出来：无法断言"没有任务"，宁可报错也不返回骗人的空列表。
   * （读到了部分记录 → 200 + degraded 如实呈现，与原纪律一致。） */
  if (failed > 0 && records.length === 0) {
    return Response.json({ error: "任务状态暂时不可用，稍后再试" }, { status: 503 });
  }
  return Response.json({
    /* 比较器必须对相等值返回 0：`< ? 1 : -1` 会把相等也判成 -1，违反比较器一致性
     * （相等元素的相对顺序不确定，部分引擎下排序结果不可复现）。 */
    tasks,
    ...(failed > 0 ? { degraded: true } : {}),
  });
}

export async function POST(req: NextRequest) {
  const session = await verifySession();
  if (!session) return Response.json({ error: "请先登录" }, { status: 401 });
  if (!(await limited(`tasks-write:${session.userId}`, TASKS_WRITE_LIMIT))) {
    return Response.json({ error: "操作太频繁，稍后再试" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as Partial<TaskRecord>;
  const taskId = String(body.taskId ?? "").slice(0, 64);
  const goalId = String(body.goalId ?? "").slice(0, 64);
  const status = String(body.status ?? "");
  if (!taskId || !goalId || !VALID_STATUS.has(status)) {
    return Response.json({ error: "参数不完整" }, { status: 400 });
  }
  if (!TASK_ID_RE.test(taskId)) {
    return Response.json({ error: "taskId 不合法" }, { status: 400 });
  }
  const prev = await dbGet<TaskRecord>(`tasks/${session.userId}/${taskId}.json`, { encrypted: true }).catch(() => null);
  const record: TaskRecord = {
    taskId,
    goalId,
    kind: String(body.kind ?? "master").slice(0, 20),
    status: status as TaskRecord["status"],
    startedAt: prev?.startedAt || String(body.startedAt ?? "") || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: body.error ? String(body.error).slice(0, 200) : undefined,
  };
  /* 写失败必须可见（与 memory DELETE 503、account DELETE partial 同纪律）：GET 的
   * 「故障态必须与空态可区分」正建立在这份 POST 之上——learn/new/page.tsx 靠 GET 判断
   * "上次生成被页面刷新中断"。旧实现 .catch(() => {}) 吞掉失败并无条件 ok:true，
   * GitHub 等通道故障期间 emit("running") 与 45s 心跳（plan-tasks.ts，本就 fire-and-forget
   * 不看响应）全部写失败且无任何信号：用户整页刷新后 GET 返回「真空列表」，中断恢复引导
   * 静默消失、生成结果丢失，失败在 API 契约上不可表达。logEvent 留痕 + 503 如实上报。 */
  try {
    await dbPut(`tasks/${session.userId}/${taskId}.json`, record, { encrypted: true });
  } catch (e) {
    logEvent({ route: "tasks", ev: "put-fail", userId: session.userId, taskId, msg: e instanceof Error ? e.message : String(e) });
    return Response.json({ ok: false, error: "任务状态写入失败，稍后再试" }, { status: 503 });
  }
  return Response.json({ ok: true });
}
