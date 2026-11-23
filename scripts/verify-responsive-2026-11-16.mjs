import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const phase = process.argv[2] || 'after';
const overlaysOnly = process.argv.includes('--overlays-only');
const out = `docs/evidence/responsive-2026-11-16/${phase}`;
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true });
const context = await browser.newContext();
await context.addCookies([{ name: 'mentora_session', value: 'isolated-layout-fixture', url: 'http://127.0.0.1:3002' }]);
const page = await context.newPage();
const errors = [], results = [];
let modelCalls = 0;
page.on('pageerror', e => errors.push(e.message));
await context.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/chat') modelCalls++;
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
try {
  await page.goto('http://127.0.0.1:3002/learn', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForFunction(() => !!window.__mentoraStore);
  await page.evaluate(seed => window.__mentoraStore.setState(seed), seed);
  for (const [width,height] of (overlaysOnly ? [] : [[320,740],[390,844],[768,900],[1024,768],[1440,900],[844,390]])) {
    await page.setViewportSize({ width, height });
    for (const [name,route] of [['home','/'],['learn','/learn'],['growth','/learn?tab=life'],['read','/learn?tab=read'],['reading','/read/layout-book'],['brain','/brain?note=layout-note'],['settings','/settings'],['council','/council']]) {
      await page.goto(`http://127.0.0.1:3002${route}`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.locator('main').waitFor();
      if (phase !== 'before' && name === 'brain') {
        const editorTab = page.locator('button[aria-pressed]').filter({ hasText: /^笔记$/ });
        if (await editorTab.isVisible()) await editorTab.click();
      }
      const data = await metrics();
      if (data.documentWidth > width + 2) data.offenders.push({ tag:'DOCUMENT', right:data.documentWidth });
      if (phase !== 'before' && name === 'brain') assert.ok(data.editorTitleWidth >= 160, `笔记编辑区太窄：${width}px / ${data.editorTitleWidth}`);
      results.push({ name, width, height, ...data });
      if ([320,1024].includes(width)) await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: false });
      console.log(JSON.stringify({ name,width,offenders:data.offenders,editorTitleWidth:data.editorTitleWidth }));
    }
  }
  if (phase !== 'before') {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:3002/learn?tab=read', { waitUntil: 'networkidle' });
    const simulateKeyboard = async height => page.evaluate(height => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: height });
      window.visualViewport.dispatchEvent(new Event('resize'));
    }, height);
    await page.getByRole('button', { name: '添加书籍', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await page.waitForFunction(() => { const el=document.querySelector('[role="dialog"]'); return el.classList.contains('open') && Number(getComputedStyle(el).opacity)>.99; });
    await simulateKeyboard(340);
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--visual-viewport-height') === '340px');
    await page.waitForFunction(() => { const r=document.querySelector('[role="dialog"]').getBoundingClientRect(); return r.y>=-1 && r.bottom<=341; });
    let box = await dialog.boundingBox();
    assert.ok(box.y >= -1 && box.y + box.height <= 341, JSON.stringify(box));
    const submit = dialog.getByRole('button', { name: '生成阅读计划', exact: true });
    await submit.scrollIntoViewIfNeeded();
    assert.equal(await submit.evaluate(el => { const r=el.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el; }), true);
    assert.ok(await dialog.locator('input').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16);
    results.push({ name: '模拟键盘：弹窗/提交按钮可达，手机表单字号至少16px', status:'PASS' });
    await page.keyboard.press('Escape');
    await simulateKeyboard(844);
    await page.getByRole('button', { name: '搜索（Ctrl/Cmd+K）', exact: true }).click();
    await page.waitForFunction(() => { const el=document.querySelector('[role="dialog"]'); return el?.classList.contains('open') && Number(getComputedStyle(el).opacity)>.99 && Number(getComputedStyle(el.parentElement).opacity)>.99; });
    await simulateKeyboard(340);
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--visual-viewport-height') === '340px');
    await page.waitForFunction(() => { const r=document.querySelector('[role="dialog"]').getBoundingClientRect(); return r.y>=-1 && r.bottom<=341; });
    box = await page.getByRole('dialog', { name: '全局搜索' }).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 391 && box.y + box.height <= 341, JSON.stringify(box));
    await page.screenshot({ path: `${out}/search-keyboard-simulated.png` });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(),0);
    await simulateKeyboard(844);
    results.push({ name:'模拟键盘：搜索框与列表留在可见区域，Escape可关闭', status:'PASS' });
    await page.getByRole('button', { name:'打开助手',exact:true }).click();
    await simulateKeyboard(340);
    const assistantInput = page.getByPlaceholder('问点什么…');
    await assistantInput.waitFor();
    await page.waitForFunction(() => { const el=document.querySelector('input[placeholder="问点什么…"]'); const r=el.getBoundingClientRect(); return r.y>=0 && r.bottom<=340; });
    assert.equal(await assistantInput.evaluate(el => { const r=el.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el; }),true);
    const closeAssistant = page.getByTitle('关闭（Esc）', { exact:true });
    assert.equal(await closeAssistant.evaluate(el => { const r=el.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el; }),true,'助手关闭按钮被顶栏遮挡');
    await page.screenshot({ path:`${out}/assistant-keyboard-simulated.png` });
    await closeAssistant.click();
    assert.equal(await assistantInput.count(),0);
    await simulateKeyboard(844);
    results.push({ name:'模拟键盘：助手输入框及关闭按钮可点，顶栏不遮挡',status:'PASS' });
    // Reading-strategy suggestions may be attempted on entry. All are intercepted.
    assert.deepEqual(errors,[]);
    assert.equal(results.filter(r => r.offenders?.length).length,0,'存在未修复的越界内容');
  }
} catch (error) { errors.push(error.stack); process.exitCode = 1; }
finally {
  await fs.writeFile(`${out}/${overlaysOnly ? 'overlay-focused-results' : 'results'}.json`, JSON.stringify({ fixture: '隔离样例；API 全部拦截；不是模型或云同步验收', results, errors, modelCalls },null,2));
  await browser.close();
}
