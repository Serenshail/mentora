import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../ai/client";
vi.mock("@/lib/store", () => ({ useAppStore: {getState: () => ({settings:{provider:"demo",apiKey:""}})} }));
afterEach(() => vi.unstubAllGlobals());
describe("client stream lifecycle", () => {
  it("cancels the response when an error event arrives before EOF", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"t":"e","v":"failed"}\n'));},cancel});
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(body)));
    await expect(streamChat({messages:[],onDelta:()=>{}})).rejects.toThrow("failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("releases a successful response reader", async () => {
    const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"t":"d","v":"hello"}\n{"t":"end"}\n'));c.close();}});
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(body)));
    await expect(streamChat({messages:[],onDelta:()=>{}})).resolves.toBe("hello");
    expect(body.locked).toBe(false);
  });
});
