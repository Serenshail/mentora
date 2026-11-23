import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteResponse } from "../server/remote-response";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe("remote database body budget",()=>{
  it("times out a body stalled after successful headers and cancels its reader",async()=>{
    vi.useFakeTimers();const cancel=vi.fn();
    const body=new ReadableStream({cancel});
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(body)));
    const promise=remoteResponse("https://example.invalid",{},5000);
    const assertion=expect(promise).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(5001);await assertion;
    expect(cancel).toHaveBeenCalledOnce();expect(body.locked).toBe(false);
  });
  it("keeps status and JSON for ordinary responses and clears its timer",async()=>{
    vi.useFakeTimers();vi.stubGlobal("fetch",vi.fn(async()=>Response.json({result:42},{status:201})));
    const response=await remoteResponse("https://example.invalid",{},5000);
    expect(response.status).toBe(201);expect(await response.json()).toEqual({result:42});expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds an endless body even when chunks keep arriving",async()=>{
    let count=0;const cancel=vi.fn();
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({pull(c){count++;c.enqueue(new Uint8Array(1024*1024));},cancel}))));
    await expect(remoteResponse("https://example.invalid",{},5000)).rejects.toThrow("过大");
    expect(count).toBeLessThan(20);expect(cancel).toHaveBeenCalledOnce();
  });
});
