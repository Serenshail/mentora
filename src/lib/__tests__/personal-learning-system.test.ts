import { beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { useAppStore } from "../store";
import { executeAction,executeTool,resolveGoal } from "../agent/tool-executors";
import { buildAppContext } from "../agent/app-context";
import { parseWorkspace } from "../workspace";
import { agentToolsSchema,agentToolsPrompt,agentNativeToolsGuide } from "../server/agent-tools";
import type { Goal } from "../types";

const goal=(i:number):Goal=>({id:`py-${i}`,topic:"Python",direction:`方向 ${i}`,status:["draft","active","paused","done"][i%4] as Goal["status"],createdAt:`2026-11-${String(i+1).padStart(2,"0")}T00:00:00Z`,domainKind:"coding",motivation:"独立写脚本",background:"入门",weeklyHours:3,successCriteria:[],quizLog:[],intakeTranscript:[]});
const blocks=[{id:"doc",type:"markdown",title:"我的方法",text:"按我的时间学习"},{id:"tasks",type:"checklist",title:"练习",items:[{id:"t1",text:"写一个脚本",done:false}]},{id:"records",type:"table",title:"练习记录",columns:[{id:"date",label:"日期"},{id:"learning",label:"收获"}],rows:[{id:"r1",cells:{date:"周一",learning:"第一条记录"}}]},{id:"plans",type:"goals",title:"Python 计划",query:"python"}];
beforeEach(()=>useAppStore.setState({goals:Array.from({length:8},(_,i)=>goal(i)),knowledge:[],books:[],sessions:[],folders:[]}));

describe("所有状态的同名计划与实时上下文",()=>{
  it("八个同名计划不漏，返回可消歧的id、方向、创建时间和状态",async()=>{
    const result=await executeTool("list_goals",{query:"python"});const data=JSON.parse(result.result.content);
    expect(data.total).toBe(8);expect(data.goals.map((g:Goal)=>g.id)).toHaveLength(8);expect(data.nextOffset).toBeNull();
    expect(new Set(data.goals.map((g:Goal)=>g.status)).size).toBe(4);expect(data.goals[7].direction).toBe("方向 7");
    const ambiguous=await executeTool("get_goal",{topic:"PYTHON"});
    expect(ambiguous.result.content).toContain("8 个相近目标");expect(ambiguous.result.content).toContain("id=py-7");
    expect(resolveGoal(useAppStore.getState().goals,"Python","py-7")).toEqual({kind:"exact",goalId:"py-7"});
  });
  it("分页声明真实总数，不把列表页数当目标总数",async()=>{
    useAppStore.setState({goals:Array.from({length:41},(_,i)=>({...goal(i),topic:`Python ${i}`}))});
    const a=JSON.parse((await executeTool("list_goals",{limit:25})).result.content),b=JSON.parse((await executeTool("list_goals",{offset:a.nextOffset})).result.content);
    expect(a.total).toBe(41);expect(a.goals).toHaveLength(25);expect(b.goals).toHaveLength(16);expect(b.nextOffset).toBeNull();
    expect(JSON.parse(buildAppContext()).goalCount).toBe(41);expect(JSON.parse(buildAppContext()).hasMoreGoals).toBe(true);
  });
  it("改计划绑定选定id，保留其他七个同名计划；再次读取是最新状态",async()=>{
    const before=useAppStore.getState().goals;
    const draft=await executeTool("manage_goal",{action:"update",id:"py-7",patch:{topic:"Python 数据分析",weeklyHours:5}});
    expect(useAppStore.getState().goals).toBe(before);
    expect((await executeAction(draft.action!)).ok).toBe(true);
    const after=useAppStore.getState().goals;
    expect(after.slice(0,7)).toEqual(before.slice(0,7));expect(after[7].topic).toBe("Python 数据分析");
    expect((await executeTool("get_goal",{id:"py-7"})).result.content).toContain("Python 数据分析");
    expect(buildAppContext()).toContain("Python 数据分析");
  });
  it("并发修改发生后，旧计划方案拒绝覆盖",async()=>{
    const draft=await executeTool("manage_goal",{action:"update",id:"py-7",patch:{topic:"新名称"}});
    useAppStore.getState().updateGoal("py-7",{weeklyHours:9});
    expect((await executeAction(draft.action!)).ok).toBe(false);expect(useAppStore.getState().goals[7].weeklyHours).toBe(9);
  });
});

describe("按需搭建个人学习页面",()=>{
  it("方案确认前不创建；确认后页面内容、侧栏标记和刷新载荷真实保存",async()=>{
    const draft=await executeTool("manage_workspace",{action:"create",title:"我的脚本学习系统",description:"按当前情况组织",blocks});
    expect(draft.action).toBeTruthy();expect(useAppStore.getState().knowledge).toHaveLength(0);
    const result=await executeAction(draft.action!);expect(result.ok).toBe(true);
    const page=useAppStore.getState().knowledge.find(n=>n.workspace)!;
    expect(page.workspace!.pinned).toBe(true);expect(page.workspace!.blocks).toEqual(blocks);expect(result.content).toContain(`/workspace/${page.id}`);
    const copy=structuredClone(page);expect(useAppStore.getState().importData({knowledge:[copy]})).toBe(true);
    expect(useAppStore.getState().knowledge[0].workspace).toEqual(copy.workspace);
  });
  it("按块更新保留其他块及用户填写的表格，版本递增",async()=>{
    await executeAction((await executeTool("manage_workspace",{action:"create",title:"个人系统",blocks})).action!);
    const page=useAppStore.getState().knowledge.find(n=>n.workspace)!;
    const update=await executeTool("manage_workspace",{action:"update",id:page.id,upsertBlocks:[{id:"doc",type:"markdown",title:"我的方法",text:"每周五小时"}]});
    expect((await executeAction(update.action!)).ok).toBe(true);
    const changed=useAppStore.getState().knowledge.find(n=>n.id===page.id)!;
    expect(changed.workspace!.blocks.slice(1)).toEqual(page.workspace!.blocks.slice(1));expect(changed.version).toBe((page.version??1)+1);
  });
  it("用户在确认期间填写了记录，旧方案拒绝写入；删除页面不删除计划",async()=>{
    await executeAction((await executeTool("manage_workspace",{action:"create",title:"个人系统",blocks})).action!);
    const page=useAppStore.getState().knowledge.find(n=>n.workspace)!;
    const update=await executeTool("manage_workspace",{action:"update",id:page.id,title:"过时标题"});
    useAppStore.getState().updateKnowledge(page.id,{workspace:{...page.workspace!,pinned:false}});
    expect((await executeAction(update.action!)).ok).toBe(false);
    expect((await executeAction((await executeTool("manage_workspace",{action:"delete",id:page.id})).action!)).ok).toBe(true);
    expect(useAppStore.getState().goals).toHaveLength(8);
  });
  it("向记录表添加一列或向清单加任务时保留原有行和完成状态",async()=>{
    await executeAction((await executeTool("manage_workspace",{action:"create",title:"我的记录",blocks})).action!);
    const page=useAppStore.getState().knowledge.find(n=>n.workspace)!;
    const changes=await executeTool("manage_workspace",{action:"update",id:page.id,upsertBlocks:[{id:"records",type:"table",title:"练习记录",columns:[{id:"time",label:"用时"}],rows:[]},{id:"tasks",type:"checklist",title:"练习",items:[{id:"t2",text:"检查脚本",done:false}]}]});
    expect((await executeAction(changes.action!)).ok).toBe(true);
    const result=useAppStore.getState().knowledge.find(n=>n.id===page.id)!.workspace!;
    const table=result.blocks.find(b=>b.type==="table")!;expect(table.type==="table"&&table.rows[0].cells.learning).toBe("第一条记录");expect(table.type==="table"&&table.columns).toHaveLength(3);
    const checklist=result.blocks.find(b=>b.type==="checklist")!;expect(checklist.type==="checklist"&&checklist.items).toHaveLength(2);
  });
  it("脚本、重复编号、无效表格字段不被存为可执行页面",()=>{
    expect(parseWorkspace({schemaVersion:1,pinned:true,blocks:[{id:"x",title:"脚本",type:"script",code:"alert(1)"}]})).toBeNull();
    expect(parseWorkspace({schemaVersion:1,pinned:true,blocks:[blocks[0],blocks[0]]})).toBeNull();
    expect(parseWorkspace({schemaVersion:1,pinned:true,blocks:[{...blocks[2],rows:[{id:"r1",cells:{unknown:"x"}}]}]})).toBeNull();
  });
  it("设置不在原生和降级工具中，历史设置方案同样无法执行",async()=>{
    expect(agentToolsSchema().some(t=>["update_settings","get_settings_public"].includes(t.function.name))).toBe(false);
    expect(agentToolsPrompt()).not.toContain('`update_settings`');expect(agentNativeToolsGuide().length).toBeLessThan(agentToolsPrompt().length/3);
    const before=useAppStore.getState().settings;
    expect((await executeTool("update_settings",{userName:"不应写入"})).result.ok).toBe(false);
    expect((await executeAction({id:"legacy-settings",kind:"update_settings",label:"旧操作",summary:"旧设置",payload:{patch:{userName:"不应写入"}}})).ok).toBe(false);
    expect(useAppStore.getState().settings).toBe(before);
  });
});
