import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.BASE||'http://127.0.0.1:3002',release=process.env.RELEASE||'local',stage=process.env.VERIFY_STAGE||'local';
assert.match(stage,/^[a-z0-9-]+$/);
const out=`docs/evidence/spotlight-2026-11-17/${stage}`;await fs.mkdir(out,{recursive:true});
const health=release==='local'?{ok:true,build:'local'}:await(await fetch(base+'/api/health')).json();assert.equal(health.build,release);
const browser=await chromium.launch({executablePath:'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:950}});await ctx.addCookies([{name:'mentora_session',value:'isolated-spotlight-fixture',url:base}]);
await ctx.addInitScript(()=>{for(const id of ['tour-a','tour-b']){const key='mentora-store-'+id;if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:8,state:{goals:[],knowledge:[],books:[],sessions:[],folders:[],customPersonas:[],agentSessions:[],agentActiveId:null}}));}});
let owner='tour-a',modelCalls=0;const writes=[];
await ctx.route('**/api/**',route=>{const req=route.request(),path=new URL(req.url()).pathname;if(path==='/api/chat')modelCalls++;if(!['GET','HEAD'].includes(req.method()))writes.push({path,method:req.method()});return route.fulfill({json:path==='/api/auth/me'?{user:{userId:owner,email:owner+'@example.invalid',name:'框选引导隔离验收',entitlement:{status:'active'}}}:path==='/api/sync'?{data:null,updatedAt:new Date().toISOString()}:path==='/api/health'?health:{}});});
const page=await ctx.newPage(),errors=[],results=[];let baselineSessions;page.on('pageerror',e=>errors.push(e.message));
const tour=()=>page.getByTestId('guide-tour'),panel=()=>page.getByTestId('guide-tooltip');
const targets=['composer','new-chat','nav-learn','coach-tab','reading-tab','notes-entry','nav-life','nav-council','guide-entry'];
const routes=['/','/','/','/learn','/learn?tab=read','/learn','/life','/council','/council'];
async function closed(){await page.waitForTimeout(450);assert.equal(await tour().count(),0);}
async function openGuide(width){if(width<768){await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('dialog',{name:'更多',exact:true}).getByRole('button',{name:'使用指南',exact:true}).click();}else await page.locator('aside').first().getByRole('button',{name:'使用指南',exact:true}).click();await tour().waitFor();}
async function checkStep(index,width,{screenshot=false}={}){
 const target=index===8&&width<768?'more':targets[index];
 await page.locator(`[data-testid="guide-spotlight"][data-guide-target="${target}"]`).waitFor({timeout:18000});
 await page.waitForTimeout(300);
 const measurement=await page.evaluate(()=>{
  const frame=document.querySelector('[data-testid="guide-spotlight"]'),bubble=document.querySelector('[data-testid="guide-tooltip"]');
  const target=[...document.querySelectorAll(`[data-guide="${frame.dataset.guideTarget}"]`)].find(el=>el.getBoundingClientRect().width>0);
  const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  return {frame:box(frame),target:box(target),bubble:box(bubble),viewport:{width:innerWidth,height:innerHeight},blur:getComputedStyle(target).filter,scrollWidth:document.documentElement.scrollWidth,route:location.pathname+location.search,focusIn:bubble.contains(document.activeElement)};
 });
 const {frame:f,target:t,bubble:b,viewport:v}=measurement;
 assert.equal(measurement.route,routes[index]);
 assert.ok(t.width>0&&t.height>0&&t.x>=-1&&t.y>=-1&&t.right<=v.width+1&&t.bottom<=v.height+1,`real target visible: ${JSON.stringify(measurement)}`);
 assert.ok(Math.abs(f.x-Math.max(4,t.x-6))<2&&Math.abs(f.y-Math.max(4,t.y-6))<2&&Math.abs(f.right-Math.min(v.width-4,t.right+6))<2&&Math.abs(f.bottom-Math.min(v.height-4,t.bottom+6))<2,`frame tracks real target: ${JSON.stringify(measurement)}`);
 assert.ok(b.x>=11&&b.y>=11&&b.right<=v.width-11&&b.bottom<=v.height-11,`bubble inside viewport: ${JSON.stringify(measurement)}`);
 assert.ok(f.right<=b.x||b.right<=f.x||f.bottom<=b.y||b.bottom<=f.y,`bubble does not cover target: ${JSON.stringify(measurement)}`);
 assert.equal(measurement.blur,'none');assert.ok(measurement.scrollWidth<=v.width+2);assert.ok(measurement.focusIn,'focus retained in guide');
 assert.equal(await page.locator('[aria-modal="true"]').count(),1);
 if(screenshot)await page.screenshot({path:`${out}/tour-${width}-${index+1}.png`,fullPage:false});
 return measurement;
}
try{
 await page.goto(base+'/',{waitUntil:'networkidle'});await tour().waitFor();await checkStep(0,1440,{screenshot:true});
 await panel().getByRole('button',{name:'跳过引导',exact:true}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('mentora-guide-v2:tour-a')),'skipped');
 await page.reload({waitUntil:'networkidle'});await closed();
 baselineSessions=await page.evaluate(()=>JSON.parse(localStorage.getItem('mentora-store-tour-a')).state.agentSessions);
 results.push({name:'首次自动框选真实输入框；跳过后刷新不再弹出',pass:true});
 const position=await page.locator('aside').first().evaluate(aside=>{const buttons=[...aside.querySelectorAll('button')];return {guide:buttons.find(b=>b.getAttribute('aria-label')==='使用指南').getBoundingClientRect().bottom,feedback:buttons.find(b=>b.textContent.trim()==='反馈').getBoundingClientRect().top};});assert.ok(position.guide<=position.feedback+1);
 results.push({name:'左下角指南位于反馈正上方',pass:true});
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:850});await openGuide(width);
  for(let index=0;index<targets.length;index++){
   await checkStep(index,width,{screenshot:[0,2,4,8].includes(index)});
   if(index===4){await panel().getByRole('button',{name:'上一步',exact:true}).click();await checkStep(3,width);await panel().getByRole('button',{name:'下一步',exact:true}).click();await checkStep(4,width);}
   for(let k=0;k<3;k++)await page.keyboard.press('Tab');assert.ok(await panel().evaluate(el=>el.contains(document.activeElement)));
   await panel().getByRole('button',{name:index===8?'完成引导':'下一步',exact:true}).click();
  }
  await closed();assert.equal(await page.evaluate(()=>localStorage.getItem('mentora-guide-v2:tour-a')),'completed');
  await page.reload({waitUntil:'networkidle'});await closed();
  results.push({name:`${width}px：9处真实框选、跨页前后切换、说明不遮挡、无横溢、单一引导、焦点限制、完成后不重弹`,pass:true});
 }
 for(const width of [390,844]){
  await page.setViewportSize({width,height:450});await openGuide(width);
  for(let index=0;index<targets.length;index++){await checkStep(index,width);await panel().getByRole('button',{name:index===8?'完成引导':'下一步',exact:true}).click();}await closed();
  results.push({name:`${width}×450px矮屏：9步说明可滚动，仍不覆盖高亮目标`,pass:true});
 }
 await page.setViewportSize({width:1440,height:950});await openGuide(1440);await checkStep(0,1440);await page.setViewportSize({width:390,height:750});await checkStep(0,390);await page.setViewportSize({width:1440,height:950});await checkStep(0,1440);await page.keyboard.press('Escape');await closed();
 results.push({name:'引导中改变屏幕尺寸，框与说明实时重新定位；Esc可退出',pass:true});
 await page.locator('aside').first().getByRole('button',{name:'收起侧栏',exact:true}).click();await openGuide(1440);
 for(let index=0;index<targets.length;index++){await checkStep(index,1440);await panel().getByRole('button',{name:index===8?'完成引导':'下一步',exact:true}).click();}await closed();
 results.push({name:'折叠侧栏的图标入口和各步框选正常',pass:true});
 owner='tour-b';await page.reload({waitUntil:'networkidle'});await tour().waitFor();await checkStep(0,1440);await panel().getByRole('button',{name:'关闭引导',exact:true}).click();await closed();
 assert.equal(await page.evaluate(()=>localStorage.getItem('mentora-guide-v2:tour-b')),'skipped');owner='tour-a';await page.reload({waitUntil:'networkidle'});await closed();
 results.push({name:'账户独立记忆首次引导；关闭按钮有效',pass:true});
 // Missing target is a recoverable state, never an unbounded spinner or fake highlight.
 await openGuide(1440);await checkStep(0,1440);await page.evaluate(()=>document.querySelector('[data-guide="new-chat"]').removeAttribute('data-guide'));await panel().getByRole('button',{name:'下一步',exact:true}).click();await panel().getByRole('button',{name:'重新定位',exact:true}).waitFor({timeout:9000});assert.equal(await page.getByTestId('guide-spotlight').count(),0);await panel().getByRole('button',{name:'跳过此步',exact:true}).click();await checkStep(2,1440);await page.keyboard.press('Escape');await closed();
 results.push({name:'目标缺失5秒后可重试或跳过，不假装框选、不无限等待',pass:true});
 assert.equal(modelCalls,0);assert.ok(writes.every(w=>w.path==='/api/sync'),`unexpected writes ${JSON.stringify(writes)}`);
 const state=await page.evaluate(()=>JSON.parse(localStorage.getItem('mentora-store-tour-a')).state);assert.deepEqual(state.goals,[]);assert.deepEqual(state.knowledge,[]);assert.deepEqual(state.books,[]);assert.deepEqual(state.agentSessions,baselineSessions);assert.deepEqual(errors,[]);
 results.push({name:'未发送模型请求，未额外创建对话、计划、书或笔记',pass:true});
}catch(error){errors.push(error.stack);await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await fs.writeFile(out+'/results.json',JSON.stringify({base,release,fixture:'隔离身份与空数据；接口全拦截，不使用真实账户数据',modelCalls,writes,results,errors},null,2));console.log(JSON.stringify({results,errors,modelCalls},null,2));await browser.close();}
