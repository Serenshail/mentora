import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { withBudget } from "../server/db";
afterEach(()=>vi.useRealTimers());
describe("best effort budget timers",()=>{
  it("clears the timeout on fast success and failure",async()=>{
    vi.useFakeTimers();
    expect(await withBudget(Promise.resolve(42),0)).toBe(42);
    expect(await withBudget(Promise.reject(new Error("offline")),0)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("returns the fallback when its wait budget expires",async()=>{
    vi.useFakeTimers();const pending=withBudget(new Promise<number>(()=>{}),0,100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBe(0);expect(vi.getTimerCount()).toBe(0);
  });
});
