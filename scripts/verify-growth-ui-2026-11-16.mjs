// Isolated UI fixtures only. All API requests are intercepted; no model or cloud writes.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const out = 'docs/evidence/growth-ui-2026-11-16';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Users/haozhe/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe', headless: true });
const context = await browser.newContext();
// Local proxy requires a present cookie; identity itself is mocked below.
await context.addCookies([{ name: 'mentora_session', value: 'isolated-ui-fixture', url: 'http://127.0.0.1:3002' }]);
const page = await context.newPage();
const results = [];
const errors = [];
let modelCalls = 0;
page.on('pageerror', e => errors.push(e.message));
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/chat') modelCalls++;
  const data = url.pathname === '/api/auth/me' ? { user: { userId: 'growth-ui-fixture', email: 'growth-ui@example.invalid', name: '界面验收', entitlement: { status: 'active' } } } : url.pathname === '/api/sync' ? { data: null, updatedAt: new Date().toISOString() } : {};
  await route.fulfill({ json: data });
});
const check = (name, detail = '') => results.push({ name, status: 'PASS', detail });
try {
  await page.goto('http://127.0.0.1:3002/learn?tab=life', { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForFunction(() => !!window.__mentoraStore);
  await page.getByRole('heading', { name: '成长记录', exact: true }).waitFor();
  await page.evaluate(() => {
    const today = new Date().toISOString().slice(0, 10);
    const quizLog = Array.from({ length: 45 }, (_, index) => ({ dayId: `d${index}`, date: index < 4 ? today : new Date(Date.now() - (index - 3) * 86400000).toISOString().slice(0, 10), passed: index !== 2, forced: index === 3, items: [] }));
    window.__mentoraStore.setState({ goals: [{ id: 'growth-fixture', topic: '成长记录长标题测试'.repeat(12), status: 'active', quizLog, createdAt: today, domainKind: 'coding', intakeTranscript: [] }], knowledge: [], sessions: [], books: [] });
  });
  await page.getByText('尚未生成学习计划', { exact: true }).waitFor();
  assert.equal(await page.getByText('全部完成', { exact: true }).count(), 0);
  check('未生成计划不显示全部完成');
  const history = page.locator('#growth-history');
  assert.equal(await history.locator('a').count(), 20);
  await history.getByRole('button', { name: /加载更早记录/ }).click();
  assert.equal(await history.locator('a').count(), 40);
  await history.getByRole('button', { name: /加载更早记录/ }).click();
  assert.equal(await history.locator('a').count(), 45);
  check('45 条记录可分批全部回看');
  await history.getByRole('button', { name: '新掌握', exact: true }).click();
  await history.getByText('这个分类暂无记录，可以切换到其他分类。', { exact: true }).waitFor();
  await history.getByRole('button', { name: '学习验收', exact: true }).click();
  assert.equal(await history.locator('a').count(), 20);
  assert.equal(await history.locator('a').first().getAttribute('href'), '/learn/growth-fixture');
  check('分类空态、切换重置分页、真实来源链接');
  const today = new Date().toISOString().slice(0, 10);
  await page.locator(`[data-date="${today}"]`).click();
  await page.getByText('验收：通过 2/3', { exact: false }).waitFor();
  check('跳过不冒充验收通过');
  await page.evaluate(() => {
    const s = window.__mentoraStore;
    const goals = s.getState().goals;
    s.setState({ goals: goals.map(g => ({ ...g, quizLog: [...g.quizLog, { dayId: 'new', date: new Date().toISOString().slice(0, 10), passed: true, forced: false, items: [] }] })) });
  });
  await page.getByText('验收：通过 3/4', { exact: false }).waitFor();
  check('展开日期的详情随新记录更新');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await page.locator(`[data-date="${today}"]`).evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('ArrowLeft');
  const expected = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-date')), expected);
  check('关闭返回焦点、方向键导航');
  await page.getByRole('button', { name: '近 26 周', exact: true }).click();
  assert.equal(await page.locator('[data-date]').count(), 182);
  await page.getByRole('button', { name: '近 8 周', exact: true }).click();
  assert.equal(await page.locator('[data-date]').count(), 56);
  check('8/26 周视图切换');
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); });
    const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 2, JSON.stringify(metrics));
    await page.screenshot({ path: `${out}/growth-${width}.png`, fullPage: true });
    if (width === 390) await page.screenshot({ path: `${out}/growth-mobile-preview.png`, fullPage: false });
    check(`长标题布局 ${width}px 无整页横溢`, metrics);
  }
  await history.locator('a').first().click();
  await page.waitForURL('**/learn/growth-fixture');
  check('点击记录实际到达对应学习目标');
  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  check('浏览器无运行错误、模型调用为零');
} catch (error) {
  results.push({ name: '执行中断', status: 'FAIL', detail: error.stack });
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await fs.writeFile(`${out}/results.json`, JSON.stringify({ fixture: '隔离样例，全部 API 拦截，不代表模型质量或云同步验收', results, errors, modelCalls }, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}
