import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base='http://192.144.181.171';
const out='docs/evidence/tencent-release-2026-11-17';
const health=await (await fetch(base+'/api/health',{cache:'no-store'})).json();
assert.equal(health.build,'fa5c3b1');
assert.equal(health.ok,true);
const browser=await chromium.launch({executablePath:'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',headless:true});
const ctx=await browser.newContext();
// Only synthetic client state and API fixtures; assets and documents come from the live server.
await ctx.addCookies([{name:'mentora_session',value:'isolated-ui-acceptance',url:base}]);
await ctx.addInitScript(()=>{
  const key='mentora-store-release-fixture';
  if(localStorage.getItem(key))return;
  const now=new Date().toISOString();
  const state={books:[{id:'fictional-book',title:'哈哈',status:'reading',verification:'unverified',chapters:[],chat:[],insights:[],createdAt:now}],knowledge:[],goals:[],sessions:[],folders:[],customPersonas:[],agentSessions:[],agentActiveId:null};
  localStorage.setItem(key,JSON.stringify({state,version:8}));
});
let blockedApiRequests=0;
await ctx.route('**/api/**',route=>{
  blockedApiRequests++;
  const path=new URL(route.request().url()).pathname;
  return route.fulfill({json:path==='/api/auth/me'?{user:{userId:'release-fixture',email:'release@example.invalid',name:'上线验收',entitlement:{status:'active'}}}:path==='/api/sync'?{data:null,updatedAt:new Date().toISOString()}:path==='/api/health'?health:{}});
});
const page=await ctx.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const results=[];
try {
  for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    await page.goto(base+'/life?release=fa5c3b1',{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'成长记录',exact:true}).waitFor();
    await page.getByText('最近足迹',{exact:true}).waitFor();
    assert.equal(await page.locator('details[open]').count(),0);
    assert.equal(await page.locator('#growth-history li').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    await page.screenshot({path:`${out}/live-growth-${width}.png`});
    results.push({name:`公网新版本成长页 ${width}px：独立入口、简洁空态、日历折叠`,pass:true});
  }
  await page.goto(base+'/learn?release=fa5c3b1',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'读书伙伴',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'学习人生',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'成长记录',exact:true}).count(),0);
  results.push({name:'公网学习页没有重复成长标签',pass:true});
  await page.goto(base+'/read/fictional-book?release=fa5c3b1',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'先确认《哈哈》的来源',exact:true}).waitFor();
  await page.screenshot({path:`out/live-book-gate.png`.replace('out/',out+'/')});
  results.push({name:'公网生产组件阻断未核实书籍指导',pass:true});
  assert.deepEqual(errors,[]);
}catch(e){errors.push(e.stack);process.exitCode=1;}
finally{
  await fs.writeFile(out+'/public-verification.json',JSON.stringify({build:health.build,healthOk:health.ok,channel:health.channel,fixture:'公网真实页面与静态资源；仅浏览器 API/身份/数据为隔离样例，没有访问或改写真实用户数据，也没有供应商模型调用',results,errors,blockedApiRequests},null,2));
  console.log(JSON.stringify({build:health.build,results,errors},null,2));await browser.close();
}
