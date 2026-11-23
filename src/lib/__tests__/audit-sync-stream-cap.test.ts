import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/server/device-auth",()=>({verifyAnyAuth:async()=>({userId:"u",email:"test@example.invalid"})}));
vi.mock("@/lib/server/rate-limit",()=>({rateLimitPersistent:async()=>true,clientIp:()=>"test"}));
vi.mock("@/lib/server/config",()=>({logEvent:()=>{}}));
vi.mock("@/lib/server/db",()=>({dbGet:vi.fn(),dbPut:vi.fn(),dbList:vi.fn(),dbDelete:vi.fn(),dbChannel:()=>"d1",encrypt:(v:unknown)=>JSON.stringify(v)}));
import { POST } from "@/app/api/sync/route";
import { dbGet, dbList, dbPut } from "@/lib/server/db";
afterEach(()=>vi.clearAllMocks());
describe("sync chunked upload cap",()=>{
  it("rejects a request whose expected account differs from the signed session",async()=>{
    const req={headers:new Headers({"x-mentora-user-id":"another-account"})} as NextRequest;
    const response=await POST(req);expect(response.status).toBe(403);expect(dbPut).not.toHaveBeenCalled();
  });
  it.each([null,"2026-11-19T02:30:00.000Z"])("keeps the version of an identical snapshot (base %s)",async(baseVersion)=>{
    const version="2026-11-19T02:30:00.000Z";
    const snapshot={
      _sha:"d1",
      userId:"u",
      updatedAt:version,
      data:{goals:[],knowledge:[],books:[],sessions:[],customPersonas:[],agentSessions:[],folders:["笔记"],settings:{apiKey:""}},
    };
    vi.mocked(dbGet).mockResolvedValueOnce(snapshot);
    const req=new NextRequest("http://localhost/api/sync",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({baseVersion,data:{folders:["笔记"]}}),
    });
    const response=await POST(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ok:true,updatedAt:version});
    expect(dbPut).not.toHaveBeenCalled();
  });
  it("does not archive or report success when the database rejects the write", async () => {
    const updatedAt = "2026-11-19T02:30:00.000Z";
    const snapshot = { _sha: "expected-row", userId: "u", updatedAt, data: { folders: ["初始"] } };
    vi.mocked(dbGet).mockResolvedValueOnce(snapshot);
    vi.mocked(dbPut).mockRejectedValueOnce(Object.assign(new Error("conflict"), { name: "ConcurrentWriteError" }));
    const response = await POST(new NextRequest("http://localhost/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: updatedAt, data: { folders: ["新写"] } }),
    }));
    expect(response.status).toBe(409);
    expect(dbPut).toHaveBeenCalledWith("data/u.json", expect.anything(), expect.objectContaining({
      compareSnapshot: true, sha: "expected-row",
    }));
    expect(dbList).not.toHaveBeenCalled();
  });
  it.each(["application/json","application/x-gzip"])("stops oversized %s before reading the complete body",async(type)=>{
    let produced=0;const cancel=vi.fn();
    const body=new ReadableStream<Uint8Array>({pull(c){produced++;c.enqueue(new Uint8Array(1024*1024));},cancel});
    const req={headers:new Headers({"content-type":type}),body} as unknown as NextRequest;
    const response=await POST(req);
    expect(response.status).toBe(413);expect(produced).toBeLessThan(8);expect(cancel).toHaveBeenCalledOnce();expect(dbPut).not.toHaveBeenCalled();
  });
});
