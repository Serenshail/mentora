import { describe, expect, it } from "vitest";
import { extractJson, masterPlanSchema, phasePlanSchema, phaseListSchema, quizGradeSchema } from "../ai/client";

/* 端到端冒烟(真模型):本地 `E2E=1 npx vitest run e2e` 且 dev 服务器在跑时执行。
 * 目的:改完任何 AI 链路,先在本地把"引导→总纲要→天级计划→资源修复"整条跑一遍,
 * 用真实 zod schema 校验真实模型输出,全绿才允许部署——防止"改一处坏一处"。
 * CI 无本地服务器,自动跳过。 */
const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
// `npm run e2e` 或 E2E=1 时启用;CI(无本地服务器/无脚本名)自动跳过
const run = !!process.env.E2E || process.env.npm_lifecycle_event === "e2e";

async function chat(body: Record<string, unknown>, timeoutMs = 120_000): Promise<string> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`chat ${res.status}`);
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return (JSON.parse(l) as { v?: string }).v ?? "";
      } catch {
        return "";
      }
    })
    .join("");
}

describe.skipIf(!run)("E2E 学习教练全链路(需 E2E=1 + dev server)", () => {
  it("引导:两轮内能收敛且不空转", async () => {
    const out = await chat({
      task: "intake",
      args: { topic: "雅思", userName: "测试" },
      messages: [
        { role: "user", content: "出国读研,目标6.5,词汇3000,每周15小时晚上学,偏好视频+刷题" },
      ],
    });
    expect(out.trim().length).toBeGreaterThan(10); // 要么追问要么出卡,不许空回复
  }, 150_000);

  it("总纲要:真实输出能过 masterPlanSchema", async () => {
    const card = {
      topic: "雅思", direction: "3 个月达到 6.5", domainKind: "exam",
      motivation: "出国读研", background: "词汇 3000,口语写作弱",
      weeklyHours: 15, learnerProfile: ["晚上学", "偏好视频+刷题"],
      successCriteria: ["模考 6.5"], assumptions: ["3 个月后考试"],
    };
    const full = await chat({
      task: "plan",
      args: { mode: "master", cardJson: JSON.stringify(card, null, 2) },
      messages: [{ role: "user", content: "生成总纲要（只要 JSON）。" }],
    });
    const draft = masterPlanSchema.parse(extractJson(full)); // 解析失败=回归
    expect(draft.phases.length).toBeGreaterThan(0);
  }, 180_000);

  it("天级计划:先出天清单再过 phasePlanSchema(分两步,单请求不再超长)", async () => {
    const ctx = JSON.stringify({
      goal: { topic: "雅思", direction: "3 个月 6.5", background: "词汇3000", domainKind: "exam", weeklyHours: 15, learnerProfile: ["晚上学"] },
      masterSummary: "三阶段:基础→题型→模考",
      phase: { title: "阶段1 · 地基", outcome: "词汇到 5000,语法补齐", outline: ["词汇", "语法"], boundary: "不练写作", estDays: 3 },
      mastered: [], weakPoints: [],
    }, null, 1);
    // 第一步：天清单（boundary + 每天标题与知识点文本）
    const listRaw = await chat({
      task: "plan",
      args: { mode: "phase-list", ctx },
      messages: [{ role: "user", content: "先只输出这个阶段的天清单（只要 JSON）。" }],
    });
    const list = phaseListSchema.parse(extractJson(listRaw));
    expect(list.days.length).toBeGreaterThan(0);

    // 第二步：按批展开细节（真实链路里每批 ≤2 天；这里验第一批）
    const detailRaw = await chat({
      task: "plan",
      args: { mode: "phase-detail", ctx, boundary: list.boundary ?? "", days: JSON.stringify(list.days.slice(0, 2)) },
      messages: [{ role: "user", content: "为指定的这些天写出完整细节（只要 JSON）。" }],
    });
    const detail = phasePlanSchema.parse(extractJson(detailRaw)); // 之前在此处炸(资源元数据过严)
    expect(detail.days.length).toBeGreaterThan(0);
  }, 180_000);

  it("每日讲义:必须含≥1 条可点在线链接(防'零链接'回归)", async () => {
    const ctx = JSON.stringify({
      domainKind: "exam",
      goal: { topic: "雅思", direction: "3 个月 6.5", background: "词汇3000", weeklyHours: 15 },
      day: { title: "Day 1：学术词汇第一批", knowledgePoints: ["词族串记", "搭配"] },
    });
    const full = await chat({
      task: "lesson",
      args: { ctx },
      messages: [{ role: "user", content: "生成今日讲义。" }],
    });
    // 讲义里必须出现 Markdown 链接或裸 URL——只给书名不给链接=不合格
    expect(/\]\(https?:\/\/|https?:\/\/\S+/.test(full)).toBe(true);
  }, 180_000);

  it("验收判分:四级判分+迁移题字段(即时复习门)", async () => {
    const ctx = JSON.stringify({
      domainKind: "exam",
      goal: { topic: "雅思", direction: "3 个月 6.5", background: "词汇3000", weeklyHours: 15 },
      day: {
        title: "Day 1：学术词汇第一批",
        knowledgePoints: [{ text: "词族串记", knowledgeType: "fact" }],
        acceptance: [{ id: "a1", kind: "explain", question: "用自己的话解释什么是词族串记" }],
      },
    });
    const full = await chat({
      task: "quiz-grade",
      args: { ctx },
      messages: [
        { role: "user", content: "开始评分。\n\na1 的用户回答：词族串记就是把同一个词根的一串词放在一起记，比如 act 行动、action 行为、active 活跃的，记一个词根等于记住一串。" },
      ],
      temperature: 0.2,
    });
    const grade = quizGradeSchema.parse(extractJson(full));
    expect(["correct", "partially_correct", "incorrect", "ungradable"]).toContain(grade.items[0]!.verdict);
    expect(typeof grade.overall).toBe("string");
    if (grade.overall === "pass") {
      expect(grade.transferQuestion).toBeTruthy(); // 即时复习门必须给迁移题
    }
  }, 180_000);

  it("读书五模式:苏格拉底契约(必须提问、不得代讲)", async () => {
    const bookCtx = JSON.stringify({
      title: "思考，快与慢", author: "卡尼曼", planSummary: "四单元",
      currentChapter: { title: "单元1 双系统", focusQuestion: "双系统解释了什么?", knowledgeType: "concept", coreIdea: "系统1快系统2慢" },
    });
    const full = await chat({
      task: "reading-chat",
      args: { bookCtx, ragCtx: "", mode: "socratic" },
      messages: [{ role: "user", content: "我读完第一章了，大概就是人有快慢两套思考吧。" }],
      temperature: 0.4,
    });
    // 苏格拉底模式硬契约：回复必须含提问，且不许超长代讲
    expect(full.includes("？") || full.includes("?")).toBe(true);
    expect(full.length).toBeLessThan(500);
  }, 180_000);

  it("资源修复:坏链能得到可访问替代或被置空", async () => {
    const bad = [{ title: "失效资源", url: "https://example.com/definitely-dead-xyz", why: "学习用", reason: "HTTP 404 已失效" }];
    const full = await chat({
      task: "resource-fix",
      args: { bad: JSON.stringify(bad), ctx: "雅思 阶段1 地基" },
      messages: [{ role: "user", content: "替换。" }],
    });
    const reps = extractJson<Array<{ title: string; url: string | null }>>(full);
    expect(Array.isArray(reps)).toBe(true);
    expect(reps.length).toBe(bad.length); // 数量对齐,替换或置空,不许丢项
  }, 120_000);
});
