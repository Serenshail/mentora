import { z } from "zod";
import { useAppStore } from "@/lib/store";
import { uid } from "@/lib/utils";
import { parseWorkspace, workspaceBlockSchema, workspaceSchema } from "@/lib/workspace";
import type { PendingAction, ToolResult } from "./protocol";

const text=z.string().trim().min(1).max(120);
const id=z.string().min(1).max(100);
const request=z.object({action:z.enum(["list","read","create","update","delete"]),id:id.optional(),blockId:id.optional(),title:text.optional(),description:z.string().max(5000).optional(),pinned:z.boolean().optional(),blocks:z.array(workspaceBlockSchema).max(32).optional(),upsertBlocks:z.array(workspaceBlockSchema).max(32).optional(),removeBlockIds:z.array(id).max(32).optional(),query:z.string().max(160).optional(),offset:z.number().int().min(0).optional()}).strict();
const failure=(content:string):{result:ToolResult}=>({result:{ok:false,content,summary:"未修改"}});

export function workspaceTool(args:Record<string,unknown>):{result:ToolResult;action?:PendingAction} {
  const input=request.safeParse(args);
  if(!input.success)return failure(`页面参数不完整或不支持：${input.error.issues.map(i=>`${i.path.join(".")} ${i.message}`).slice(0,4).join("；")}`);
  const p=input.data,s=useAppStore.getState();
  const notes=s.knowledge.filter(n=>parseWorkspace(n.workspace));
  if(p.action==="list"){
    const matches=notes.filter(n=>!p.query||`${n.title} ${n.body}`.toLowerCase().includes(p.query.toLowerCase()));
    const offset=p.offset??0;
    return {result:{ok:true,summary:`${matches.length} 个个人页面`,content:JSON.stringify({total:matches.length,items:matches.slice(offset,offset+25).map(n=>({id:n.id,title:n.title,version:n.version??1,pinned:n.workspace!.pinned})),nextOffset:offset+25<matches.length?offset+25:null})}};
  }
  const note=notes.find(n=>n.id===p.id);
  const workspace=note?parseWorkspace(note.workspace):null;
  if(p.action!=="create"&&(!note||!workspace))return failure("页面不存在，请先 list 获取当前页面的准确 id。");
  if(p.action==="read"){
    const block=p.blockId?workspace!.blocks.find(b=>b.id===p.blockId):null;
    if(p.blockId&&!block)return failure("内容块不存在，请重新读取页面目录。");
    return {result:{ok:true,summary:note!.title,content:JSON.stringify({id:note!.id,title:note!.title,description:note!.body,version:note!.version??1,pinned:workspace!.pinned,...(block?{block}:{blocks:workspace!.blocks.map(b=>({id:b.id,title:b.title,type:b.type,preview:b.type==="markdown"?b.text.slice(0,500):b.type==="checklist"?`${b.items.length} 项`:b.type==="table"?`${b.rows.length} 行`:b}))})})}};
  }
  if(p.action==="create"&&(!p.title||!p.blocks?.length))return failure("新页面需要 title 和至少一个内容块 blocks；根据用户需求组合，不要预建无关模块。");
  if(p.action==="create"&&notes.length>=100)return failure("个人页面已达100个，请整理已有页面后再创建。");
  if(p.action==="update"&&!p.title&&p.description===undefined&&p.pinned===undefined&&p.blocks===undefined&&!p.upsertBlocks?.length&&!p.removeBlockIds?.length)return failure("没有指定要修改的内容。");
  let next=workspace??{schemaVersion:1 as const,pinned:true,blocks:[]};
  if(p.action!=="delete"){
    let blocks=p.blocks??next.blocks;
    for(const block of p.upsertBlocks??[]){
      const existing=blocks.find(b=>b.id===block.id);
      if(existing&&existing.type!==block.type)return failure("更换内容块类型可能丢失记录，请读取原内容，并用 blocks 提供明确的完整替换方案。");
      let replacement=block;
      if(existing?.type==="checklist"&&block.type==="checklist")replacement={...block,items:[...existing.items.map(item=>block.items.find(i=>i.id===item.id)??item),...block.items.filter(item=>!existing.items.some(i=>i.id===item.id))]};
      if(existing?.type==="table"&&block.type==="table")replacement={...block,columns:[...existing.columns.map(column=>block.columns.find(c=>c.id===column.id)??column),...block.columns.filter(column=>!existing.columns.some(c=>c.id===column.id))],rows:[...existing.rows.map(row=>{const change=block.rows.find(r=>r.id===row.id);return change?{...row,cells:{...row.cells,...change.cells}}:row;}),...block.rows.filter(row=>!existing.rows.some(r=>r.id===row.id))]};
      blocks=existing?blocks.map(b=>b.id===block.id?replacement:b):[...blocks,replacement];
    }
    blocks=blocks.filter(b=>!p.removeBlockIds?.includes(b.id));
    const checked=workspaceSchema.safeParse({...next,pinned:p.pinned??next.pinned,blocks});
    if(!checked.success)return failure(`页面结构无效：${checked.error.issues.map(i=>i.message).slice(0,3).join("；")}`);
    next=checked.data;
  }
  const title=p.title??note!.title;
  const preview=p.action==="delete"?`删除「${title}」及其页面内容；引用的学习计划、笔记和书籍不删除。`:
    `${p.action==="create"?"新建":"修改"}「${title}」\n${p.description??note?.body??""}\n${p.blocks&&note?"此次将整体替换页面内容，请核对现有记录是否保留。\n":""}${next.blocks.map(b=>`- ${b.title}（${({markdown:"文档",checklist:"清单",table:"记录表",goals:"学习计划",notes:"笔记",books:"书架"})[b.type]}）`).join("\n")}\n${next.pinned?"添加到侧栏「我的系统」":"不固定到侧栏，可在我的系统列表找回"}`;
  return {result:{ok:true,summary:"待确认",content:"已形成个人页面方案，等待确认后保存。"},action:{id:uid("pa"),kind:"manage_workspace",label:p.action==="delete"?"删除个人页面":p.action==="create"?"搭建个人页面":"调整个人页面",summary:title,payload:{operation:p.action,noteId:note?.id??null,baseVersion:note?.version??1,title,description:p.description??note?.body??"",workspace:next,preview}}};
}

