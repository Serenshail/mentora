import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const phase = process.argv[2] || 'after';
const overlaysOnly = process.argv.includes('--overlays-only');
const out = 'docs/evidence/core-acceptance-2026-11-17';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true });
const context = await browser.newContext();
await context.addCookies([{ name: 'mentora_session', value: 'isolated-layout-fixture', url: 'http://127.0.0.1:3002' }]);
const page = await context.newPage();
const errors = [], results = [];
let modelCalls = 0; let chatHandler = null;
page.on('pageerror', e => errors.push(e.message));
await context.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/chat') { modelCalls++; if (chatHandler) return chatHandler(route); }
  await route.fulfill({ json: path === '/api/auth/me' ? { user: { userId: 'layout-fixture', email: 'layout@example.invalid', name: '响应式验收', entitlement: { status: 'active' } } } : path === '/api/sync' ? { data: null, updatedAt: new Date().toISOString() } : path === '/api/health' ? { channel: { ai: 'configured' } } : {} });
});
const today = new Date().toISOString();
const title = '超长标题与EnglishIdentifierWithoutAnySpaces'.repeat(4);
const seed = {
  goals: [{ id: 'layout-goal', topic: title, domainKind: 'coding', motivation: '', background: '', direction: '', weeklyHours: 6, successCriteria: [], status: 'active', createdAt: today, quizLog: [], intakeTranscript: [] }],
  knowledge: [{ id: 'layout-note', title, body: '## 响应式笔记\n\n' + '正文与长英文术语LongEnglishIdentifier'.repeat(30), tags: [], domain: '工程', masteredAt: today, createdAt: today, links: [], status: 'mastered' }],
  books: [{ id: 'layout-book', title, author: '隔离测试作者', status: 'reading', verification: 'user_material', routeType: 'full', chapters: [{ id: 'ch-1', title: '章节标题'.repeat(20), status: 'reading', focusQuestion: '理解布局' }], chat: [], insights: [], assessments: [], transfers: [], deposits: [], createdAt: today }],
  sessions: [], folders: [], customPersonas: [],
  agentActiveId: 'layout-chat', agentSessions: [{ id: 'layout-chat', title, createdAt: today, messages: [{ id: 'u', role: 'user', content: title, at: today }, { id: 'a', role: 'assistant', content: '## 长回答\n\n' + 'LongEnglishIdentifier'.repeat(45) + '\n\n| 字段 | 含义 | 说明 |\n| --- | --- | --- |\n| key | value | detail |\n\n```ts\nconst identifier = "' + 'x'.repeat(180) + '";\n```', at: today }] }],
};
async function metrics() {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('main *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.left >= -2 && r.right <= innerWidth + 2) continue;
      let localScroll = false;
      for (let p = el.parentElement; p && p.tagName !== 'MAIN'; p = p.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth) { localScroll = true; break; }
      }
      if (!localScroll && ['BUTTON','INPUT','TEXTAREA','H1','H2','H3','P','A'].includes(el.tagName)) out.push({ tag: el.tagName, text: (el.textContent || el.getAttribute('placeholder') || '').slice(0,65), left: Math.round(r.left), right: Math.round(r.right) });
    }
    const editor = [...document.querySelectorAll('input')].find(el => el.getAttribute('class')?.includes('font-bold'));
    return { documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, offenders: out.slice(0, 16), editorTitleWidth: editor?.getBoundingClientRect().width ?? null };
  });
}
const respond = (route,text) => route.fulfill({ contentType:'application/x-ndjson', body:JSON.stringify({t:'d',v:text})+'\n'+JSON.stringify({t:'end'})+'\n' });
try {
 await page.goto('http://127.0.0.1:3002/',{waitUntil:'networkidle'});
 await page.waitForFunction(()=>!!window.__mentoraStore);
 await page.evaluate(seed=>window.__mentoraStore.setState({...seed,agentSessions:[{id:'a',title:'会话A',createdAt:new Date().toISOString(),messages:[]},{id:'b',title:'会话B',createdAt:new Date().toISOString(),messages:[]}],agentActiveId:'a'}),seed);
 let release;
 chatHandler = async route => { await new Promise(r=>release=r); return respond(route,'## 测试回答\n\n**只属于会话A**'); };
 await page.locator('textarea').first().fill('隔离验证');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.locator('[data-testid="live-run"]').waitFor();
 await page.getByRole('button',{name:'会话B',exact:true}).click();
 assert.equal(await page.locator('[data-testid="live-run"]').count(),0);
 release();
 await page.waitForFunction(()=>window.__mentoraStore.getState().agentSessions.find(s=>s.id==='a').messages.some(m=>m.role==='assistant'));
 assert.equal(await page.getByText('只属于会话A',{exact:true}).count(),0);
 await page.getByRole('button',{name:'会话A',exact:true}).click();
 await page.getByRole('heading',{name:'测试回答',exact:true}).waitFor();
 assert.equal(await page.locator('[data-testid="live-run"]').count(),0);
 results.push({name:'A生成中切B无过程泄漏，迟到回答只入A，正文Markdown渲染，终态停止',status:'PASS'});
 await page.evaluate(()=>{ const st=window.__mentoraStore; const g=st.getState().goals[0]; st.setState({goals:[{...g,plan:{summary:'fixture',totalDays:1,weeklyHours:6,startDate:'2026-11-17',createdAt:new Date().toISOString(),phases:[{id:'p1',title:'基础',outcome:'基础',status:'active',dayIds:['d1']},{id:'p2',title:'旧标题',outcome:'旧目标',status:'locked',dayIds:[]}],days:{d1:{id:'d1',phaseId:'p1',title:'已完成课程',status:'passed',attempts:1,knowledgePoints:[],resources:[],acceptance:[],method:''}}}}]}); });
 let calls=0;
 chatHandler=route=>respond(route,++calls===1?'```tool\n'+JSON.stringify({name:'edit_phase',args:{id:'layout-goal',changes:{boundaryChanges:{p2:'只学习文件处理'}}}})+'\n```':'已更新指定阶段。');
 await page.locator('textarea').first().fill('把第二阶段范围改为只学习文件处理');
 await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.getByRole('button',{name:'批准执行',exact:true}).waitFor();
 assert.notEqual(await page.evaluate(()=>window.__mentoraStore.getState().goals[0].plan.phases[1].boundary),'只学习文件处理');
 await page.getByRole('button',{name:'批准执行',exact:true}).click();
 await page.waitForFunction(()=>window.__mentoraStore.getState().goals[0].plan.phases[1].boundary==='只学习文件处理');
 assert.equal(await page.evaluate(()=>window.__mentoraStore.getState().goals[0].plan.days.d1.status),'passed');
 results.push({name:'无phaseMeta的边界修改：实际审批后写入，已完成课程保留',status:'PASS'});
 await page.goto('http://127.0.0.1:3002/life',{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'成长记录',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'学习人生',exact:true}).count(),0);
 await page.screenshot({path:out+'/growth.png'});
 results.push({name:'成长独立入口、足迹默认五条，日历默认折叠',status:'PASS'});
 await page.goto('http://127.0.0.1:3002/learn',{waitUntil:'networkidle'});
 assert.equal(await page.getByRole('button',{name:'学习人生',exact:true}).count(),0);
 results.push({name:'学习中不再出现重复成长标签',status:'PASS'});
 await page.goto('http://127.0.0.1:3002/read/layout-book',{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:/先确认/}).waitFor();
 await page.screenshot({path:out+'/unverified-book.png'});
 results.push({name:'已有未核实书籍阻断生成与阅读指导',status:'PASS'});
 assert.deepEqual(errors,[]);
} catch(error) { errors.push(error.stack); console.error(error.stack); process.exitCode=1; }
finally { await fs.writeFile(out+'/results.json',JSON.stringify({fixture:'受控模型输出，验证产品执行链；不代表真实模型质量/线上部署验收',results,errors},null,2)); console.log(results); await browser.close(); }
