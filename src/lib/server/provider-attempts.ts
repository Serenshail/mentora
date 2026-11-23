import "server-only";

/* provider 层尝试计数（E1：一次 API 请求可能产生多次上游尝试，客户端账本看不到）。
 * 进程内累计，供 /api/debug/provider-count 核对；**权威记录仍是 logEvent("chat-upstream")**
 * （落 events 表，跨进程/跨重启可查）。这里只是让验收脚本能即时读到一个数字。
 *
 * 从 chat/route.ts 下沉到 lib/（2026-11）：debug/provider-count 曾直接 import 聊天路由模块
 * 只为读这一个计数器——路由文件是 Next.js 的构建入口而非可复用模块，那会把 chat 路由的
 * 全部依赖图拉进 debug 端点，且计数器的唯一权威代码住在路由文件里，拆分/重构 chat 路由
 * 会静默破坏该端点。与 logEvent 收口到 config.ts 同一惯例。 */

const providerAttempts = { total: 0, byTask: {} as Record<string, number>, lastAt: 0 };
/* byTask 的键直接来自客户端 JSON 的 task 字段：Vercel isolate 随请求回收清零，但
 * 腾讯云自托管是长生命周期单进程——不截断/封顶的话，攻击者每请求带 1 个唯一超长
 * task 串即可无界吃内存直至 OOM。键截断到 40 字符、桶数封顶 200（超出的并入
 * __other__，计数只增不减不影响核对用途；权威记录仍是 logEvent("chat-upstream")）。 */
const TASK_KEY_MAX = 40;
const BYTASK_MAX_KEYS = 200;

export function noteProviderAttempt(task: string) {
  providerAttempts.total += 1;
  let key = task.length > TASK_KEY_MAX ? task.slice(0, TASK_KEY_MAX) : task;
  if (!(key in providerAttempts.byTask) && Object.keys(providerAttempts.byTask).length >= BYTASK_MAX_KEYS) {
    key = "__other__";
  }
  providerAttempts.byTask[key] = (providerAttempts.byTask[key] ?? 0) + 1;
  providerAttempts.lastAt = Date.now();
}

export function getProviderAttempts() {
  return { ...providerAttempts, byTask: { ...providerAttempts.byTask } };
}
