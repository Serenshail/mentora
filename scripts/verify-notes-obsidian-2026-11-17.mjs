import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.BASE || 'http://127.0.0.1:3014';
const release=process.env.RELEASE || '384b4c3';
const stage=process.env.VERIFY_STAGE || 'candidate';
assert.match(stage,/^[a-z0-9-]+$/);
const out=`docs/evidence/notes-obsidian-2026-11-17/${stage}`;
await fs.mkdir(out,{recursive:true});
const health=await (await fetch(base+'/api/health')).json();
assert.equal(health.build,release);
const browser=await chromium.launch({executablePath:'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true});
const ctx=await browser.newContext({viewport:{width:1600,height:1000}});
await ctx.addCookies([{name:'mentora_session',value:'isolated-notes-fixture',url:base}]);
await ctx.addInitScript(()=>{
 const key='mentora-store-notes-fixture'; if(localStorage.getItem(key))return;
 const now=new Date().toISOString();
 const note=(id,title,body)=>({id,title,body,domain:'学习',masteredAt:now,createdAt:now,updatedAt:now,version:1,source:'manual',sourceTitle:'隔离验收',reviewStage:0,tags:[],links:[]});
 const knowledge=[
  note('note-a','学习方法','# 学习方法\n\n先看 [[间隔复习#练习|复习例子]]，也可以写 [[新笔记]]。\n\n`[[代码中的链接]]`\n\n```md\n[[围栏中的链接]]\n```\n\n## 总结\n\n每次练习后记录收获。'),
  note('note-b','间隔复习','# 间隔复习\n\n## 练习\n\n'+Array.from({length:24},(_,i)=>`第 ${i+1} 次练习：先回忆，再检查遗漏。`.repeat(5)).join('\n\n')+'\n\n## 复盘\n\n记录下一次要改进的地方。'),
  note('note-c','对比方法','# 对比方法\n\n比较两次学习的不同。')
 ];
 localStorage.setItem(key,JSON.stringify({version:8,state:{goals:[],knowledge,books:[],sessions:[],folders:[],customPersonas:[],agentSessions:[],agentActiveId:null}}));
});
let modelCalls=0;
await ctx.route('**/api/**',r=>{
 const path=new URL(r.request().url()).pathname;
 if(/\/api\/(chat|ai|generate)/.test(path))modelCalls++;
 return r.fulfill({json:path==='/api/auth/me'?{user:{userId:'notes-fixture',email:'notes@example.invalid',name:'隔离界面验收',entitlement:{status:'active'}}}:path==='/api/sync'?{data:null,updatedAt:new Date().toISOString()}:path==='/api/health'?health:{}});
});
const page=await ctx.newPage(),errors=[],results=[];
page.on('pageerror',e=>errors.push(e.message));
const title=()=>page.locator('input.font-bold');
const panel=()=>page.getByRole('button',{name:'反链',exact:true}).locator('..').locator('..');
const getNote=id=>page.evaluate(id=>JSON.parse(localStorage.getItem('mentora-store-notes-fixture')).state.knowledge.find(k=>k.id===id),id);
async function waitTitle(text){await page.waitForFunction(text=>document.querySelector('input.font-bold')?.value===text,text);}
try{
 await page.goto(base+'/brain?note=note-a',{waitUntil:'networkidle'});
 await waitTitle('学习方法');
 await page.getByRole('button',{name:'复习例子',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'代码中的链接',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'围栏中的链接',exact:true}).count(),0);
 await page.getByRole('button',{name:'复习例子',exact:true}).click();
 await page.waitForURL(/note=note-b/); await waitTitle('间隔复习');
 assert.equal(await page.locator('.note-tab-strip button[aria-current="page"]').textContent(),'间隔复习');
 assert.equal(await page.locator('.note-tab-strip > div').count(),2);
 await panel().getByRole('button',{name:/^学习方法/}).waitFor();
 assert.equal(await panel().getByRole('button',{name:/^学习方法/}).count(),1);
 results.push({name:'别名双链定位实际笔记；代码里的方括号保持代码；反链从正文解析',pass:true});
 await page.getByRole('button',{name:'图谱',exact:true}).click();
 await page.getByText('3 节点 · 1 连接',{exact:true}).waitFor();
 await page.getByRole('button',{name:'笔记',exact:true}).click();
 await waitTitle('间隔复习');
 await panel().getByRole('button',{name:/^学习方法/}).click(); await waitTitle('学习方法');
 await page.getByRole('button',{name:'复习例子',exact:true}).click(); await waitTitle('间隔复习');
 results.push({name:'正文、反链、图谱连接一致，不重复展示为未链接提及',pass:true});
 await panel().getByRole('button',{name:'大纲',exact:true}).click();
 await panel().getByRole('button',{name:'复盘',exact:true}).click();
 await page.waitForFunction(()=>{const h=document.getElementById('wiki-heading-'+encodeURIComponent('复盘'));const r=h?.getBoundingClientRect();const a=document.querySelector('.note-reading-area')?.getBoundingClientRect();return r&&a&&r.top>=a.top-1&&r.top<a.bottom;});
 results.push({name:'大纲点击滚动到正文对应标题',pass:true});
 await page.locator('.note-tab-strip').getByRole('button',{name:'学习方法',exact:true}).click();
 await page.waitForURL(/note=note-a/); await waitTitle('学习方法');
 await page.goBack({waitUntil:'networkidle'}); await waitTitle('间隔复习');
 await page.reload({waitUntil:'networkidle'}); await waitTitle('间隔复习');
 results.push({name:'已打开标签、地址栏、浏览器返回及刷新保持同一篇笔记',pass:true});
 await title().fill('间隔复习实践'); await title().press('Enter');
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('mentora-store-notes-fixture')).state.knowledge.find(k=>k.id==='note-a').body.includes('[[间隔复习实践#练习|复习例子]]'));
 const a=await getNote('note-a'); assert.ok(a.body.includes('`[[代码中的链接]]`')); assert.ok(a.body.includes('```md\n[[围栏中的链接]]\n```'));
 results.push({name:'重命名同步更新引用，保留标题锚点、显示别名及代码原文',pass:true});
 await page.keyboard.press('Control+e');
 await page.getByRole('button',{name:'源码',exact:true}).click();
 const source=page.locator('textarea[placeholder^="像聊天一样写"]');
 await source.waitFor(); const old=await source.inputValue();
 await source.fill(old+'\n\n草稿保存验收标记');
 await panel().getByRole('button',{name:'大纲',exact:true}).click();
 assert.ok(await source.isVisible());
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('mentora-store-notes-fixture')).state.knowledge.find(k=>k.id==='note-b').body.includes('草稿保存验收标记'));
 await panel().getByRole('button',{name:'反链',exact:true}).click();
 await panel().getByRole('button',{name:/^学习方法/}).first().click(); await waitTitle('学习方法');
 assert.ok(!(await getNote('note-a')).body.includes('草稿保存验收标记'));
 await page.locator('.note-tab-strip').getByRole('button',{name:'间隔复习实践',exact:true}).click(); await waitTitle('间隔复习实践');
 assert.ok((await getNote('note-b')).body.includes('草稿保存验收标记'));
 results.push({name:'Ctrl+E切换；源码失焦保持编辑；切笔记不丢草稿、不串写',pass:true});
 await page.locator('.note-tab-strip').getByRole('button',{name:'学习方法',exact:true}).click(); await waitTitle('学习方法');
 await page.locator('.note-document').getByRole('button',{name:/^新笔记/}).click();
 await waitTitle('新笔记');
 await page.waitForURL(url=>url.searchParams.has('note')&&url.searchParams.get('note')!=='note-a');
 const newId=new URL(page.url()).searchParams.get('note');assert.ok(newId&&newId!=='note-a');
 assert.equal((await getNote(newId)).title,'新笔记');
 results.push({name:'未创建的双链点击后建立同名笔记并同步地址',pass:true});
 for(const width of [320,390,768,1024,1440]){
  await page.setViewportSize({width,height:950});
  await page.goto(base+'/brain?note=note-a',{waitUntil:'networkidle'}); await waitTitle('学习方法');
  await page.locator('.note-document').getByRole('button',{name:'复习例子',exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  const metrics=await page.locator('.note-document').evaluate(el=>({width:el.getBoundingClientRect().width,font:parseFloat(getComputedStyle(el).fontSize)}));
  assert.ok(metrics.width>=180,JSON.stringify({width,metrics}));assert.ok(metrics.font>=16);
  await page.screenshot({path:`${out}/notes-${width}.png`,fullPage:true});
  results.push({name:`${width}px：正文可读、双链可操作、无整页横向溢出`,pass:true});
 }
 assert.equal(modelCalls,0);assert.deepEqual(errors,[]);
}catch(e){errors.push(e.stack);await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{
 await fs.writeFile(out+'/results.json',JSON.stringify({base,release,fixture:'隔离样例与身份，API全拦截；不读取或修改真实用户数据，不调用模型',modelCalls,results,errors},null,2));
 console.log(JSON.stringify({results,errors},null,2));await browser.close();
}
