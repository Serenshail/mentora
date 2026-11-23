import { z } from "zod";

const id=z.string().trim().min(1).max(100);
const label=z.string().trim().min(1).max(120);
const base={id,title:label};
const ref={query:z.string().max(160).optional(),ids:z.array(id).max(100).optional()};
/** 单字段长度上限：编辑框 maxLength 与 schema 同源。此前 markdown 编辑框漏配
 *  maxLength，超 3 万字符的输入要到保存时才被 schema 拒绝且报错误导；
 *  上限调整只改这里，UI 与 schema 不会漂移。 */
export const WORKSPACE_FIELD_LIMITS={markdownText:30000,checklistItem:1000,tableCell:5000} as const;
/** 整页字符上限（superRefine 的 stringify 总量检查）；编辑保存路径复用同一阈值。 */
export const WORKSPACE_PAGE_CHAR_LIMIT=180000;
export const workspaceBlockSchema=z.discriminatedUnion("type",[
  z.object({...base,type:z.literal("markdown"),text:z.string().max(WORKSPACE_FIELD_LIMITS.markdownText)}).strict(),
  z.object({...base,type:z.literal("checklist"),items:z.array(z.object({id,text:z.string().min(1).max(WORKSPACE_FIELD_LIMITS.checklistItem),done:z.boolean()}).strict()).max(300)}).strict(),
  z.object({...base,type:z.literal("table"),columns:z.array(z.object({id,label}).strict()).min(1).max(12),rows:z.array(z.object({id,cells:z.record(z.string(),z.string().max(WORKSPACE_FIELD_LIMITS.tableCell))}).strict()).max(300)}).strict(),
  z.object({...base,type:z.literal("goals"),...ref}).strict(),
  z.object({...base,type:z.literal("notes"),...ref}).strict(),
  z.object({...base,type:z.literal("books"),...ref}).strict(),
]);
export const workspaceSchema=z.object({schemaVersion:z.literal(1),pinned:z.boolean(),blocks:z.array(workspaceBlockSchema).max(32)}).strict().superRefine((value,ctx)=>{
  const unique=(values:string[],path:(string|number)[])=>{if(new Set(values).size!==values.length)ctx.addIssue({code:"custom",message:"编号不能重复",path});};
  unique(value.blocks.map(b=>b.id),["blocks"]);
  value.blocks.forEach((b,i)=>{
    if(b.type==="checklist")unique(b.items.map(x=>x.id),["blocks",i,"items"]);
    if(b.type==="table"){
      unique(b.columns.map(x=>x.id),["blocks",i,"columns"]);unique(b.rows.map(x=>x.id),["blocks",i,"rows"]);
      const columns=new Set(b.columns.map(c=>c.id));
      if(b.rows.some(r=>Object.keys(r.cells).some(key=>!columns.has(key))))ctx.addIssue({code:"custom",message:"单元格必须对应已有列",path:["blocks",i,"rows"]});
    }
  });
  if(JSON.stringify(value).length>WORKSPACE_PAGE_CHAR_LIMIT)ctx.addIssue({code:"custom",message:"单个页面内容过多，请拆为多个页面"});
});
export type PersonalWorkspace=z.infer<typeof workspaceSchema>;
export type WorkspaceBlock=z.infer<typeof workspaceBlockSchema>;

/** Validate restored data as well as model output. Never execute generated scripts or HTML. */
export function parseWorkspace(value:unknown):PersonalWorkspace|null {
  if(!value||typeof value!=="object")return null;
  const result=workspaceSchema.safeParse(value);return result.success?result.data:null;
}
