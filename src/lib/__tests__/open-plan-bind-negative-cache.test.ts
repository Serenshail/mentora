import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* open/plan 绑定邮箱反查的负缓存回归锁。
 * 缺陷：scanByEmail 只在「找到用户」时写 open-bind/ 缓存；MENTORA_OPEN_EMAIL 拼错/未注册
 * （一个都匹配不上）时直接 return false，什么都不缓存。插件 30/min 轮询下这个最坏路径
 * 会以限流上限持续触发 O(N) 全量解密扫描（GitHub 通道还成倍烧 API 配额）。
 * 修复后：未命中写 { miss: true, at } 到同一个 open-bind/ 键，10 分钟内直接跳过全量扫描；
 * 但「一份档案都没读成功」（通道故障/密钥错）不能负缓存，否则把故障固化成 404。 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.9"),
}));

/* vi.mock 工厂会被提升到 import 之前，闭包变量必须用 vi.hoisted 同步创建 */
const h = vi.hoisted(() => ({
  bindCache: null as unknown,
  userFiles: [] as { name: string; rec: unknown }[],
  throwOnUserRead: false,
  logEvent: vi.fn(() => {}),
  dbList: vi.fn(),
  dbPut: vi.fn(),
  dbGet: vi.fn(),
}));

vi.mock("@/lib/server/config", () => ({ logEvent: h.logEvent }));

h.dbGet.mockImplementation(async (path: string) => {
  if (path.startsWith("open-bind/")) return h.bindCache;
  if (path.startsWith("users/")) {
    if (h.throwOnUserRead) throw new Error("kv down");
    const name = path.slice("users/".length);
    return h.userFiles.find((u) => u.name === name)?.rec ?? null;
  }
  if (path.startsWith("data/")) return { data: { goals: [], knowledge: [] } };
  return null;
});
h.dbList.mockImplementation(async () => h.userFiles.map((u) => ({ name: u.name, sha: "test" })));
h.dbPut.mockImplementation(async () => ({ sha: "test" }));

vi.mock("@/lib/server/db", () => ({
  dbGet: (p: string) => h.dbGet(p),
  dbList: () => h.dbList(),
  dbPut: (...args: unknown[]) => h.dbPut(...args),
  emailHash: (s: string) => s,
}));

const { dbGet, dbList, dbPut, logEvent } = h;

import { GET } from "@/app/api/open/plan/route";

function makeReq(): NextRequest {
  return { headers: new Headers({ "x-open-token": "test-token" }) } as unknown as NextRequest;
}

const OTHER_USER = { userId: "u1", email: "someone@example.com", name: "Someone" };

beforeEach(() => {
  vi.stubEnv("MENTORA_OPEN_TOKEN", "test-token");
  delete process.env.MENTORA_OPEN_USER_ID;
  vi.stubEnv("MENTORA_OPEN_EMAIL", "typo@example.com");
  h.bindCache = null;
  h.userFiles = [{ name: "abc.json", rec: OTHER_USER }];
  h.throwOnUserRead = false;
  dbList.mockClear();
  dbPut.mockClear();
  logEvent.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("open/plan 绑定邮箱负缓存", () => {
  it("邮箱匹配不上：写负缓存（miss:true）并返回 404", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
    expect(dbList).toHaveBeenCalledTimes(1);
    const missWrite = dbPut.mock.calls.find(
      (c) => (c[1] as { miss?: boolean })?.miss === true
    );
    expect(missWrite).toBeTruthy();
    // GitHub 通道对已存在键裸 PUT 返回 422：负缓存必须能覆盖写，否则 TTL 一过永久失效
    expect((missWrite![2] as { overwriteOnConflict?: boolean })?.overwriteOnConflict).toBe(true);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ ev: "open", msg: "bind-miss" }));
  });

  it("负缓存新鲜时第二次请求不再全量扫描（插件轮询的最坏路径被截断）", async () => {
    h.bindCache = { miss: true, at: Date.now() };
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
    expect(dbList).not.toHaveBeenCalled(); // 关键：没有任何 users/ 目录扫描
    expect(dbGet.mock.calls.some((c) => String(c[0]).startsWith("users/"))).toBe(false);
  });

  it("负缓存过期（>10min）后重新扫描，恢复自愈能力", async () => {
    h.bindCache = { miss: true, at: Date.now() - 11 * 60_000 };
    await GET(makeReq());
    expect(dbList).toHaveBeenCalledTimes(1);
  });

  it("负缓存过期且用户已注册：命中后改为正缓存并返回 200", async () => {
    h.bindCache = { miss: true, at: Date.now() - 11 * 60_000 };
    h.userFiles = [{ name: "typo.json", rec: { userId: "u9", email: "typo@example.com", name: "Typo" } }];
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe("typo@example.com");
    // 正缓存同样要覆盖旧的 miss 条目（GitHub 422 语义）
    const hitWrite = dbPut.mock.calls.find((c) => (c[1] as { file?: string })?.file === "typo.json");
    expect(hitWrite).toBeTruthy();
    expect((hitWrite![2] as { overwriteOnConflict?: boolean })?.overwriteOnConflict).toBe(true);
  });

  it("档案全部读失败（通道故障）不写负缓存：故障不能被固化成 404", async () => {
    h.throwOnUserRead = true;
    await GET(makeReq());
    expect(dbList).toHaveBeenCalledTimes(1);
    expect(dbPut.mock.calls.some((c) => (c[1] as { miss?: boolean })?.miss === true)).toBe(false);
  });
});
