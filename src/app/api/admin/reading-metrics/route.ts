import { NextRequest } from "next/server";
import { authorizeAdminDetailed } from "@/lib/server/admin-auth";
import { dbReadingEvents } from "@/lib/server/db";
import { logEvent } from "@/lib/server/config";

export const runtime = "nodejs";

/* v26.1 G5：阅读实验指标（管理员 API，白名单会话或 x-admin-password）。
 * 数据源 = events 表（/api/track 落档，dbReadingEvents 拉原始行），纯 JS 聚合——
 * 单机实验期量级（<5k 行）不值得写存储过程，可追溯性优先（PRD 约束 9）。 */

const FUNNEL_ORDER = [
  "reading_started", "goal_confirmed", "roadmap_generated", "learning_node_started",
  "node_assessment_completed", "transfer_started", "transfer_submitted", "transfer_evaluated",
  "book_assessment_completed", "graduation_generated", "second_problem_started",
];

export async function GET(req: NextRequest) {
  /* authorizeAdminDetailed 产出的四类失败原因必须在这里消费（本文件是它唯一调用方）：
   * 后台操作员输错 x-admin-password 要改密码、会话被吊销要重新登录、非管理员账号要换号，
   * 三种处置完全不同——压成单一"未授权"会让操作员无法自助定位。 */
  const auth = await authorizeAdminDetailed(req);
  if (!auth.ok) {
    const error =
      auth.reason === "bad-password"
        ? "后台密码错误"
        : auth.reason === "no-session"
          ? "请先登录或提供管理员密码"
          : "当前账号无管理员权限";
    return Response.json({ ok: false, error, reason: auth.reason }, { status: 401 });
  }
  /* days 非数字（days=abc 等）时 Number 得 NaN，Math.min/max 链消不掉 NaN：
   * D1 通道拼出 '-NaN days'（SQLite 无效修饰符 → 恒假条件）静默返回全零数据，
   * RDS 通道 'NaN days'::interval 解析失败被误报成 503「通道不可用」。
   * 非数字统一回退缺省 30，两条通道拿到的都是合法窗口。 */
  const rawDays = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const days = Math.min(90, Math.max(1, Number.isFinite(rawDays) ? rawDays : 30));
  try {
    const rows = await dbReadingEvents(days);
    if (!rows) return Response.json({ ok: false, error: "events 通道不可用" }, { status: 503 });

    /* 匿名 account 由 /api/track 派生（emailHash），本接口不还原身份 */
    const byUser = new Map<string, { name: string; props: string; at: string }[]>();
    for (const r of rows) {
      if (r.account === "anon") continue;
      const list = byUser.get(r.account) ?? [];
      list.push({ name: r.name, props: r.props, at: r.created_at });
      byUser.set(r.account, list);
    }
    const users = [...byUser.entries()];
    const did = (events: { name: string }[], name: string) => events.some((e) => e.name === name);

    /* 漏斗：按用户去重 */
    const funnel = FUNNEL_ORDER.map((name) => ({ name, users: users.filter(([, es]) => did(es, name)).length }));

    /* 迁移六分类（口径与唯一真源 types.ts transferOutcome 逐支对齐，v26.1 G3）：
     * 复检：independent_success 只认 mode=independent（assisted 降级 assisted_success）、
     *       incomplete 归 partial_success（transferOutcome:427），其余 verdict 直通；
     * 未复检：used_correct 在 mode=assisted 或 hintUsed 时计 assisted_success，否则 partial_success
     *         （transferOutcome:430，未过独立复检的正确应用不算独立成功）；used_wrong → incorrect；
     *         其余（naming_only 等）按 mode 分列（transferOutcome:432）。 */
    const outcomes: Record<string, number> = {
      independent_success: 0, assisted_success: 0, partial_success: 0, incorrect: 0, incomplete: 0, ungradable: 0,
    };
    for (const [, events] of users) {
      for (const e of events) {
        if (e.name !== "transfer_evaluated") continue;
        try {
          const p = JSON.parse(e.props) as { verdict?: string; mode?: string; stage?: string; result?: string; hintUsed?: boolean };
          if (p.stage === "recheck") {
            if (p.result === "independent_success") outcomes[p.mode === "assisted" ? "assisted_success" : "independent_success"] += 1;
            else if (p.result === "incomplete") outcomes.partial_success += 1;
            else if (p.result && p.result in outcomes) outcomes[p.result] += 1;
            continue;
          }
          if (p.verdict === "used_correct") {
            outcomes[p.mode === "assisted" || p.hintUsed ? "assisted_success" : "partial_success"] += 1;
          } else if (p.verdict === "used_wrong") outcomes.incorrect += 1;
          else outcomes[p.mode === "assisted" ? "assisted_success" : "partial_success"] += 1;
        } catch { /* 坏 props 跳过 */ }
      }
    }
    const submitUsers = users.filter(([, es]) => did(es, "transfer_submitted")).length;

    /* 留存：首个有效学习（reading_started/learning_node_started）之后、且在该时点起
     * k 天窗口内（firstLearn, firstLearn + k*86400e3] 是否再发生有效学习
     * （learning_node_started/node_assessment_completed）——即「k 天内回访」。
     * 上界必须封顶：只写 learnsAfter(firstLearn + k*86400e3) 度量的是「第 k 天之后
     * 任意时点」，第 30 天才回访的用户会被算进 D1/D7（d1⊇d7⊇revisit14 反向嵌套），
     * 而首日后 2 小时就回来的高活跃用户反而不计。
     * 未走完观察窗口的用户不计入分母（PRD 约束 6）。 */
    const DAY = 86400e3;
    const parseTs = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
    const perUser = users.map(([account, events]) => {
      const starts = events.filter((e) => e.name === "reading_started" || e.name === "learning_node_started").map((e) => parseTs(e.at)).sort((a, b) => a - b);
      const firstLearn = starts[0] ?? 0;
      const learnsWithin = (from: number, to: number) =>
        events.some((e) => {
          if (e.name !== "learning_node_started" && e.name !== "node_assessment_completed") return false;
          const t = parseTs(e.at);
          return t > from && t <= to;
        });
      const window = (k: number) => (firstLearn > 0 && Date.now() - firstLearn >= k * DAY ? learnsWithin(firstLearn, firstLearn + k * DAY) : null);
      return {
        account,
        firstLearn,
        d1: window(1),
        d7: window(7),
        revisit14: window(14),
        secondProblem: did(events, "second_problem_started"),
        effectiveDone: did(events, "node_assessment_completed") || did(events, "transfer_evaluated"),
        timeline: events.slice(-30).map((e) => ({ n: e.name, at: e.at })),
      };
    });
    const retention = (k: 1 | 7 | 14) => {
      const key = k === 1 ? "d1" : k === 7 ? "d7" : "revisit14";
      const list = perUser.filter((u) => u[key] !== null); // 观察窗口未走完的不进分母
      return { retained: list.filter((u) => u[key] === true).length, eligible: list.length };
    };
    const secondProblemEligible = perUser.filter((u) => u.effectiveDone);

    /* 流失原因分布 */
    const exitReasons: Record<string, number> = {};
    for (const [, events] of users) {
      for (const e of events) {
        if (e.name !== "reading_exit_survey") continue;
        try {
          const p = JSON.parse(e.props) as { reason?: string };
          if (p.reason) exitReasons[p.reason] = (exitReasons[p.reason] ?? 0) + 1;
        } catch { /* ignore */ }
      }
    }

    logEvent({ route: "reading-metrics", users: perUser.length, days });
    return Response.json(
      {
        ok: true,
        days,
        funnel,
        transfer: { outcomes, submitUsers },
        retention: {
          d1: retention(1),
          d7: retention(7),
          revisit14: retention(14),
          secondProblem: { started: perUser.filter((u) => u.secondProblem).length, eligible: secondProblemEligible.length },
        },
        exitReasons,
        users: perUser.map(({ timeline, ...u }) => ({ ...u, timeline })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    logEvent({ route: "reading-metrics", error: e instanceof Error ? e.message : "unknown" });
    return Response.json({ ok: false, error: "统计失败" }, { status: 500 });
  }
}
