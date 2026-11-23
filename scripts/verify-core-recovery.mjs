// Browser recovery checks use an isolated storage fixture and intercepted APIs.
// Pass MENTORA_TEST_URL to exercise a production build without writing account data.

import { chromium } from "playwright-core";
import assert from "node:assert/strict";
const base=process.env.MENTORA_TEST_URL||"http://localhost:3116";
const expected=process.env.MENTORA_EXPECT_BUG==="1";
const realResources=process.env.MENTORA_REAL_RESOURCES==="1";
const linkCheckOrigin=process.env.MENTORA_LINKCHECK_ORIGIN;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
const ctx=await browser.newContext({viewport:{width:1440,height:900}});
await ctx.addCookies([{name:"mentora_session",value:"isolated-audit-qa",url:base}]);
let councilCalls=0, readCalls=0;
await ctx.addInitScript(()=>{
 localStorage.setItem("mentora-guide-v2:audit-fixture","skipped");
 const key="mentora-store-audit-fixture";
 if(localStorage.getItem(key))return;
 const now=new Date().toISOString();
 const day={id:"d1",phaseId:"p1",title:"连读听音反应练习",status:"active",knowledgePoints:[{text:"听音反应",knowledgeType:"procedure"}],resources:[],acceptance:[],method:"听完复述",attempts:0};
 const goal={id:"g1",topic:"英语6级",direction:"强化听力",status:"active",domainKind:"exam",weeklyHours:5,motivation:"通过六级",background:"417分",successCriteria:[],quizLog:[],intakeTranscript:[],createdAt:now,plan:{summary:"训练",totalDays:1,weeklyHours:5,createdAt:now,startDate:now.slice(0,10),phases:[{id:"p1",title:"听力能力",outcome:"掌握连读",status:"active",dayIds:["d1"]}],days:{d1:day}}};
 const msg=(id,role,content)=>({id,role,content,at:now});
 const make=(id,personaId,title,messages=[])=>({id,personaId,title,messages,createdAt:now});
 const books=[{id:"b1",title:"我的试读材料",verification:"user_material",pastedText:"习惯积累与记忆",status:"reading",readStatus:"reading",chapters:[{id:"c1",title:"第一章",focusQuestion:"怎样理解",status:"reading"}],chat:[msg("b-u","user","这段材料应该怎么读？")],insights:[],createdAt:now}];
 localStorage.setItem(key,JSON.stringify({version:8,state:{
  goals:[goal],knowledge:[],folders:[],customPersonas:[],books,
  sessions:[make("council-a","graham","伙伴会话甲",[msg("c-u","user","上次停在这里的问题")]),make("council-b","jobs","伙伴会话乙")],
  agentActiveId:"long-chat",agentSessions:[{id:"long-chat",title:"长期会话",createdAt:now,messages:Array.from({length:36},(_,i)=>msg("h"+i,i%2?"assistant":"user","历史消息 "+i))}]
 }}));
});
await ctx.route("**/api/**",async route=>{
 const path=new URL(route.request().url()).pathname;
 if(path==="/api/auth/me") return route.fulfill({json:{user:{userId:"audit-fixture",email:"fixture@example.invalid",name:"页面验收",entitlement:{status:"active"}}}});
 if(path==="/api/search"){
   const {query}=route.request().postDataJSON();
   assert.equal(query,"英语六级听力真题");
   if(realResources) return route.continue();
   return route.fulfill({json:{results:[{title:"英语六级听力真题在线听",url:"https://example.org/listening/audio",snippet:"六级真题听力音频和原文"}]}});
 }
 if(path==="/api/linkcheck"){
   if(realResources && linkCheckOrigin){
     const response=await route.fetch({url:linkCheckOrigin+"/api/linkcheck"});
     return route.fulfill({response});
   }
   if(realResources) return route.continue();
   return route.fulfill({json:{results:route.request().postDataJSON().urls.map(url=>({url,ok:true,dead:false,ad:false,reason:"样例资料可访问"}))}});
 }
 if(path==="/api/chat"){
   const body=route.request().postDataJSON();
   if(body.task==="resource-fix"){
     if (realResources) return route.continue();
     assert.fail("精确匹配并且通过体检的资料不应再等待模型筛选");

   }
   if(body.task==="council"){
     councilCalls++;
     assert.equal(body.messages.filter(m=>m.content==="上次停在这里的问题").length,1);
     return route.fulfill({contentType:"application/x-ndjson",body:'{"t":"d","v":"伙伴继续回答了"}\n{"t":"end"}\n'});
   }
   if(body.task==="reading-chat"){
     readCalls++;
     assert.equal(body.messages.filter(m=>m.content==="这段材料应该怎么读？").length,1);
     return route.fulfill({contentType:"application/x-ndjson",body:'{"t":"d","v":"阅读伙伴继续回答了"}\n{"t":"end"}\n'});
   }
 }
 return route.fulfill({json:path==="/api/sync"?{data:null,updatedAt:new Date().toISOString()}:{}});
});
const page=await ctx.newPage();
const errors=[];
page.on("pageerror",error=>errors.push(error.message));
page.setDefaultTimeout(12000);
const failed=[];
async function check(name,fn){try{await fn();console.log("PASS "+name)}catch(e){if(!expected)throw e;failed.push(name);console.log("复现 "+name+" "+e.message.split("\n")[0]);}}
try{
 await check("首页可以翻到前面的消息",async()=>{
  await page.goto(base+"/");
  await page.getByText("历史消息 35",{exact:true}).waitFor();
  const more=page.getByRole("button",{name:/更早/});
  assert.ok(await more.count(),"历史消息没有展开入口");
  await more.click();
  await page.getByText("历史消息 12",{exact:true}).waitFor();
  await more.click();
  await page.getByText("历史消息 0",{exact:true}).waitFor();
 });
 await check("单聊恢复后一键继续未回答的提问",async()=>{
  await page.goto(base+"/council?session=council-a");
  await page.getByText("上次停在这里的问题",{exact:true}).waitFor();
  const retry=page.getByRole("button",{name:"继续回答",exact:true});
  assert.equal(await retry.count(),1);
  await retry.click();
  await page.getByText("伙伴继续回答了",{exact:true}).waitFor();
  assert.equal(councilCalls,1);
  assert.equal(await page.getByText("上次停在这里的问题",{exact:true}).count(),1);
 });
 await check("伙伴对话切换不串草稿",async()=>{
  await page.goto(base+"/council?session=council-a");
  const a=page.getByPlaceholder(/向 Paul Graham/);
  await a.fill("甲会话尚未发送的草稿");
  await page.getByRole("button",{name:/伙伴会话乙/}).click();
  const b=page.getByPlaceholder(/向 Steve Jobs/);
  assert.equal(await b.inputValue(),"");
  await b.fill("乙会话的草稿");
  await page.getByRole("button",{name:/伙伴会话甲/}).click();
  assert.equal(await a.inputValue(),"甲会话尚未发送的草稿");
 });
 await check("读书对话恢复后可继续，原问题只出现一次",async()=>{
  await page.goto(base+"/read/b1");
  const input=page.getByPlaceholder("说说你的理解、困惑，或反驳…");
  await input.waitFor();
  const retry=page.getByRole("button",{name:"继续回答",exact:true});
  assert.ok(await retry.count(),"阅读聊天没有恢复入口");
  await retry.click();
  await page.getByText("阅读伙伴继续回答了",{exact:true}).waitFor();
  assert.equal(readCalls,1);
  assert.equal(await page.getByText("这段材料应该怎么读？",{exact:true}).count(),1);
 });
 if (!expected) {
  await check("从当天练习搜索并使用可访问的六级听力资料", async () => {
    await page.goto(base+"/learn/g1");
    await page.getByRole("button",{name:"搜索当天资料"}).click();
    const row=page.getByRole("link",{name:/听力|六级/}).filter({has:page.locator("svg")});
    await row.first().waitFor({timeout:80000});
    const result=await row.first().getAttribute("href");
    assert.ok(result?.startsWith("https://"));
    if(realResources) console.log("真实资料结果 "+new URL(result).hostname+new URL(result).pathname);
  });
 } else {
  assert.ok(failed.length>=3);
 }
 assert.deepEqual(errors,[]);
} finally{await browser.close();}

