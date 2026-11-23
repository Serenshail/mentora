import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* 回归锁（2026-11 复核）：MENTORA_OPEN_USER_ID 设了无效值且未配 EMAIL 时，
 * `if (!userId)`（route.ts:171）挡不住「有值但解析不到用户」——users/<无效值>.json 读不到、
 * scanByEmail 因未配 EMAIL 直接 false，userId 保持无效值，继续走 dbGet(data/<无效值>.json)
 * 得 null → 返回 ok:true + 空任务列表。插件端呈现「今日无事可做」，部署者无从发现配置坏了
 * （env 手误/换库后旧 userId 失效）——与本文件自己的原则（「配置缺失要显式失败」）相悖。
 * 修复：绑定阶段记录 bound（users/ 档案命中或邮箱反查命中才算）；!bound 且快照读不到
 * → 显式 404 + logEvent。两个既有放行路径不受影响：
 *   a) bound=false 但 data/<userId>.json 命中（直接填用户 UUID 兼容 data/ 键的旧部署）；
 *   b) bound=true 但快照还没同步过（新用户空态）。 */

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.7"),
}));

const h = vi.hoisted(() => ({
  logEvent: vi.fn(() => {}),
  userHit: false,
  snapshot: null as unknown,
}));

vi.mock("@/lib/server/config", () => ({ logEvent: h.logEvent }));

vi.mock("@/lib/server/db", () => ({
  dbGet: vi.fn(async (path: string) => {
    if (path.startsWith("users/")) return h.userHit ? { userId: "u_real", email: "real@example.com", name: "Real" } : null;
    if (path.startsWith("data/")) return h.snapshot;
    return null;
  }),
  dbList: vi.fn(async () => []),
  dbPut: vi.fn(async () => ({ sha: "test" })),
}));

import { GET } from "@/app/api/open/plan/route";

function makeReq(): NextRequest {
  return { headers: new Headers({ "x-open-token": "test-token" }) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.stubEnv("MENTORA_OPEN_TOKEN", "test-token");
  delete process.env.MENTORA_OPEN_EMAIL;
  h.userHit = false;
  h.snapshot = null;
  h.logEvent.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("open/plan：USER_ID 有值但解析不到用户必须显式 404", () => {
  it("无效 USER_ID + 未配 EMAIL + 快照也读不到 → 404 + bind-unresolved 留痕（不再 200 空数据）", async () => {
    vi.stubEnv("MENTORA_OPEN_USER_ID", "ghost-id");
    const res = await GET(makeReq());
    expect(res.status).toBe(404); // 修复前：200 + ok:true + 空任务列表
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("找不到绑定的用户");
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ ev: "open", msg: "bind-unresolved" }));
  });

  it("无效 USER_ID 但 data/<userId>.json 命中（UUID 直填兼容路径）→ 仍 200 放行", async () => {
    vi.stubEnv("MENTORA_OPEN_USER_ID", "uuid-compat");
    h.snapshot = { updatedAt: "2026-11-08T00:00:00.000Z", data: { goals: [], knowledge: [] } };
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("users/ 档案命中（bound=true）但快照还没同步过 → 仍 200 空态（新用户不受影响）", async () => {
    vi.stubEnv("MENTORA_OPEN_USER_ID", "userhash");
    h.userHit = true;
    h.snapshot = null;
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.counts.tasks).toBe(0);
    expect(h.logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ msg: "bind-unresolved" }));
  });
});
