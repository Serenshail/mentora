import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/* 回归锁（2026-11 复核）：两个公开端点仍用「先全量缓冲再判大小」的旧读法——
 *
 * track POST：`req.text()` 把整个请求体缓冲进内存才量得出大小，而 track 匿名可达
 * （account=anon）且是本组公开端点里限流最松的（60 突发/每秒回填 1）。自托管
 * （Caddy 默认不限 body）下攻击者用限流额度内的请求发 GB 级 chunked 包即可制造
 * 内存尖峰（body-limit.ts 头注释的威胁模型）。修复：readTextBodyWithLimit
 * （512KB→8KB 声明闸+流式终闸），超限回 413、空体回 400（与旧 catch(()=>"") 语义一致）。
 *
 * trial-request POST：`req.json()` 先全量缓冲+解析再截断 email/contact/note，同款
 * 反模式（限流 3 突发/3 每分回填是三者中最紧，故风险低一档，但换 IP 仍可并发大包）。
 * 修复：readJsonBody（声明闸+流式终闸），超标回 413；解析失败回 {} → 走邮箱校验 400，
 * 与旧 json().catch(() => ({})) 行为逐字对齐。 */

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

vi.mock("@/lib/server/auth", () => ({
  getSessionUser: vi.fn(async () => null),
}));

vi.mock("@/lib/server/db", () => ({
  dbEventSave: vi.fn(async () => undefined),
  emailHash: vi.fn(() => "h"),
  dbPut: vi.fn(async () => undefined),
}));

vi.mock("@/lib/server/config", () => ({
  logEvent: vi.fn(() => undefined),
}));

import { POST as trackPOST } from "../../app/api/track/route";
import { POST as trialPOST } from "../../app/api/trial-request/route";
import { dbPut } from "@/lib/server/db";

/** 构造带可迭代 body 的请求替身（模拟无 content-length 的 chunked 包） */
function reqWithBody(parts: Uint8Array[], headers?: Record<string, string>) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
  return { headers: new Headers(headers ?? {}), body: stream } as unknown as import("next/server").NextRequest;
}

const KB = 1024;
const bytes = (n: number, fill = 97) => new Uint8Array(n).fill(fill);

describe("track POST 请求体体积闸（声明闸 + 流式终闸）", () => {
  it("content-length 超过 8KB → 413，请求体一个字节都不读", async () => {
    const textSpy = vi.fn();
    const req = {
      headers: new Headers({ "content-length": String(9 * KB) }),
      text: textSpy,
    } as unknown as import("next/server").NextRequest;
    const res = await trackPOST(req);
    expect(res.status).toBe(413);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("无声明值的 chunked 大包：累计过 8KB 即断流返回 413，不再把整个包拉进内存", async () => {
    let pulls = 0;
    async function* chunked() {
      pulls++;
      yield bytes(5 * KB); // 5KB：未超限，继续
      pulls++;
      yield bytes(5 * KB); // 累计 10KB：超限，必须在这里停
      pulls++;
      yield bytes(16); // 旧 req.text() 语义会把这个也拉进来
    }
    const res = await trackPOST({ headers: new Headers(), body: chunked() } as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(413);
    expect(pulls).toBe(2); // 流式终闸：第 2 块就断，第 3 块从未被拉取
  });

  it("空体仍回 400（与旧 catch(() => \"\") → !raw 语义一致）", async () => {
    const res = await trackPOST({ headers: new Headers(), body: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }) } as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
  });

  it("正常小载荷不受闸影响：合法事件名 → 204", async () => {
    const body = JSON.stringify({ n: "page_view", p: { a: 1 }, path: "/", t: 1 });
    const res = await trackPOST(reqWithBody([new TextEncoder().encode(body)]));
    expect(res.status).toBe(204);
  });
});

describe("trial-request POST 请求体体积闸（readJsonBody）", () => {
  beforeEach(() => {
    vi.mocked(dbPut).mockClear();
  });

  it("content-length 超过 512KB → 413，json() 一个字节都不读", async () => {
    const jsonSpy = vi.fn();
    const req = {
      headers: new Headers({ "content-length": String(600 * KB) }),
      json: jsonSpy,
    } as unknown as import("next/server").NextRequest;
    const res = await trialPOST(req);
    expect(res.status).toBe(413);
    expect(jsonSpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("太大");
  });

  it("无声明值的 chunked 大包（600KB）→ 413", async () => {
    const res = await trialPOST(reqWithBody([bytes(600 * KB)]));
    expect(res.status).toBe(413);
  });

  it("正常留资载荷不受闸影响：合法邮箱 → ok，且 email 规范化照旧", async () => {
    const req = {
      headers: new Headers({ "content-length": "40" }),
      json: vi.fn(async () => ({ email: "  A@B.com ", contact: "wx", note: "hi" })),
    } as unknown as import("next/server").NextRequest;
    const res = await trialPOST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const rec = vi.mocked(dbPut).mock.calls[0][1] as { email: string };
    expect(rec.email).toBe("a@b.com");
  });

  it("解析失败回 {} → 走邮箱校验 400（与旧 json().catch(() => ({})) 行为对齐）", async () => {
    const res = await trialPOST({
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("not-json{"));
          c.close();
        },
      }),
    } as unknown as import("next/server").NextRequest);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("邮箱");
  });
});
