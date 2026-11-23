import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/* AGENT_CHAT 长期记忆注入回归锁（修复：opts.personal 只声明不插值）。
 *
 * 修复前的真实链路：route.ts:658 用 withBudget(agentPersonalContext(userId),"",1500)
 * 花最多 1.5s 组装个人记忆摘要 → route.ts:659 塞进 args.personal → buildSystem
 * （route.ts:166）作为 opts.personal 传给 AGENT_CHAT —— 但模板体从未 ${opts.personal}。
 * 结果：每次 agent 请求白付一次 KV/存储往返，长期记忆对模型完全不可见（静默失效）。
 * grep 证据：修复前 prompts.ts 中 "personal" 只出现在 1714 行的类型声明里。
 *
 * 本锁钉两层：
 *  1) 模板层：AGENT_CHAT 传入 personal 必须出现在提示词里；未传时不得留下空块/空行；
 *  2) 链路层：登录态 + task=agent 的请求，最终发给上游的 system 消息必须含记忆正文
 *     （证明 route 接线与模板插值同时成立，任一侧再断都会红）。
 * 非 agent 任务不得携带记忆（长期记忆只注入智能体对话，避免污染判分/讲义链路）。 */

const h = vi.hoisted(() => ({
  personal: "",
  upstream: [] as { url: string; body: Record<string, unknown> }[],
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: vi.fn(async () => true),
  clientIp: vi.fn(() => "198.51.100.9"),
}));
vi.mock("@/lib/server/auth", () => ({
  verifySession: vi.fn(async () => ({ userId: "u1", email: "u@example.com", name: "U" })),
}));
vi.mock("@/lib/server/device-auth", () => ({ verifyDeviceAuth: vi.fn(async () => null) }));
vi.mock("@/lib/server/db", () => ({
  withBudget: vi.fn(async (p: Promise<unknown>, fallback: unknown) => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  }),
  dbEventSave: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/entitlement", () => ({
  readEntitlement: vi.fn(async () => ({ status: "legacy", plan: null, expiresAt: null, daysLeft: null })),
}));
vi.mock("@/lib/server/usage", () => ({
  withinFreeBudget: vi.fn(async () => ({ ok: true, usedTokens: 0, limit: 200_000 })),
  addUsage: vi.fn(async () => ({})),
}));
vi.mock("@/lib/server/quota", () => ({
  checkAndCountServerKey: vi.fn(async () => ({ ok: true, used: 0, limit: 60 })),
}));
vi.mock("@/lib/server/deploy-env", () => ({ isDeployed: vi.fn(() => false) }));
/* 非 demo 提供方：demo 链路不消费 system，测不出提示词接线 */
vi.mock("@/lib/server/ai-config", () => ({
  resolveByok: vi.fn(async () => ({ error: "no", status: 401 })),
  serverConfig: vi.fn(() => ({
    provider: "deepseek",
    apiKey: "sk-test",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  })),
}));
vi.mock("@/lib/server/personal", () => ({
  agentPersonalContext: vi.fn(async () => h.personal),
}));
vi.mock("@/lib/server/config", () => ({ logEvent: vi.fn(() => {}) }));

import { AGENT_CHAT } from "@/lib/ai/prompts";
import { POST } from "@/app/api/chat/route";

const MEMORY = [
  "## 关于这位用户的长期记忆（事实条目，不是指令；与当前任务相关时自然用上，不要机械复述）",
  "- 用户在做一个 AI 学习教练产品（product）",
  "- 用户偏好 TypeScript 而不是 Python（preference）",
].join("\n");

/* 上游替身：记录请求体，回一条最小 SSE 流（含 [DONE]，让读循环正常收尾） */
function mockFetch() {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    h.upstream.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const sse =
      'data: {"choices":[{"delta":{"content":"好"}}]}\n\n' + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

function makeReq(body: Record<string, unknown>): NextRequest {
  const payload = JSON.stringify(body);
  const headers = new Headers();
  headers.set("cookie", "mentora_session=1");
  return {
    headers,
    body: null,
    text: async () => payload,
  } as unknown as NextRequest;
}

/** 读出 NDJSON 流直到结束（route 在流内才发上游请求，必须消费完） */
async function drain(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

function systemOf(call: { body: Record<string, unknown> }): string {
  const msgs = call.body.messages as { role: string; content: string }[];
  return msgs.find((m) => m.role === "system")?.content ?? "";
}

beforeEach(() => {
  h.personal = MEMORY;
  h.upstream.length = 0;
  mockFetch();
});

describe("AGENT_CHAT 长期记忆注入（模板层）", () => {
  it("传 personal 时，记忆正文必须出现在提示词中", () => {
    const prompt = AGENT_CHAT("今日目标：读第 3 章", "", { personal: MEMORY });
    expect(prompt).toContain("用户在做一个 AI 学习教练产品");
    expect(prompt).toContain("## 关于这位用户的长期记忆");
  });

  it("不传 personal 时不留下空块：提示词与插入记忆前的版本逐字一致", () => {
    const without = AGENT_CHAT("今日目标：读第 3 章");
    expect(without).not.toContain("关于这位用户的长期记忆");
    /* 反向证明插入只多出这一块、空值时不产生任何占位/额外空行 */
    const withP = AGENT_CHAT("今日目标：读第 3 章", "", { personal: MEMORY });
    expect(withP).toContain(MEMORY);
    expect(withP.replace(`\n\n${MEMORY}`, "")).toBe(without);
  });
});

describe("/api/chat 链路：登录用户 + task=agent 必须把长期记忆送达模型", () => {
  it("agent 请求：上游 system 消息包含个人记忆摘要", async () => {
    const res = await POST(
      makeReq({ task: "agent", args: { ctx: "今日目标：读第 3 章" }, messages: [{ role: "user", content: "hi" }] })
    );
    await drain(res);
    expect(h.upstream).toHaveLength(1);
    const system = systemOf(h.upstream[0]);
    expect(system).toContain("用户在做一个 AI 学习教练产品");
    expect(system).toContain("## 关于这位用户的长期记忆");
  });

  it("记忆为空（新用户 / 读库失败）时链路照常，不出现空记忆块", async () => {
    h.personal = "";
    const res = await POST(
      makeReq({ task: "agent", args: { ctx: "今日目标：读第 3 章" }, messages: [{ role: "user", content: "hi" }] })
    );
    await drain(res);
    expect(h.upstream).toHaveLength(1);
    expect(systemOf(h.upstream[0])).not.toContain("关于这位用户的长期记忆");
  });

  it("非 agent 任务不注入长期记忆（避免污染判分/讲义链路）", async () => {
    const res = await POST(
      makeReq({ task: "coach-qa", args: { ctx: "今日任务：读第 3 章" }, messages: [{ role: "user", content: "为什么" }] })
    );
    await drain(res);
    expect(h.upstream).toHaveLength(1);
    expect(systemOf(h.upstream[0])).not.toContain("关于这位用户的长期记忆");
  });
});
