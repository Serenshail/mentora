import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* 到期提醒 cron 的「全量遍历撑爆 maxDuration」回归锁：
 * 修复前 route.ts:48 串行 for-of 全量遍历 users/（每人一次加密读 + 一次标记读 + 发信），
 * 与 cron/tick/route.ts:14 记录的「全量遍历 users/ 实测 46s，会超 Vercel 60s 上限」同形。
 * 请求被平台中途杀掉后，未扫到的用户当天档位（如 daysLeft=7）永久错过——次日 daysLeft=6
 * 不在 {7,3,1,-1}，不再补发。修复口径：分块并发（CHUNK=8）+ 每块前卡 BUDGET_MS 预算，
 * 预算耗尽就停下并以 503/truncated 如实上报（调度方/运维可重试，marker 保证重跑幂等）。
 * 另锁两条静默丢信路径：
 *  - dbList 失败不得折叠成空列表（否则响应与「一个用户都没有」同形）；
 *  - marker 读失败不得当作「已发」（原 `.catch(() => "skip")` 返回 truthy 会永久丢一封）。 */

const store = new Map<string, unknown>();
const sentEmails: { to: string; subject: string }[] = [];

let listFails = false;
let markerReadFails = false;
let inFlight = 0;
let maxInFlight = 0;
/* 可控时钟偏移：让「预算耗尽」可被确定性触发（只影响 Date.now，不影响 new Date()） */
let skew = 0;
const baseNow = Date.now();
let userReads = 0;
let skewAfterUserReads = Number.POSITIVE_INFINITY;

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => {
    if (path.startsWith("reminder/")) {
      if (markerReadFails) throw new Error("kv read timeout");
      return store.has(path) ? structuredClone(store.get(path)) : null;
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      /* 让并发的块内调用真的重叠，才能观测到 maxInFlight > 1 */
      await new Promise((r) => setTimeout(r, 1));
      if (path.startsWith("users/")) {
        userReads += 1;
        if (userReads >= skewAfterUserReads) skew = 40_000;
      }
      return store.has(path) ? structuredClone(store.get(path)) : null;
    } finally {
      inFlight -= 1;
    }
  }),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbList: vi.fn(async (dir: string) => {
    if (listFails) throw new Error("kv list timeout");
    return [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }));
  }),
}));

vi.mock("../server/mail", () => ({
  sendEmail: vi.fn(async (to: string, subject: string) => {
    sentEmails.push({ to, subject });
    return { sent: true };
  }),
}));

vi.mock("../server/config", () => ({ logEvent: vi.fn() }));

import { GET } from "../../app/api/cron/expiry-reminder/route";

const KEY = (email: string) =>
  `users/${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24)}.json`;
const MARKER = (email: string) =>
  `reminder/${crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 24)}/${new Date().toISOString().slice(0, 10)}.json`;

function seedUser(email: string, hoursFromNow: number) {
  store.set(KEY(email), {
    email,
    name: email.split("@")[0],
    plan: "month",
    planExpiresAt: new Date(Date.now() + hoursFromNow * 3600_000).toISOString(),
  });
}

const req = () =>
  ({
    headers: { get: (k: string) => (k === "authorization" ? "Bearer test-secret" : null) },
  }) as unknown as import("next/server").NextRequest;

beforeEach(() => {
  store.clear();
  sentEmails.length = 0;
  listFails = false;
  markerReadFails = false;
  inFlight = 0;
  maxInFlight = 0;
  skew = 0;
  userReads = 0;
  skewAfterUserReads = Number.POSITIVE_INFINITY;
  vi.spyOn(Date, "now").mockImplementation(() => baseNow + skew);
  vi.stubEnv("CRON_SECRET", "test-secret");
  vi.stubEnv("APP_URL", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("expiry-reminder：全量遍历的时间预算与失败可见性", () => {
  it("块内并发扫描：20 个到期用户全部发信，且 dbGet 确实重叠执行", async () => {
    for (let i = 0; i < 20; i++) seedUser(`u${i}@x.com`, 7 * 24);
    const res = await GET(req());
    const body = (await res.json()) as { ok: boolean; total: number; processed: number; sent: number };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, total: 20, processed: 20, sent: 20 });
    expect(sentEmails).toHaveLength(20);
    /* 串行实现下 maxInFlight 恒为 1——这条锁住「已改成分块并发」 */
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("预算耗尽 → 503 + truncated，已处理的照常发信，未扫到的用户不写 marker", async () => {
    for (let i = 0; i < 20; i++) seedUser(`b${i}@x.com`, 7 * 24);
    /* 第 8 个用户读完后把时钟推过 BUDGET_MS，块间检查即触发截断 */
    skewAfterUserReads = 8;
    const res = await GET(req());
    const body = (await res.json()) as { ok: boolean; truncated: boolean; processed: number; sent: number };
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, truncated: true, processed: 8, sent: 8 });
    expect(sentEmails).toHaveLength(8);
    /* 被截断的 12 个用户没有当日 marker → 重跑时会补发 */
    expect(store.has(MARKER("b19@x.com"))).toBe(false);
  });

  it("截断后重跑幂等补全：已发的不重发，剩余用户全部补上（当天档位不丢）", async () => {
    for (let i = 0; i < 20; i++) seedUser(`r${i}@x.com`, 7 * 24);
    skewAfterUserReads = 8;
    expect((await GET(req())).status).toBe(503);
    expect(sentEmails).toHaveLength(8);

    /* 模拟调度方重试：预算恢复 */
    skew = 0;
    skewAfterUserReads = Number.POSITIVE_INFINITY;
    const res = await GET(req());
    const body = (await res.json()) as { ok: boolean; processed: number; sent: number; skipped: number };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, processed: 20, sent: 12, skipped: 8 });
    expect(sentEmails).toHaveLength(20);
    expect(new Set(sentEmails.map((e) => e.to)).size).toBe(20);
  });

  it("dbList 失败 → 500 + ok:false（绝不折叠成「没有用户」静默漏发）", async () => {
    seedUser("any@x.com", 7 * 24);
    listFails = true;
    const res = await GET(req());
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(sentEmails).toHaveLength(0);
  });

  it("marker 读失败 → 按「未发」处理并照常发信（不得静默丢当天档位）", async () => {
    seedUser("flaky@x.com", -4); // daysLeft=-1 → 0 档
    markerReadFails = true;
    const res = await GET(req());
    const body = (await res.json()) as { sent: number; skipped: number; failed: number };
    expect(res.status).toBe(200);
    expect(body.sent).toBe(1);
    expect(body.skipped).toBe(0);
    expect(sentEmails).toHaveLength(1);
    expect(store.get(MARKER("flaky@x.com"))).toMatchObject({ sent: true });
  });
});
