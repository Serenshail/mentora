import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* 到期提醒 cron 的「到期当天」档回归锁：
 * entitlement.ts 的 daysLeft 永不为 0（diff>0 → ceil≥1，diff<0 → floor≤-1），
 * REMIND_DAYS 里的 0 档若直接 has(ent.daysLeft) 永不命中——「到期当天」邮件是死代码。
 * 修复口径：daysLeft===-1（过期后未满 24h，daily cron 必然落进这个窗口）映射为 0 档。
 * 锁四件事：
 *  1) daysLeft=-1 → 发「今天到期」邮件（0 档复活，修复前这里什么都不发）；
 *  2) daysLeft=-2 → 不发（过期档只发一次，不会天天轰炸）；
 *  3) 提前档 7/3/1 天照旧发信，且当天已发过（marker 存在）不重发；
 *  4) legacy（无到期时间）与不在档位的天数（如 2）照旧跳过。 */

const store = new Map<string, unknown>();
const sentEmails: { to: string; subject: string }[] = [];

vi.mock("../server/db", () => ({
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
  dbGet: vi.fn(async (path: string) => (store.has(path) ? structuredClone(store.get(path)) : null)),
  dbPut: vi.fn(async (path: string, value: unknown) => {
    store.set(path, structuredClone(value));
    return { sha: "mem" };
  }),
  dbPutIfAbsent: vi.fn(async () => true),
  dbDelete: vi.fn(async (path: string) => {
    store.delete(path);
  }),
  dbList: vi.fn(async (dir: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => ({ name: k.slice(dir.length + 1), sha: "mem" }))
  ),
}));

vi.mock("../server/mail", () => ({
  sendEmail: vi.fn(async (to: string, subject: string) => {
    sentEmails.push({ to, subject });
    return { sent: true };
  }),
}));

vi.mock("../server/config", () => ({
  logEvent: vi.fn(),
}));

import { GET } from "../../app/api/cron/expiry-reminder/route";

const DAY = 86_400_000;
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
  vi.stubEnv("CRON_SECRET", "test-secret");
  vi.stubEnv("APP_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("expiry-reminder：到期当天档（daysLeft=-1 → 0）", () => {
  it("过期未满 24h（daysLeft=-1）→ 发「今天到期」邮件并写当日 marker", async () => {
    seedUser("due-today@x.com", -4); // 4 小时前到期
    const res = await GET(req());
    const body = (await res.json()) as { sent: number };
    expect(body.sent).toBe(1);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toBe("Mentora 会员今天到期（数据都还在）");
    expect(store.get(MARKER("due-today@x.com"))).toMatchObject({ sent: true });
  });

  it("过期超过 24h（daysLeft=-2）→ 不发，过期档只发一次", async () => {
    seedUser("gone@x.com", -26); // 26 小时前到期
    const res = await GET(req());
    const body = (await res.json()) as { sent: number; skipped: number };
    expect(body.sent).toBe(0);
    expect(sentEmails).toHaveLength(0);
    expect(body.skipped).toBe(0); // 不在档位，连 marker 都不写
  });

  it("提前档 7/3/1 天照旧发信，主题仍带剩余天数", async () => {
    const cases: [string, number, string][] = [
      ["week@x.com", 7 * 24, "Mentora 会员还有 7 天到期"],
      ["three@x.com", 3 * 24, "Mentora 会员还有 3 天到期"],
      ["one@x.com", 24, "Mentora 会员还有 1 天到期"],
    ];
    for (const [email, hours, subject] of cases) seedUser(email, hours);
    const res = await GET(req());
    const body = (await res.json()) as { sent: number };
    expect(body.sent).toBe(3);
    expect(sentEmails.map((e) => e.subject)).toEqual(cases.map(([, , subject]) => subject));
  });

  it("同一用户当天已发过（marker 存在）→ skipped，不重发", async () => {
    seedUser("dup@x.com", -4);
    store.set(MARKER("dup@x.com"), { at: new Date().toISOString(), sent: true });
    const res = await GET(req());
    const body = (await res.json()) as { sent: number; skipped: number };
    expect(body.sent).toBe(0);
    expect(body.skipped).toBe(1);
    expect(sentEmails).toHaveLength(0);
  });

  it("legacy（无到期时间）与不在档位的天数（如 2 天）照旧跳过", async () => {
    store.set(KEY("legacy@x.com"), { email: "legacy@x.com", plan: "founder" });
    seedUser("mid@x.com", 2 * 24); // daysLeft=2，不在 REMIND_DAYS
    const res = await GET(req());
    const body = (await res.json()) as { sent: number };
    expect(body.sent).toBe(0);
    expect(sentEmails).toHaveLength(0);
  });
});
