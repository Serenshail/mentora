import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

vi.mock("server-only", () => ({}));

/* 设备令牌与登录闸（v27 · 插件重构 M1）：
 * 用内存 KV 替身跑，不碰任何远端库。覆盖四件会真出事的事：
 *  1) 令牌签发→校验闭环与篡改/过期/注销拒绝；
 *  2) 设备容量上限挤最旧（老令牌立即失效）；
 *  3) 会话 cookie 优先、设备令牌兜底的 verifyAnyAuth 顺序；
 *  4) 账号锁：8 败锁定、窗口过期复位、成功清零。
 * 另有源码扫描护栏：sync FIELDS 与 localData 必须含 agentSessions（防两处漂移）。 */

const store = new Map<string, unknown>();

vi.mock("../server/db", () => ({
  dbGet: vi.fn(async (key: string) => store.get(key) ?? null),
  dbPut: vi.fn(async (key: string, val: unknown) => {
    store.set(key, val);
    return {};
  }),
  dbDelete: vi.fn(async (key: string) => {
    store.delete(key);
  }),
  dbList: vi.fn(async () => []),
  emailHash: (email: string) =>
    crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24),
}));

vi.mock("../server/auth", () => ({
  verifySession: vi.fn(async () => null),
  verifyPassword: (password: string, salt: string, hash: string) => {
    const test = crypto.scryptSync(password, salt, 64);
    const saved = Buffer.from(hash, "hex");
    return test.length === saved.length && crypto.timingSafeEqual(test, saved);
  },
  hashPassword: (password: string) => {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
  },
}));

import { verifySession } from "../server/auth";
import {
  parseDeviceToken,
  issueDeviceToken,
  verifyDeviceAuth,
  verifyAnyAuth,
  type DeviceRecord,
} from "../server/device-auth";
import { bumpFail, getFailState, clearFail } from "../server/login-guard";

const KEY = crypto.createHash("sha256").update("u@x.dev").digest("hex").slice(0, 24);
const userPath = `users/${KEY}.json`;
const req = (token: string | null) => ({
  headers: { get: (name: string) => (name === "x-device-token" ? token : null) },
});

function seedUser(devices?: DeviceRecord[]) {
  store.set(userPath, { userId: "u1", email: "u@x.dev", name: "测试", devices: devices ?? [] });
}

beforeEach(() => {
  store.clear();
  vi.mocked(verifySession).mockReset();
  vi.mocked(verifySession).mockImplementation(async () => null);
});

describe("parseDeviceToken", () => {
  it("接受 d1.<24hex>.<secret> 形态，拒绝其余", () => {
    const raw = `d1.${KEY}.${"s".repeat(43)}`;
    expect(parseDeviceToken(raw)?.key).toBe(KEY);
    expect(parseDeviceToken(null)).toBeNull();
    expect(parseDeviceToken("x1.a.b")).toBeNull();
    expect(parseDeviceToken(`d1.shortkey.${"s".repeat(43)}`)).toBeNull();
    expect(parseDeviceToken(`d1.${KEY}.short`)).toBeNull();
    expect(parseDeviceToken(`d1.${KEY}.a.b`)).toBeNull(); // 段数不对
  });
});

describe("设备令牌闭环", () => {
  it("签发→落档→校验通过，返回会话形状", async () => {
    seedUser();
    const { token, record, devices } = issueDeviceToken(KEY, {}, "Obsidian 插件");
    expect(devices).toHaveLength(1);
    expect(record.hash).not.toContain(token); // 档案里只有 sha256，原文不落盘
    store.set(userPath, { userId: "u1", email: "u@x.dev", name: "测试", devices });
    const user = await verifyDeviceAuth(req(token));
    expect(user).toEqual({ userId: "u1", email: "u@x.dev", name: "测试" });
  });

  it("篡改的令牌、过期令牌、已注销账号一律拒绝", async () => {
    seedUser();
    const { token, devices } = issueDeviceToken(KEY, {}, "d");
    store.set(userPath, { userId: "u1", email: "u@x.dev", name: "测试", devices });
    expect(await verifyDeviceAuth(req(token + "x"))).toBeNull();

    const expired = issueDeviceToken(KEY, {}, "d", Date.now() - 91 * 86_400_000);
    store.set(userPath, { userId: "u1", email: "u@x.dev", name: "测试", devices: [expired.record] });
    expect(await verifyDeviceAuth(req(expired.token))).toBeNull();

    store.delete(userPath);
    expect(await verifyDeviceAuth(req(token))).toBeNull();
  });

  it("容量 10 台：挤最旧，第 1 个令牌在签发第 11 台后失效", async () => {
    seedUser();
    let devices: DeviceRecord[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = issueDeviceToken(KEY, { devices }, `设备${i}`);
      devices = r.devices;
      tokens.push(r.token);
    }
    expect(devices).toHaveLength(10);
    store.set(userPath, { userId: "u1", email: "u@x.dev", name: "测试", devices });
    expect(await verifyDeviceAuth(req(tokens[0]))).toBeNull(); // 最旧被挤
    expect(await verifyDeviceAuth(req(tokens[10]))).not.toBeNull();
  });

  it("verifyAnyAuth：会话优先，无会话才走设备令牌", async () => {
    seedUser();
    const { token, devices } = issueDeviceToken(KEY, {}, "d");
    store.set(userPath, { userId: "u1", email: "u@x.dev", name: "测试", devices });

    vi.mocked(verifySession).mockResolvedValueOnce({ userId: "s1", email: "s@x.dev", name: "会话" });
    expect(await verifyAnyAuth(req(token))).toEqual({ userId: "s1", email: "s@x.dev", name: "会话" });

    expect(await verifyAnyAuth(req(token))).toEqual({ userId: "u1", email: "u@x.dev", name: "测试" });
    expect(await verifyAnyAuth(req(null))).toBeNull();
  });
});

describe("登录闸（login-guard）", () => {
  it("8 败锁定，clearFail 解除", async () => {
    for (let i = 0; i < 8; i++) await bumpFail("v@x.dev");
    const st = await getFailState("v@x.dev");
    expect(st?.until ?? 0).toBeGreaterThan(Date.now());
    await clearFail("v@x.dev");
    expect(await getFailState("v@x.dev")).toBeNull();
  });

  it("窗口过期复位：旧窗口的失败不累计进新窗口", async () => {
    await bumpFail("u@x.dev"); // 先落一个键，拿到真实存储键名（不猜 deployEnv 的取值）
    const key = [...store.keys()].find((k) => k.startsWith("loginfail/"));
    expect(key).toBeTruthy();
    store.set(key!, { n: 7, first: Date.now() - 11 * 60_000, until: 0 });
    await bumpFail("u@x.dev");
    const st = await getFailState("u@x.dev");
    expect(st?.n).toBe(1); // 复位后重新起算，而不是 8
    expect(st?.until ?? 0).toBe(0);
  });
});

describe("源码扫描护栏（防 agentSessions 两处漂移）", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("sync 路由 FIELDS 含 agentSessions 且两个 handler 用 verifyAnyAuth", () => {
    const src = read("../../app/api/sync/route.ts");
    expect(src).toMatch(/FIELDS = \[[^\]]*"agentSessions"/);
    expect(src.match(/verifyAnyAuth\(req\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/verifySession/); // 不许回退
  });

  it("auth-client localData 上传 agentSessions 且不含 agentActiveId", () => {
    const src = read("../auth-client.ts");
    const fn = src.match(/function localData\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain("agentSessions");
    expect(fn).not.toContain("agentActiveId"); // 只扫上传函数体，注释/其他 hook 不在射程
  });
});
