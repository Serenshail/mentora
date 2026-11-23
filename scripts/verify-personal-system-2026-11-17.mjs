import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.BASE||'http://127.0.0.1:3014',release=process.env.RELEASE||'9618b11';
const real=process.env.REAL_MODEL==='1',stage=process.env.VERIFY_STAGE||(real?'real-model':'candidate');
assert.match(stage,/^[a-z0-9-]+$/);
const out=`docs/evidence/personal-system-2026-11-17/${stage}`;await fs.mkdir(out,{recursive:true});
const health=await(await fetch(base+'/api/health')).json();assert.equal(health.build,release);
let token='isolated-system-fixture',user={userId:'system-fixture',email:'system@example.invalid',name:'个人系统隔离验收',entitlement:{status:'active'}};
if(real){const auth=JSON.parse(await fs.readFile('C:/Users/haozhe/AppData/Local/Temp/mentora-learning-qa/auth.json','utf8'));token=/mentora_session=([^;]+)/.exec(auth.cookie)[1];const me=await fetch(base+'/api/auth/me',{headers:{cookie:`mentora_session=${token}`}});assert.equal(me.status,200);user=(await me.json()).user;assert.ok(user?.userId);}
const key=`mentora-store-${user.userId}`,now=new Date().toISOString();
const goal=i=>({id:`py-${i}`,topic:'Python',direction:['语言基础','Web 后端','数据科学','算法练习','机器学习','考试准备','数据分析','脚本自动化'][i],status:['draft','active','paused','done'][i%4],domainKind:'coding',motivation:'独立完成小项目',background:'有基础但需要练习',weeklyHours:3,successCriteria:[],createdAt:`2026-11-${String(i+1).padStart(2,'0')}T00:00:00Z`,quizLog:[],intakeTranscript:[],plan:{summary:'按需要循序练习',totalDays:2,weeklyHours:3,createdAt:now,startDate:'2026-11-17',phases:[{id:`p-${i}-1`,title:'语法基础',outcome:'能独立写小脚本',status:'active',dayIds:[`d-${i}-1`]},{id:`p-${i}-2`,title:'综合练习',outcome:'解决真实问题',status:'locked',dayIds:[`d-${i}-2`]}],days:{[`d-${i}-1`]:{id:`d-${i}-1`,phaseId:`p-${i}-1`,title:'基础练习',status:'active',knowledgePoints:[],resources:[],acceptance:[],method:'动手练习',attempts:0},[`d-${i}-2`]:{id:`d-${i}-2`,phaseId:`p-${i}-2`,title:'文件处理',status:'locked',knowledgePoints:[],resources:[],acceptance:[],method:'动手练习',attempts:0}}}});
const seed={goals:Array.from({length:8},(_,i)=>goal(i)),knowledge:[],books:[],sessions:[],folders:[],customPersonas:[],agentSessions:[],agentActiveId:null};
seed.goals[7].status='paused';
for(const g of seed.goals){if(g.status==='draft')delete g.plan;else if(g.status==='done'){for(const day of Object.values(g.plan.days))day.status='passed';for(const phase of g.plan.phases)phase.status='done';}}
const blocks=[{id:'intro',title:'我的学习方法',type:'markdown',text:'先做一个小实验，再记录收获。'},{id:'practice',title:'下一步练习',type:'checklist',items:[{id:'task1',text:'完成一次文件处理练习',done:false}]},{id:'log',title:'学习记录',type:'table',columns:[{id:'date',label:'日期'},{id:'insight',label:'收获'}],rows:[{id:'row1',cells:{date:'周一',insight:'第一条记录'}}]},{id:'plans',title:'Python 计划',type:'goals',query:'python'}];
const browser=await chromium.launch({executablePath:'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:950}});await ctx.addCookies([{name:'mentora_session',value:token,url:base}]);
await ctx.addInitScript(({key,seed})=>{if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:8,state:seed}));},{key,seed});
let calls=0,caseIndex=0,approvals=0,workspaceToEdit=null;const requests=[],events=[],results=[],errors=[];
await ctx.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path==='/api/chat'){
  calls++;console.log(`case=${caseIndex} request=${calls} real=${real}`);if(calls>16)return route.fulfill({status:429,json:{error:'本次验收已到16次请求上限，停止追加调用'}});
  const body=route.request().postDataJSON();requests.push({caseIndex,task:body.task,context:body.args?.ctx,deep:body.args?.deep,question:body.args?.requestQuestion,toolFeedback:body.messages.filter(m=>m.role==='tool').map(m=>m.content)});
  if(real)return route.continue();
  if(caseIndex===5)return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({t:'e',v:'隔离验收：模型暂时无法连接，请重试。'})+'\n'+JSON.stringify({t:'end'})+'\n'});
  const toolMessages=body.messages.filter(m=>m.role==='tool');
  let name,args,answer;
  if(caseIndex===0){if(!toolMessages.length){name='list_goals';args={query:'python'};}else answer='你共有 8 个 Python 计划，包括待规划、进行中、暂停和已完成的计划。';}
  else if(caseIndex===1){if(!toolMessages.length){name='get_goal';args={id:'py-7'};}else if(toolMessages.length===1){name='edit_phase';args={id:'py-7',changes:{phaseMeta:{'p-7-2':{title:'脚本实战与文件处理'}}}};}else answer='已将脚本自动化方向的第二阶段改名为「脚本实战与文件处理」，其他七个计划保留。';}
  else if(caseIndex===2){if(!toolMessages.length){name='manage_workspace';args={action:'create',title:'我的实践台',description:'按我的当前学习情况记录和练习。',blocks};}else answer='已创建[我的实践台]('+(/\/workspace\/[^)]+/.exec(toolMessages.at(-1).content)?.[0]||'/workspace')+')，并加入侧栏。';}
  else if(caseIndex===4){name='manage_workspace';if(!toolMessages.length)args={action:'list'};else if(toolMessages.length===1)args={action:'read',id:workspaceToEdit.id};else if(toolMessages.length===2)args={action:'read',id:workspaceToEdit.id,blockId:workspaceToEdit.tableId};else if(toolMessages.length===3)args={action:'update',id:workspaceToEdit.id,upsertBlocks:[{id:workspaceToEdit.tableId,title:'学习记录',type:'table',columns:[{id:'spent',label:'用时'}],rows:[]}]};else{name=null;answer='记录表已增加「用时」列，已有记录保留。';}}
  else answer='这是受控模型输出，用于页面操作检查。';
  const chunks=name?[{t:'tc',v:[{id:`ui-call-${calls}`,name,argsRaw:JSON.stringify(args)}]}]:[{t:'d',v:answer}];
  return route.fulfill({contentType:'application/x-ndjson',body:[...chunks,{t:'end'}].map(x=>JSON.stringify(x)).join('\n')+'\n'});
 }
 return route.fulfill({json:path==='/api/auth/me'?{user}:path==='/api/sync'?{data:null,updatedAt:now}:path==='/api/health'?health:{}});
});
const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
page.on('response',async response=>{if(real&&new URL(response.url()).pathname==='/api/chat'){try{const data=(await response.text()).split('\n').filter(Boolean).flatMap(line=>{try{const item=JSON.parse(line);return ['d','tc','e','u','n'].includes(item.t)?[item]:[];}catch{return [];}});events.push({caseIndex,status:response.status(),events:data});}catch{}}});
const state=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)).state,key);
const lastAnswer=async()=>{const s=await state();return s.agentSessions.find(session=>session.id===s.agentActiveId)?.messages.filter(m=>m.role==='assistant').at(-1)?.content||'';};
async function send(question,approve=false){
 console.log(`Starting case ${caseIndex}`);
 const input=page.getByRole('textbox',{name:'给智能体发消息'});await input.fill(question);await page.getByRole('button',{name:'发送消息',exact:true}).click();
 const deadline=Date.now()+210000;let lastSnapshot=0;
 while(Date.now()<deadline){
  const button=page.getByRole('button',{name:'批准执行',exact:true});
  if(await button.first().isVisible().catch(()=>false)){if(!approve)throw Error('只读或精确改名出现非预期的确认请求');await button.first().click();approvals++;}
  if(await page.getByRole('button',{name:'发送消息',exact:true}).isVisible()&&await lastAnswer())return lastAnswer();
  if(Date.now()-lastSnapshot>10000){lastSnapshot=Date.now();const current=await state();await fs.writeFile(out+'/waiting.json',JSON.stringify({calls,caseIndex,activeId:current.agentActiveId,sessions:current.agentSessions?.map(s=>({id:s.id,messages:s.messages.slice(-2)})),runStatus:await page.locator('[data-run-status]').getAttribute('data-run-status').catch(()=>null)},null,2));await page.screenshot({path:out+'/waiting.png',fullPage:true});}
  await page.waitForTimeout(300);
 }
 throw Error('智能体未在210秒内收尾');
}
try{
 await page.goto(base+'/',{waitUntil:'networkidle'});await page.getByRole('textbox',{name:'给智能体发消息'}).waitFor();
 const countAnswer=await send('我一共有多少个 Python 计划？先读取完整列表，再按方向和状态列出来，不要修改任何内容。');
 assert.match(countAnswer,/(?:8|八)/);assert.equal((await state()).goals.length,8);
 assert.ok(requests.some(r=>r.toolFeedback.some(x=>x.includes('"total":8'))));
 results.push({name:'真实页面对话读取八个同名计划及所有状态',pass:true,answer:countAnswer});
 if(process.env.COUNT_ONLY!=='1'){
 caseIndex=1;
 const answer=await send('把方向为「脚本自动化」的 Python 计划的第二阶段改名为「脚本实战与文件处理」，其他七个计划不动。请读取最新计划后直接修改。',true);
 const after=(await state()).goals;assert.equal(after[7].plan.phases[1].title,'脚本实战与文件处理');assert.deepEqual(after.slice(0,7),seed.goals.slice(0,7));
 results.push({name:'对话精确修改第八个同名计划，其他七个计划与进度不变',pass:true,answer});
 caseIndex=2;
 const created=await send('我想搭建一个叫「我的实践台」的个人页面，放到侧栏。我需要一小段可编辑的学习方法、可勾选的练习清单、一张我自己填写日期和收获的记录表，还要实时查看我已有的 Python 计划。请根据我当前情况创建这些内容，不要额外创建新计划或预装其他模块。',true);
 let s=await state();const workspace=s.knowledge.find(n=>n.workspace);assert.ok(workspace);assert.match(workspace.title,/我的实践台/);
 for(const type of ['markdown','checklist','table','goals'])assert.ok(workspace.workspace.blocks.some(b=>b.type===type),`缺少 ${type}`);
 assert.equal(s.goals.length,8);
 results.push({name:'按用户当次需求真实创建个人页面，文档/清单/表格/实时计划保存并加入侧栏',pass:true,answer:created});
 const workspaceId=workspace.id;
 await page.goto(`${base}/workspace/${workspaceId}`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:workspace.title,exact:true}).waitFor();
 assert.equal(await page.locator('main a[href^="/learn/py-"]').count(),8);
 const checkbox=page.locator('main input[type="checkbox"]').first();await checkbox.check();
 const checklistId=workspace.workspace.blocks.find(b=>b.type==='checklist').id;
 const tableId=workspace.workspace.blocks.find(b=>b.type==='table').id;
 const table=page.locator(`[data-workspace-block="${tableId}"]`);
 if(await table.locator('tbody input').count()===0)await table.getByRole('button',{name:'添加一行'}).click();
 const cell=table.locator('tbody input').first();await cell.fill('我的验收记录');await cell.press('Tab');
 await page.reload({waitUntil:'networkidle'});assert.ok(await page.locator(`[data-workspace-block="${checklistId}"] input[type="checkbox"]`).first().isChecked());
 assert.equal(await page.locator(`[data-workspace-block="${tableId}"] tbody input`).first().inputValue(),'我的验收记录');
 results.push({name:'页面中的清单勾选与自定义表格填写可保存并刷新恢复',pass:true});
 for(const width of [320,390,768,1024,1440]){
  await page.setViewportSize({width,height:950});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),`整页横向溢出 ${width}`);
  if(width===390||width===1440)await page.screenshot({path:`${out}/workspace-${width}.png`,fullPage:true});
  results.push({name:`个人页面 ${width}px 不出现整页横向溢出`,pass:true});
 }
 await page.setViewportSize({width:390,height:950});await page.getByRole('button',{name:'更多',exact:true}).click();
 await page.getByRole('dialog',{name:'更多',exact:true}).getByRole('link',{name:workspace.title,exact:true}).waitFor();
 await page.keyboard.press('Escape');
 results.push({name:'手机更多菜单可找到用户创建的个人页面',pass:true});
 if(real&&process.env.SKIP_TEACHING!=='1'){
  caseIndex=3;await page.goto(base+'/',{waitUntil:'networkidle'});await page.getByRole('button',{name:'新对话',exact:true}).click();
  const teaching=await send('请详细讲清楚 C 的 realloc 为什么先用临时指针接收。已有 3 个 int，值是 10、20、30，现在想扩成 5 个。请用同一组数据逐步说明成功和失败后指针、内容分别怎样，给出安全的完整示例，最后只给一个针对性的自测。不要替我建学习计划。');
  assert.ok(teaching.length>=800,'讲解不足800字，待人工复核');assert.match(teaching,/realloc/);assert.match(teaching,/NULL|空指针/);assert.match(teaching,/10/);assert.match(teaching,/20/);assert.match(teaching,/30/);
  assert.equal((await state()).goals.length,8);
  await fs.writeFile(out+'/teaching.md',teaching);
  results.push({name:'真实模型详细教学输出已归档，具体质量另按教学标准人工复核',pass:true,chars:teaching.length});
 }else if(!real){
  caseIndex=4;workspaceToEdit={id:workspaceId,tableId};await page.goto(base+'/',{waitUntil:'networkidle'});
  await send('给我的实践台的学习记录表加一列「用时」，保留原有记录。',true);
  const changed=(await state()).knowledge.find(n=>n.id===workspaceId).workspace.blocks.find(b=>b.id===tableId);
  assert.equal(changed.columns.length,3);assert.equal(Object.values(changed.rows[0].cells)[0],'我的验收记录');
  results.push({name:'对话中连续读取页面目录与表格后能继续修改，新增列不丢原有记录',pass:true});
  caseIndex=5;
  const failure=await send('帮我读取当前状态');assert.match(failure,/隔离验收：模型暂时无法连接/);
  assert.equal(await page.getByRole('button',{name:'停止当前回答',exact:true}).count(),0);
  results.push({name:'无正文的模型失败保留可见错误消息，结束转圈，允许继续提问',pass:true});
 }
 }
 assert.deepEqual(errors,[]);
}catch(error){errors.push(error.stack);await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{
 const s=await state().catch(()=>null);
 await fs.writeFile(out+'/results.json',JSON.stringify({base,release,realModel:real,fixture:'隔离样例学习数据；真实模型模式仅使用专用探针账号。云同步被拦截，不读写真实学习快照。',calls,approvals,results,errors,createdPages:s?.knowledge.filter(n=>n.workspace).map(n=>({id:n.id,title:n.title,blocks:n.workspace.blocks})),requests,events},null,2));
 console.log(JSON.stringify({realModel:real,calls,approvals,results:results.map(r=>({name:r.name,pass:r.pass})),errors},null,2));await browser.close();
}
