import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* mail.ts 是服务端模块（import "server-only"），vitest 里豁免护栏 */
vi.mock("server-only", () => ({}));

/* ============ T-069 发信双轨回归锁（HW-S-07）：EMAIL_CHANNEL 切换矩阵 ============ */

const ENV_KEYS = ["EMAIL_CHANNEL", "RESEND_API_KEY", "SMN_ENDPOINT_URL", "SMN_TOKEN"] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

async function loadMail(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return import("../server/mail");
}

describe("emailChannel()/hasSmtp()：通道判定", () => {
  it("缺省 → resend（历史行为不变）；未配任何凭据 hasSmtp=false", async () => {
    const m = await loadMail();
    expect(m.emailChannel()).toBe("resend");
    expect(m.hasSmtp()).toBe(false);
  });

  it("EMAIL_CHANNEL=huawei 且 SMN_ENDPOINT_URL 已配 → hasSmtp=true（任一通道可用语义）", async () => {
    const m = await loadMail({ EMAIL_CHANNEL: "huawei", SMN_ENDPOINT_URL: "https://fg.example/relay" });
    expect(m.emailChannel()).toBe("huawei");
    expect(m.hasSmtp()).toBe(true);
  });

  it("EMAIL_CHANNEL=huawei 但中继未配、RESEND 也未配 → hasSmtp 仍 false（dev 模式保持）", async () => {
    const m = await loadMail({ EMAIL_CHANNEL: "huawei" });
    expect(m.hasSmtp()).toBe(false);
  });

  it("仅配 RESEND_API_KEY（无 EMAIL_CHANNEL）→ hasSmtp=true，通道判定仍 resend", async () => {
    const m = await loadMail({ RESEND_API_KEY: "re_test" });
    expect(m.emailChannel()).toBe("resend");
    expect(m.hasSmtp()).toBe(true);
  });
});

describe("sendEmail()：路由到通道", () => {
  it("huawei 通道：POST 到中继端点，携带 to/subject/html 与 Bearer token", async () => {
    const m = await loadMail({
      EMAIL_CHANNEL: "huawei",
      SMN_ENDPOINT_URL: "https://fg.example/relay",
      SMN_TOKEN: "tok123",
    });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    const r = await m.sendEmail("u@example.com", "周报", "<p>hi</p>");
    expect(r.sent).toBe(true);
    expect(calls[0].url).toBe("https://fg.example/relay");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer tok123" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      to: "u@example.com", subject: "周报", html: "<p>hi</p>",
    });
  });

  it("huawei 中继 500 → 抛错（失败纪律与 Resend 一致：异常上抛由调用方决定吞否）", async () => {
    const m = await loadMail({ EMAIL_CHANNEL: "huawei", SMN_ENDPOINT_URL: "https://fg.example/relay" });
    vi.stubGlobal("fetch", async () => new Response("err", { status: 500 }));
    await expect(m.sendEmail("u@example.com", "s", "<p>x</p>")).rejects.toThrow("邮件发送失败");
  });

  it("EMAIL_CHANNEL=huawei 但中继未配而 RESEND 已配 → 回落 Resend（可切回，配置切换即生效）", async () => {
    const m = await loadMail({ EMAIL_CHANNEL: "huawei", RESEND_API_KEY: "re_test" });
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    const r = await m.sendEmail("u@example.com", "s", "<p>x</p>");
    expect(r.sent).toBe(true);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(calls[0].init.body)).from).toContain("Mentora");
  });

  it("无任何通道 → dev 模式 sent:false，不发起网络请求", async () => {
    const m = await loadMail();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await m.sendEmail("u@example.com", "s", "<p>x</p>");
    expect(r.sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});