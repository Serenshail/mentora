import { z } from "zod";
import { useAppStore } from "@/lib/store";
import { uid } from "@/lib/utils";
import { goalMetadataPatchSchema } from "@/lib/goal-schema";
import type { Goal } from "@/lib/types";
import type { PendingAction, ToolResult } from "./protocol";

const request=z.object({action:z.enum(["update","delete"]),id:z.string().min(1).max(100),patch:goalMetadataPatchSchema.optional()}).strict();
function goalStamp(goal:Goal){
  // Compare the exact affected metadata and progress; don't duplicate lessons or QA in the action payload.
  return JSON.stringify({topic:goal.topic,direction:goal.direction,motivation:goal.motivation,background:goal.background,weeklyHours:goal.weeklyHours,status:goal.status,plan:goal.plan?{summary:goal.plan.summary,phases:goal.plan.phases,days:Object.values(goal.plan.days).map(d=>({id:d.id,status:d.status,title:d.title}))}:null});
}
export function goalActionTool(args:Record<string,unknown>):{result:ToolResult;action?:PendingAction}{
  const input=request.safeParse(args);
  const fail=(content:string)=>({result:{ok:false,summary:"未修改",content}});
  if(!input.success)return fail("目标参数无效。必须先用 list_goals/get_goal 取得准确 id；只修改 topic/direction/motivation/background/weeklyHours/status，阶段结构使用 edit_phase。");
  const p=input.data,goal=useAppStore.getState().goals.find(g=>g.id===p.id);
  if(!goal)return fail("目标不存在，请读取最新列表。");
  if(p.action==="update"&&(!p.patch||!Object.keys(p.patch).length))return fail("没有指定要修改的字段。");
  if(p.patch?.status==="active"&&!goal.plan)return fail("该目标尚无完整计划，请先继续学习规划，不能只改状态跳过规划。");
  const preview=p.action==="delete"?`删除目标「${goal.topic}」（id=${goal.id}）及计划和进度；已经沉淀的笔记保留。`:
    `目标「${goal.topic}」（编号=${goal.id}，方向：${goal.direction||"未定"}）\n${Object.entries(p.patch??{}).map(([key,value])=>`${({topic:"名称",direction:"方向",motivation:"学习目的",background:"当前基础",weeklyHours:"每周小时",status:"状态"} as Record<string,string>)[key]}：${String(goal[key as keyof Goal])} → ${value}`).join("\n")}\n保留学习日、成绩、笔记和阶段结构。`;
  return {result:{ok:true,summary:"待确认",content:"已生成准确目标的修改方案，等待确认后应用。"},action:{id:uid("pa"),kind:"manage_goal",label:p.action==="delete"?"删除学习目标":"调整学习目标",summary:goal.topic,payload:{...p,baseState:goalStamp(goal),preview}}};
}
export function commitGoalAction(action:PendingAction):ToolResult{
  const input=request.safeParse({action:action.payload.action,id:action.payload.id,...(action.payload.patch?{patch:action.payload.patch}:{})});
  const fail=(content:string):ToolResult=>({ok:false,summary:"未修改",content});
  if(!input.success)return fail("方案参数无效，未修改计划。");
  const p=input.data,s=useAppStore.getState(),goal=s.goals.find(g=>g.id===p.id);
  if(!goal||goalStamp(goal)!==action.payload.baseState)return fail("计划或进度在方案生成后已经变化，请基于最新状态重新生成方案。");
  if(p.action==="delete"){s.removeGoalAndNotes(goal.id,false);return {ok:true,summary:"已删除",content:`已删除目标「${goal.topic}」，已经沉淀的笔记保留。`};}
  if(!p.patch||!Object.keys(p.patch).length)return fail("没有要应用的字段。");
  if(p.patch.status==="active"&&!goal.plan)return fail("计划尚未完成规划，没有改为进行中。");
  s.updateGoal(goal.id,p.patch);
  return {ok:true,summary:"已更新",content:`已更新学习目标「${p.patch.topic??goal.topic}」（id=${goal.id}），学习日、成绩、笔记保持。\n[查看计划](/learn/${encodeURIComponent(goal.id)})`};
}
