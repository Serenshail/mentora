import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ 登录/注册/重置提交超时兜底的回归锁 ============
 * 背景：login-form.tsx submit() setBusy(true) 后，login/register/reset-password
 * 三条提交路径的 fetch 均未加 AbortSignal.timeout。busy 期间所有输入框 disabled、
 * 按钮 loading 强制禁用（ui.tsx disabled={loading||disabled}）——自托管反代挂起
 * 连接时请求悬置到浏览器默认 ~300s，整张表单锁死只能刷新。
 * 修复：三条路径统一 30s 硬超时（logout 8s / auth/me 5s 同族先例；放宽到 30s 是因为
 * 服务端 db 层 withRetry 最坏 ≈4×5s+退避 ≈22s，不能误杀慢而成功的请求）。
 *
 * vitest 无 DOM 环境（无 jsdom，同 learn-enter-ime-guard.test.ts 先例）无法渲染
 * 表单，因此采用两层锁：
 *  A) 行为锁：真实 import auth-client.ts，mock 全局 fetch，断言登录/注册请求
 *     携带 signal 且超时拒绝会向上传播（表单 finally 据此复位 busy）；
 *  B) 源码护栏：静态扫描 login-form.tsx 的 reset-password fetch 必须带 signal
 *     （防手改漂移，同 seats.test.ts 既有做法）。 */

vi.mock("@/lib/store", () => ({
  /* auth-client 顶层只用到 useAppStore 与 setStoreUser 的引用 */
  useAppStore: {
    getState: () => ({
      goals: [], knowledge: [], books: [], sessions: [],
      customPersonas: [], agentSessions: [], settings: {},
      _storeUserId: null,
      importData: () => true,
      subscribe: () => () => {},
    }),
    setState: () => {},
    subscribe: () => () => {},
  },
  setStoreUser: vi.fn(),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
/* Node 测试环境无 localStorage：logout 在 fetch 之后会清理 CHOICE_KEY（auth-client.ts:100） */
const lsStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, v),
  removeItem: (k: string) => void lsStore.delete(k),
});

import { useAuthStore } from "@/lib/auth-client";

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  useAuthStore.setState({ user: null, checking: false });
});

describe("登录/注册提交 fetch 超时兜底（行为锁）", () => {
  it("login 请求必须携带 AbortSignal 类型的 signal", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ user: { userId: "u1", email: "a@b.c", name: "a" } }));
    await useAuthStore.getState().login("a@b.c", "secret6");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("register 请求必须携带 AbortSignal 类型的 signal", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ user: { userId: "u2", email: "a@b.c", name: "a", plan: "trial", planExpiresAt: null, entitlement: null } })
    );
    await useAuthStore.getState().register("a@b.c", "secret6", "a", "INVITE1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("logout 的既有 8s 超时不得回退（本族先例的行为锁）", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await useAuthStore.getState().logout();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("登录请求挂起（signal 中止）时错误向上传播——表单 finally 据此复位 busy，不再悬置", async () => {
    let rejectFetch!: (r: unknown) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectFetch = reject; })
    );
    const p = useAuthStore.getState().login("a@b.c", "secret6");
    /* 模拟 30s 超时到点：AbortSignal.timeout 的拒绝形态是 TimeoutError DOMException */
    rejectFetch(new DOMException("signal timed out", "TimeoutError"));
    await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("reset-password 提交 fetch 超时兜底（源码护栏）", () => {
  const FORM = readFileSync(join(process.cwd(), "src/app/login/login-form.tsx"), "utf8");

  it("reset-password 的 fetch 必须带 signal 选项（防手改漂移）", () => {
    const idx = FORM.indexOf("/api/auth/reset-password");
    expect(idx).toBeGreaterThan(-1);
    /* 按花括号配平抽出 fetch 调用的选项对象，语义锚点断言、不按行号（重排不误报） */
    const braceStart = FORM.indexOf("{", idx);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < FORM.length; i++) {
      if (FORM[i] === "{") depth++;
      else if (FORM[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const call = FORM.slice(braceStart, end + 1);
    expect(call).toMatch(/signal:\s*AbortSignal\.timeout\(/);
  });

  it("login-form 不存在其它不带 signal 的裸 fetch（全表单覆盖）", () => {
    /* 抽出文件里每个 fetch( 调用体，逐个要求 signal——reset 之外若再添提交路径同样受锁 */
    const bodies: string[] = [];
    const re = /fetch\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(FORM))) {
      const braceStart = FORM.indexOf("{", m.index);
      let depth = 0;
      let end = braceStart;
      for (let i = braceStart; i < FORM.length; i++) {
        if (FORM[i] === "{") depth++;
        else if (FORM[i] === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      bodies.push(FORM.slice(braceStart, end + 1));
    }
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).toMatch(/signal:\s*AbortSignal\.timeout\(/);
    }
  });

  it("auth-client 三条提交/探测路径（login/register/logout）源码均带超时信号", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/auth-client.ts"), "utf8");
    for (const endpoint of ["/api/auth/login", "/api/auth/register", "/api/auth/logout"]) {
      const idx = src.indexOf(endpoint);
      expect(idx).toBeGreaterThan(-1);
      const window = src.slice(idx, idx + 400);
      expect(window).toMatch(/signal:\s*AbortSignal\.timeout\(/);
    }
  });
});
