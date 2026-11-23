import type { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/server/rate-limit", () => ({
  rateLimitPersistent: async () => true,
  clientIp: () => "fixture",
}));
vi.mock("@/lib/server/url-guard", () => ({
  assertSafePublicUrl: async () => ({ ok: true }),
}));

import { POST } from "@/app/api/linkcheck/route";

afterEach(() => vi.unstubAllGlobals());

it("rejects empty and soft-404 resources even when their HTTP status is successful", async () => {
  const contentType = { "content-type": "text/html; charset=utf-8" };
  const pages = new Map([
    ["https://example.org/empty", new Response(null, { status: 204 })],
    ["https://example.org/blank", new Response(" \n ", { headers: contentType })],
    ["https://example.org/missing", new Response("<title>404 Not Found</title>", { headers: contentType })],
    ["https://example.org/lesson", new Response("<title>听力练习</title><main>练习资料</main>", { headers: contentType })],
  ]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => pages.get(url)));
  const request = { json: async () => ({ urls: [...pages.keys()] }) } as NextRequest;
  const response = await POST(request);
  const { results } = await response.json();

  expect(results.map(({ ok, dead }: { ok: boolean; dead: boolean }) => [ok, dead])).toEqual([
    [false, true],
    [false, true],
    [false, true],
    [true, false],
  ]);
});
