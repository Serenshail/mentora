import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.BASE||'http://127.0.0.1:3016',release=process.env.RELEASE||'822dfe2',stage=process.env.VERIFY_STAGE||'candidate';
assert.match(stage,/^[a-z0-9-]+$/);
const out=`docs/evidence/guide-2026-11-17/${stage}`;await fs.mkdir(out,{recursive:true});
const health=await(await fetch(base+'/api/health')).json();assert.equal(health.build,release);
const browser=await chromium.launch({executablePath:'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:950}});await ctx.addCookies([{name:'mentora_session',value:'isolated-guide-fixture',url:base}]);
await ctx.addInitScript(()=>{for(const id of ['guide-a','guide-b']){const key='mentora-store-'+id;if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({version:8,state:{goals:[],knowledge:[],books:[],sessions:[],folders:[],customPersonas:[],agentSessions:[],agentActiveId:null}}));}});
let owner='guide-a',modelCalls=0;
await ctx.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;if(path==='/api/chat')modelCalls++;return route.fulfill({json:path==='/api/auth/me'?{user:{userId:owner,email:owner+'@example.invalid',name:'引导隔离验收',entitlement:{status:'active'}}}:path==='/api/sync'?{data:null,updatedAt:new Date().toISOString()}:path==='/api/health'?health:{}});});
const page=await ctx.newPage(),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));
const dialog=()=>page.getByRole('dialog',{name:'欢迎使用 Mentora · 使用指南',exact:true});
const guideEntry=()=>page.locator('aside').first().getByRole('button',{name:'使用指南',exact:true});
async function assertClosed(){await page.waitForTimeout(600);assert.equal(await dialog().count(),0);}
async function openGuide(width){if(width<768){await page.getByRole('button',{name:'更多',exact:true}).click();await page.getByRole('dialog',{name:'更多',exact:true}).getByRole('button',{name:'使用指南',exact:true}).click();}else await guideEntry().click();await dialog().waitFor();await page.waitForFunction(()=>{const el=[...document.querySelectorAll('[role="dialog"]')].find(d=>d.textContent.includes('欢迎使用 Mentora · 使用指南'));if(!el)return false;const css=getComputedStyle(el);return el.classList.contains('open')&&Number(css.opacity)>.99&&['none','blur(0px)'].includes(css.filter);});}
try{
 await page.goto(base+'/',{waitUntil:'networkidle'});await dialog().waitFor();
 await dialog().getByRole('heading',{name:'先说出你现在想做的事',exact:true}).waitFor();
 await dialog().getByRole('button',{name:'跳过引导',exact:true}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('mentora-guide-v2:guide-a')),'skipped');
 await page.reload({waitUntil:'networkidle'});await assertClosed();
 results.push({name:'首次登录自动打开；跳过后刷新不再自动弹出',pass:true});
 const location=await page.locator('aside').first().evaluate(aside=>{const buttons=[...aside.querySelectorAll('button')];const guide=buttons.find(b=>b.getAttribute('aria-label')==='使用指南').getBoundingClientRect();const feedback=buttons.find(b=>b.textContent.trim()==='反馈').getBoundingClientRect();return {guideBottom:guide.bottom,feedbackTop:feedback.top};});
 assert.ok(location.guideBottom<=location.feedbackTop+1);
 results.push({name:'桌面使用指南固定在左下角反馈的正上方',pass:true});
 await openGuide(1440);await dialog().getByRole('button',{name:'下一步',exact:true}).click();
 await dialog().getByRole('heading',{name:'把学习目标变成每天能做的事',exact:true}).waitFor();
 await dialog().getByRole('button',{name:'上一步',exact:true}).click();
 await dialog().getByRole('heading',{name:'先说出你现在想做的事',exact:true}).waitFor();
 await dialog().getByRole('button',{name:/查看第5步/}).click();await dialog().getByRole('button',{name:'开始使用',exact:true}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('mentora-guide-v2:guide-a')),'completed');
 await page.goto(base+'/learn',{waitUntil:'networkidle'});await assertClosed();
 results.push({name:'可前后翻页、直接选步并完成；完成后切页不重弹',pass:true});
 await openGuide(1440);await dialog().getByRole('heading',{name:'先说出你现在想做的事',exact:true}).waitFor();
 await page.keyboard.press('Escape');await assertClosed();
 owner='guide-b';await page.reload({waitUntil:'networkidle'});await dialog().waitFor();await dialog().getByRole('button',{name:'跳过引导',exact:true}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('mentora-guide-v2:guide-b')),'skipped');
 owner='guide-a';await page.reload({waitUntil:'networkidle'});await assertClosed();
 results.push({name:'重新打开从第一步开始；Esc可关闭；不同账户的首次引导独立',pass:true});
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:850});await openGuide(width);
  assert.equal(await page.locator('[aria-modal="true"]').count(),1);
  await dialog().getByRole('button',{name:/查看第4步/}).click();
  assert.equal(await dialog().locator('[aria-current="step"]').count(),1);
  await page.waitForTimeout(450); // Capture the final step colors, rather than their transition frame.
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  const bounds=await dialog().boundingBox();assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=width+1);
  for(let i=0;i<10;i++)await page.keyboard.press('Tab');
  assert.ok(await dialog().evaluate(el=>el.contains(document.activeElement)));
  await page.screenshot({path:`${out}/guide-${width}.png`,fullPage:true});
  await page.keyboard.press('Escape');await assertClosed();
  results.push({name:`${width}px：入口可达、单一弹窗、无横溢、键盘焦点保持在引导内`,pass:true});
 }
 await page.locator('aside').first().getByRole('button',{name:'收起侧栏',exact:true}).click();await guideEntry().click();await dialog().waitFor();await dialog().getByRole('button',{name:'关闭',exact:true}).click();await assertClosed();
 results.push({name:'侧栏收起后仍可通过指南图标打开；关闭按钮正常',pass:true});
 assert.equal(modelCalls,0);assert.deepEqual(errors,[]);
}catch(error){errors.push(error.stack);await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{await fs.writeFile(out+'/results.json',JSON.stringify({base,release,fixture:'隔离身份与空数据；接口全拦截，无真实账户学习数据改动或模型调用',modelCalls,results,errors},null,2));console.log(JSON.stringify({results,errors,modelCalls},null,2));await browser.close();}
