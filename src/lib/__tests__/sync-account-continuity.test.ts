import { beforeEach, describe, expect, it, vi } from "vitest";
const h=vi.hoisted(()=>({state:{} as any}));
vi.mock("@/lib/store",()=>({useAppStore:{getState:()=>h.state,setState:vi.fn(),subscribe:()=>()=>{}},setStoreUser:vi.fn()}));
import { bootSync, syncAfterLogin, pushCloud, useAuthStore, useSyncStatus, markSyncWatermark, getSyncWatermarkTs } from "../auth-client";
const fetchMock=vi.fn();const disk=new Map<string,string>();
const cloud=()=>Response.json({data:{knowledge:[{id:"n",title:"A",body:"A"}]},updatedAt:"2026-11-15T10:00:00Z"});
beforeEach(()=>{
  disk.clear();fetchMock.mockReset();vi.stubGlobal("fetch",fetchMock);
  vi.stubGlobal("localStorage",{getItem:(k:string)=>disk.get(k)??null,setItem:(k:string,v:string)=>disk.set(k,v),removeItem:(k:string)=>disk.delete(k)});
  h.state={_storeUserId:"a",goals:[],knowledge:[],folders:[],books:[],sessions:[],agentSessions:[],customPersonas:[],settings:{},importData:vi.fn(()=>true)};
  useAuthStore.setState({user:{userId:"a",email:"a@example.invalid",name:"A"}});
  useSyncStatus.setState({status:"idle"});
});
describe("account continuity during asynchronous sync",()=>{
  it("preserves local edits when an old watermark has no account ownership",async()=>{
    disk.set("mentora-sync-choice","2026-11-15T09:00:00Z");h.state.knowledge=[{id:"local",body:"offline edit"}];fetchMock.mockResolvedValueOnce(cloud());
    expect(await bootSync()).toBe("unsafe");expect(h.state.importData).not.toHaveBeenCalled();
  });
  it("refuses to replace a newly created local book with an older cloud snapshot", async () => {
    h.state.books = [{ id: "local-book" }];
    disk.set("mentora-sync-choice:a", "2026-11-15T09:00:00Z");
    disk.set("mentora-sync-choice:a:dirty", "edit-before-reload");
    fetchMock.mockResolvedValueOnce(cloud());

    expect(await bootSync()).toBe("unsafe");
    expect(h.state.importData).not.toHaveBeenCalled();
    expect(h.state.books).toEqual([{ id: "local-book" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not let a late profile save restore the previous account",async()=>{
    let finish!:(r:Response)=>void;fetchMock.mockImplementation(()=>new Promise<Response>(r=>finish=r));
    const run=useAuthStore.getState().updateProfile({name:"Updated"});
    useAuthStore.setState({user:{userId:"b",email:"b@example.invalid",name:"B"}});
    finish(Response.json({user:{userId:"a",name:"Updated"}}));
    await expect(run).rejects.toThrow("账户已切换");expect(useAuthStore.getState().user?.userId).toBe("b");
  });
  it("does not apply a late redemption result to another account",async()=>{
    let finish!:(r:Response)=>void;fetchMock.mockImplementation(()=>new Promise<Response>(r=>finish=r));
    const run=useAuthStore.getState().redeem("fixture");useAuthStore.setState({user:{userId:"b",email:"b@example.invalid",name:"B"}});
    finish(Response.json({entitlement:{status:"active",expiresAt:"2099-01-01"}}));await expect(run).rejects.toThrow("账户已切换");
    expect(useAuthStore.getState().user?.entitlement).toBeUndefined();
  });
  it("coalesces concurrent boot requests for the same account",async()=>{
    let finish!:(r:Response)=>void;fetchMock.mockImplementation(()=>new Promise<Response>(r=>finish=r));
    const a=bootSync(),b=bootSync();expect(fetchMock).toHaveBeenCalledTimes(1);finish(cloud());
    expect(await Promise.all([a,b])).toEqual(["ready","ready"]);expect(h.state.importData).toHaveBeenCalledTimes(1);
  });
  it.each(["boot","login"])("drops late %s responses after switching accounts",async(kind)=>{
    let finish!:(r:Response)=>void;fetchMock.mockImplementation(()=>new Promise<Response>(r=>finish=r));
    const run=kind==="boot"?bootSync():syncAfterLogin();h.state._storeUserId="b";finish(cloud());await run;
    expect(h.state.importData).not.toHaveBeenCalled();expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("failed reads keep the auto-upload gate closed and allow a later retry",async()=>{
    fetchMock.mockRejectedValueOnce(new Error("offline"));expect(await bootSync()).toBe("unsafe");
    expect(useSyncStatus.getState().status).toBe("error");fetchMock.mockResolvedValueOnce(Response.json({data:null}));expect(await bootSync()).toBe("ready");
  });
  it("invalid snapshots cannot enable auto-upload",async()=>{
    h.state.importData.mockReturnValue(false);fetchMock.mockResolvedValueOnce(cloud());expect(await bootSync()).toBe("unsafe");
  });
  it("queued pushes never migrate from their original account to a new account",async()=>{
    let finish!:(r:Response)=>void;fetchMock.mockImplementation(()=>new Promise<Response>(r=>finish=r));
    const first=pushCloud(),queued=pushCloud();await vi.waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(1));
    h.state._storeUserId="b";finish(Response.json({updatedAt:"now"}));expect(await first).toBe(false);expect(await queued).toBe(false);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not retry identical conflict or authentication failures",async()=>{
    fetchMock.mockResolvedValue(Response.json({error:"conflict"},{status:409}));expect(await pushCloud()).toBe(false);expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["x-mentora-user-id"]).toBe("a");
  });
  it("keeps synchronization watermarks separate between accounts",()=>{
    markSyncWatermark("2026-11-15T10:00:00Z");const at=getSyncWatermarkTs();h.state._storeUserId="b";expect(getSyncWatermarkTs()).toBe(0);h.state._storeUserId="a";expect(getSyncWatermarkTs()).toBe(at);
  });
});
