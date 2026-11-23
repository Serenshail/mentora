import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/server/rate-limit",()=>({rateLimitPersistent:async()=>true,clientIp:()=>"test"}));
vi.mock("@/lib/server/auth",()=>({verifySession:async()=>({userId:"u",email:"u@example.invalid"})}));
vi.mock("@/lib/server/device-auth",()=>({verifyDeviceAuth:async()=>null}));
vi.mock("@/lib/server/db",()=>({withBudget:async(p:Promise<unknown>)=>p,dbEventSave:async()=>{}}));
vi.mock("@/lib/server/entitlement",()=>({readEntitlement:async()=>({status:"legacy"})}));
vi.mock("@/lib/server/usage",()=>({withinFreeBudget:async()=>({ok:true}),addUsage:async()=>{}}));
vi.mock("@/lib/server/quota",()=>({checkAndCountServerKey:async()=>({ok:true})}));
vi.mock("@/lib/server/deploy-env",()=>({isDeployed:()=>false}));
vi.mock("@/lib/server/ai-config",()=>({resolveByok:async()=>({error:"unused",status:401}),serverConfig:()=>({provider:"deepseek",apiKey:"fixture",model:"fixture",baseUrl:"https://example.invalid/v1"})}));
vi.mock("@/lib/server/personal",()=>({agentPersonalContext:async()=>""}));
vi.mock("@/lib/server/config",()=>({logEvent:()=>{}}));
import { POST } from "@/app/api/chat/route";
const enc=new TextEncoder();
function req(){return {headers:new Headers({cookie:"mentora_session=fixture"}),body:null,text:async()=>JSON.stringify({messages:[{role:"user",content:"hello"}]})} as unknown as NextRequest;}
function sse(content:string){return `data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`;}
async function responseText(parts:string[]){
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({start(c){for(const p of parts)c.enqueue(enc.encode(p));c.close();}}))));
  return (await POST(req())).text();
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe("provider stream integrity and bounds",()=>{
  it("rejects EOF without a completion signal",async()=>{
    expect(await responseText([sse("unfinished")])).toContain('"t":"e"');
  });
  it("accepts DONE and finish_reason completion conventions",async()=>{
    expect(await responseText([sse("complete"),'data: [DONE]\n\n'])).not.toContain('"t":"e"');
    expect(await responseText([sse("complete"),'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'])).not.toContain('"t":"e"');
  });
  it("reports token-limit truncation instead of presenting success",async()=>{
    const result=await responseText([sse("cut off"),'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']);
    expect(result).toContain('"t":"e"');
    expect(result).toContain("截断");
  });
  it("cancels endless successful bodies that never form SSE lines",async()=>{
    let produced=0;const cancel=vi.fn();
    const body=new ReadableStream({pull(c){produced++;c.enqueue(new Uint8Array(1024*1024));},cancel});
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(body)));
    const result=await (await POST(req())).text();
    expect(result).toContain("响应过大");expect(produced).toBeLessThan(12);expect(cancel).toHaveBeenCalledOnce();
  });
  it("enforces total lifetime even when upstream heartbeats never stop",async()=>{
    vi.useFakeTimers();let timer:ReturnType<typeof setInterval>;
    const body=new ReadableStream({start(c){timer=setInterval(()=>c.enqueue(enc.encode(': ping\n\n')),1000);},cancel(){clearInterval(timer);}});
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(body)));
    const pending=POST(req()).then(r=>r.text());
    await vi.advanceTimersByTimeAsync(241_000);
    expect(await pending).toContain('"t":"e"');
  });
});
