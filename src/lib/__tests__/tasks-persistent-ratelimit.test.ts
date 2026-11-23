import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：/api/tasks 曾是本组唯一没有路由级持久限流的数据路由——
 * GET/POST 都只靠 verifySession + proxy.ts 的全站进程内桶（proxy 注释自认「防单实例被
 * 同 IP 打满的粗筛」，rate-limit.ts:10-11 明确「高危端点必须用持久桶」，进程内桶在多实例
 * 下配额=每实例额度×实例数）。放大系数：GET 1 次请求 = dbList + 最多 200 次 dbGet，
 * 任一登录用户持续打满即烧穿共享的 D1 日配额/GitHub 限流。
 * 修复：GET tasks-read 40/分/userId、POST tasks-write 30/30s/userId 持久桶。
 * 本锁用真实 rateLimitPersistent（db 替身 hasHealthyRemoteDb=false → 进程内桶）打满桶，
 * 证明 429 在远小于 proxy 全站桶（120 突发）的额度上出现——即路由级桶真实存在。 */

const store = new Map<string, unknown>();
let sessionUserId = "u_rl";

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async () => (store.size ? null : null)),
  dbPut: vi.fn(async (key: string, val: unknown) => {
    store.set(key, val);
    return { sha: "mem" };
  }),
  dbDelete: vi.fn(async (key: string) => {
    store.delete(key);
  }),
  dbList: vi.fn(async () => []),
  hasHealthyRemoteDb: vi.fn(() => false), // 进程内桶路径，行为与真实持久桶一致（KV 故障降级口径）
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: sessionUserId, email: "rl@x.dev", name: "RL", sv: 0 })),
}));

vi.mock("../server/config", () => ({ logEvent: vi.fn() }));

import { GET, POST } from "../../app/api/tasks/route";

const getReq = () =>
  ({ nextUrl: new URL("http://localhost/api/tasks") }) as unknown as import("next/server").NextRequest;
const postReq = () =>
  ({
    json: async () => ({ taskId: `pt_${Date.now().toString(36)}_rl`, goalId: "g1", status: "running" }),
    nextUrl: new URL("http://localhost/api/tasks"),
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  store.clear();
  sessionUserId = `u_rl_${Math.random().toString(36).slice(2, 8)}`; // 每用例独立桶（进程桶跨用例共享）
});

describe("/api/tasks 路由级持久限流", () => {
  it("GET 连打 45 次：远早于 proxy 全站桶额度（120）即出现 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 45; i++) {
      statuses.push((await GET(getReq())).status);
    }
    expect(statuses[0]).toBe(200);
    /* 修复前：无路由级桶，45 次全部 200 */
    expect(statuses.slice(0, 45)).toContain(429);
  });

  it("POST 连打 35 次（容量 30/30s）：出现 429，且写失败的请求不落库", async () => {
    let saw429 = false;
    for (let i = 0; i < 35; i++) {
      const res = await POST(postReq());
      if (res.status === 429) saw429 = true;
      else expect(res.status).toBe(200);
    }
    expect(saw429).toBe(true);
    /* 落库条数 < 请求总数：被限流的请求在写入前就被拒 */
    expect(store.size).toBeLessThan(35);
  });
});