export function commitWorkspaceAction(action:PendingAction):ToolResult {
  const p=action.payload,store=useAppStore.getState();
  const fail=(content:string):ToolResult=>({ok:false,content,summary:"未修改"});
  const operation=p.operation;
  if(!["create","update","delete"].includes(String(operation)))return fail("不支持的页面操作。");
  const note=store.knowledge.find(n=>n.id===p.noteId);
  if(operation!=="create"&&(!note?.workspace||(note.version??1)!==p.baseVersion))return fail("页面在方案展示后已变化或被删除，请读取最新内容后重新调整；本次未覆盖新内容。");
  if(operation==="delete"){
    store.removeKnowledge(note!.id);return {ok:true,summary:"已删除",content:`已删除个人页面「${note!.title}」。关联的计划、书籍与其他笔记保留。`};
  }
  const workspace=parseWorkspace(p.workspace);
  if(!workspace||typeof p.title!=="string"||!p.title.trim()||p.title.length>120||typeof p.description!=="string"||p.description.length>5000)return fail("页面内容校验失败，没有写入。");
  if(operation==="create"&&store.knowledge.some(n=>n.workspace&&n.title===p.title))return fail("已有同名个人页面，请先读取并调整已有页面，避免重复创建。");
  if(operation==="create"&&store.knowledge.filter(n=>n.workspace).length>=100)return fail("个人页面已达100个，请整理后再创建。");
  const targetId=operation==="create"?store.createKnowledge({title:p.title,domain:"我的系统"}):note!.id;
  useAppStore.getState().updateKnowledge(targetId,{...(operation==="update"?{title:p.title}:{}),body:p.description,workspace});
  const saved=useAppStore.getState().knowledge.find(n=>n.id===targetId)!;
  return {ok:true,summary:operation==="create"?"已创建":"已更新",content:`个人页面「${saved.title}」已${operation==="create"?"创建":"更新"}。${workspace.pinned?"已加入侧栏「我的系统」。":""}\n[打开页面](/workspace/${encodeURIComponent(targetId)})\n页面中的计划、笔记和书籍区域会读取当前数据，勾选与表格内容会自动保存。`};
}
