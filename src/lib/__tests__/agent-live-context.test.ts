import { describe,expect,it,vi } from "vitest";
vi.mock("@/lib/ai/client",()=>({streamChat:vi.fn(),extractJson:vi.fn(),readingPlanSchema:{},phaseListSchema:{}}));
vi.mock("@/lib/track",()=>({track:vi.fn()}));
import { streamChat } from "../ai/client";
import { runAgent } from "../agent/runner";
import { useAppStore } from "../store";
import { buildAppContext } from "../agent/app-context";
import type { Goal } from "../types";

describe("智能体执行期间的实时上下文",()=>{
  it("操作类最终答案不拼接只读轮次的过渡汇报",async()=>{
    vi.mocked(streamChat).mockReset();
    useAppStore.setState({goals:[],knowledge:[],books:[],sessions:[]});
    let count=0;
    vi.mocked(streamChat).mockImplementation(async options=>{
      if(count++===0){options.onToolCalls?.([{id:"read-progress",name:"list_goals",argsRaw:"{}"}]);return "我先读取你的计划，然后核对当前情况。";}
      return "当前没有可修改的计划，未进行任何写入。";
    });
    const result=await runAgent({question:"请修改我的学习计划名称",context:"",history:[{role:"user",content:"请修改我的学习计划名称"}],deep:false,signal:new AbortController().signal,cb:{onPhase:()=>{},onPlan:()=>{},onTool:()=>{},onReasoning:()=>{},onDelta:()=>{},requestApproval:async()=>[]}});
    expect(result.answer).toBe("当前没有可修改的计划，未进行任何写入。");
  });
  it("等待模型时计划变化，同签名读取重新执行，下一轮上下文是最新值",async()=>{
    vi.mocked(streamChat).mockReset();
    useAppStore.setState({knowledge:[],books:[],sessions:[],goals:[{id:"py-live",topic:"Python 旧计划",direction:"数据分析",status:"active",createdAt:"2026-11-17",domainKind:"coding",weeklyHours:3,background:"",motivation:"",successCriteria:[],quizLog:[],intakeTranscript:[]} as Goal]});
    const requests:string[]=[],mock=vi.mocked(streamChat);let round=0;
    mock.mockImplementation(async options=>{
      requests.push(String(options.args?.ctx));
      expect(options.args?.requestQuestion).toBe("读取我指定的 Python 计划最新状态");
      const n=round++;
      if(n===1)useAppStore.getState().updateGoal("py-live",{topic:"Python 最新计划"});
      if(n<2){options.onToolCalls?.([{id:`call-${n}`,name:"get_goal",argsRaw:'{"id":"py-live"}'}]);return "";}
      const last=options.messages.filter(m=>m.role==="tool").at(-1);
      expect(last?.content).toContain("Python 最新计划");
      options.onDelta?.("已读取最新计划。");return "已读取最新计划。";
    });
    const result=await runAgent({question:"读取我指定的 Python 计划最新状态",context:()=>buildAppContext(),history:[{role:"user",content:"读取我指定的 Python 计划最新状态"}],deep:false,signal:new AbortController().signal,cb:{onPhase:()=>{},onPlan:()=>{},onTool:()=>{},onReasoning:()=>{},onDelta:()=>{},requestApproval:async()=>[]}});
    expect(mock).toHaveBeenCalledTimes(3);expect(requests[2]).toContain("Python 最新计划");
    expect(result.meta.tools).toHaveLength(2);expect(result.answer).toContain("最新计划");
  });
});
