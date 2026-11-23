#!/usr/bin/env node
/* 双浏览器真实冲突（PRD §3 验收 2）：同账号、同基线、不同内容并发提交。
 * 期望：一方 200，一方 409（带 currentVersion）；失败方内容不得覆盖胜出方。
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.QA_BASE || "http://localhost:3101";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EVID = "docs/evidence/ict-track1-2026-11-20/gate";
const acct = JSON.parse(fs.readFileSync(".qa-account.json", "utf8"));
const out = (m) => process.stdout.write(`${m}\n`);

const body = (goals) => ({
  goals,
  knowledge: [],
  books: [],
  sessions: [],
  customPersonas: [],
  agentSessions: [],
  settings: { apiKey: "" },
});

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const result = { task: "T-ICT-053", at: new Date().toISOString(), base: BASE, steps: {} };
  try {
    for (const [name, ctx] of [["a", a], ["b", b]]) {
      const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: acct });
      if (!r.ok()) throw new Error(`${name} 登录失败 ${r.status()}`);
    }

    const before = await a.request.get(`${BASE}/api/sync`);
    const snapshot = await before.json();
    const baseVersion = snapshot.version ?? snapshot.updatedAt ?? null;
    result.steps.baseline = { status: before.status(), baseVersion: Boolean(baseVersion) };

    const [ra, rb] = await Promise.all([
      a.request.post(`${BASE}/api/sync`, { data: { data: body([{ id: "g-a", topic: "浏览器A" }]), baseVersion } }),
      b.request.post(`${BASE}/api/sync`, { data: { data: body([{ id: "g-b", topic: "浏览器B" }]), baseVersion } }),
    ]);
    const statuses = [ra.status(), rb.status()].sort();
    result.steps.conflict = { statuses, a: ra.status(), b: rb.status() };
    if (statuses[0] !== 200 || statuses[1] !== 409) throw new Error(`期望 [200,409]，实际 ${statuses}`);

    const loser = ra.status() === 409 ? ra : rb;
    const loserBody = await loser.json();
    const winner = ra.status() === 200 ? ra : rb;
    const winnerBody = await winner.json();
    result.steps.details = {
      currentVersion: loserBody.currentVersion,
      winnerVersion: winnerBody.version ?? winnerBody.updatedAt,
      hasCurrentVersion: typeof loserBody.currentVersion === "string",
    };
    if (typeof loserBody.currentVersion !== "string") throw new Error("409 缺少 currentVersion");

    // 失败方的内容不得出现在云端
    const after = await a.request.get(`${BASE}/api/sync`);
    const cloud = await after.json();
    const topics = (cloud.data?.goals ?? []).map((g) => g.topic);
    const loserTopic = ra.status() === 409 ? "浏览器A" : "浏览器B";
    result.steps.preserved = { cloudTopics: topics, loserTopic, loserNotApplied: !topics.includes(loserTopic) };
    if (topics.includes(loserTopic)) throw new Error("失败方内容被写入云端（应保留冲突）");

    result.status = "PASS";
    out(`PASS: ${JSON.stringify(result.steps)}`);
  } catch (e) {
    result.status = "FAIL";
    result.error = e instanceof Error ? e.message : String(e);
    out(`FAIL: ${result.error}`);
  } finally {
    await browser.close();
    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, "T-ICT-053-double-browser.json"), JSON.stringify(result, null, 2));
  }
  process.exit(result.status === "PASS" ? 0 : 1);
}

main();