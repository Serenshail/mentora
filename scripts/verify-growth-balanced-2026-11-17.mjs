import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.BASE || 'http://127.0.0.1:3002';
const release=process.env.RELEASE;
const stage=process.env.VERIFY_STAGE || (release ? 'live' : 'local');
assert.match(stage,/^[a-z0-9-]+$/);
const out=`docs/evidence/growth-balanced-2026-11-17/${stage}`;
await fs.mkdir(out,{recursive:true});
const health=release ? await (await fetch(base+'/api/health')).json() : {};
if(release)assert.equal(health.build,release);
const browser=await chromium.launch({executablePath:'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true});
const ctx=await browser.newContext();
await ctx.addCookies([{name:'mentora_session',value:'isolated-growth-fixture',url:base}]);
await ctx.addInitScript(()=>{
 const key='mentora-store-growth-balanced'; if(localStorage.getItem(key))return;
 const now=new Date().toISOString(),date=now.slice(0,10);
 const day=(id,status)=>({id,phaseId:'p1',title:id==='d1'?'环境搭建':'文件读写与路径处理',status,attempts:1,knowledgePoints:[],resources:[],acceptance:[],method:''});
 const goal={id:'growth-goal',topic:'Python：从基础到能独立完成工具脚本',domainKind:'coding',status:'active',createdAt:now,quizLog:[{dayId:'d1',date,passed:true,forced:false,items:[]}],intakeTranscript:[],plan:{summary:'测试计划',totalDays:2,weeklyHours:3,startDate:date,createdAt:now,phases:[{id:'p1',title:'基础',outcome:'独立编程',status:'active',dayIds:['d1','d2']}],days:{d1:day('d1','passed'),d2:day('d2','active')}}};
 const knowledge=Array.from({length:6},(_,i)=>({id:'n'+i,title:i===0?'非常长的学习笔记与EnglishIdentifierWithoutSpaces'.repeat(8):['文件读写的三个关键步骤','如何理解函数参数','用小例子检验理解','一次有效的复习','把问题拆成最小步骤'][i-1],body:'测试内容',domain:'Python',masteredAt:now,createdAt:now,source:'manual',sourceTitle:'测试',reviewStage:0,tags:[],links:[]}));
 localStorage.setItem(key,JSON.stringify({version:8,state:{goals:[goal],knowledge,books:[],sessions:[{id:'s1',title:'怎样安排每天的学习时间',createdAt:now,messages:[],personaId:'test'}],folders:[],customPersonas:[],agentSessions:[],agentActiveId:null}}));
});
await ctx.route('**/api/**',r=>{const path=new URL(r.request().url()).pathname;return r.fulfill({json:path==='/api/auth/me'?{user:{userId:'growth-balanced',email:'growth@example.invalid',name:'隔离界面验收',entitlement:{status:'active'}}}:path==='/api/sync'?{data:null,updatedAt:new Date().toISOString()}:path==='/api/health'?health:{}});});
const page=await ctx.newPage(); const errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));
try{
 for(const width of [320,390,768,1024,1440]){
  await page.setViewportSize({width,height:950});
  await page.goto(base+'/life'+(release?'?release='+release:''),{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'成长记录',exact:true}).waitFor();
  await page.getByRole('heading',{name:'接着学',exact:true}).waitFor();
  assert.equal(await page.locator('#growth-history li').count(),5);
  assert.equal(await page.locator('details[open]').count(),0);
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'50');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  const geometry=await page.locator('[data-testid="growth-layout"]').evaluate(el=>({columns:getComputedStyle(el).gridTemplateColumns.split(' ').length}));
  assert.equal(geometry.columns,width>=1280?2:1);
  const title=page.locator('#growth-history [title]').filter({hasText:/非常长/});
  assert.ok(await title.evaluate(el=>el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)*2+1));
  await page.screenshot({path:`${out}/growth-${width}.png`,fullPage:true});
  results.push({name:`${width}px：概览、进度50%、五条足迹、日历折叠、无整页横溢`,pass:true});
 }
 await page.getByRole('button',{name:/查看更多记录/}).click();
 assert.equal(await page.locator('#growth-history li').count(),8);
 assert.equal(await page.getByRole('link',{name:/继续学习/}).getAttribute('href'),'/learn/growth-goal');
 results.push({name:'查看更多显示全部八条，继续学习链接指向正确目标',pass:true});
 await page.locator('summary').click();
 await page.getByRole('button',{name:'近 8 周',exact:true}).waitFor();
 results.push({name:'日历按需展开可操作',pass:true});
 await page.evaluate(()=>localStorage.setItem('mentora-store-growth-balanced',JSON.stringify({version:8,state:{goals:[],books:[],knowledge:[],sessions:[],folders:[],customPersonas:[],agentSessions:[],agentActiveId:null}})));
 await page.setViewportSize({width:390,height:900});
 await page.reload({waitUntil:'networkidle'});
 await page.getByText('从一次学习开始，留下你的第一步',{exact:true}).waitFor();
 assert.equal(await page.locator('#growth-history li').count(),0);
 assert.equal(await page.getByRole('progressbar').count(),0);
 await page.screenshot({path:`${out}/growth-empty.png`,fullPage:true});
 results.push({name:'无数据时显示开始学习入口，不伪造进度或记录',pass:true});
 assert.deepEqual(errors,[]);
}catch(e){errors.push(e.stack);process.exitCode=1;}
finally{await fs.writeFile(out+'/results.json',JSON.stringify({base,release,fixture:'隔离样例数据与身份，API 全拦截；无真实用户数据写入或模型调用',results,errors},null,2));console.log(JSON.stringify({results,errors},null,2));await browser.close();}
