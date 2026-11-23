import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetModules();});
async function db(){
  vi.stubEnv("DB_CHANNEL","upstash");vi.stubEnv("UPSTASH_REDIS_REST_URL","https://example.invalid");vi.stubEnv("UPSTASH_REDIS_REST_TOKEN","fixture");
  return import("../server/db");
}
describe("Redis scan completeness",()=>{
  it("never returns a partial directory after exhausting its scan budget",async()=>{
    const fetchMock=vi.fn(async()=>Response.json({result:["1",["users/a.json"]]}));vi.stubGlobal("fetch",fetchMock);
    const {dbList}=await db();await expect(dbList("users")).rejects.toThrow("未完成");expect(fetchMock).toHaveBeenCalledTimes(60);
  });
  it("removes duplicate SCAN results without hiding a complete directory",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({result:["0",["users/a.json","users/a.json"]]})));
    const {dbList}=await db();expect(await dbList("users")).toEqual([{name:"a.json",sha:"upstash"}]);
  });
});
