import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { dbGet, dbList } from "@/lib/server/db";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";
import type { Goal, KnowledgeItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 首页仪表盘开放接口（Obsidian vault-home 插件的「今日该做什么」数据源）。
 * 鉴权：请求头 x-open-token，sha256 定长后 timing-safe 比对 env MENTORA_OPEN_TOKEN——
 * 与训记 OpenAPI 同一模式：客户端持令牌，服务端按令牌绑定一个用户。
 * 绑定用户：env MENTORA_OPEN_USER_ID 优先；否则按 MENTORA_OPEN_EMAIL（默认本人）扫用户索引。
 * 只读：数据面 = 该用户云端快照的窄投影，绝不接受任何写路径。 */

const DEFAULT_EMAIL = "haow9508@gmail.com";

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.MENTORA_OPEN_TOKEN || "";
  const got = req.headers.get("x-open-token") || "";
  if (!expected || !got) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(got).digest();
  return timingSafeEqual(a, b);
}

interface DataRecord {
  updatedAt?: string;
  data?: { goals?: Goal[]; knowledge?: KnowledgeItem[] };
}

interface OpenTask {
  kind: "day" | "gate" | "review";
  goal: string;
  goalId: string;
  phase?: string;
  dayId?: string;
  title: string;
  points: string[];
  remainingDays?: number;
  deadlineLeft?: number | null;
  url: string;
}

/** 日界：按用户时区取「今天」，默认 Asia/Shanghai。
 *  UTC 日界在东八区 00:00–08:00 会算成前一天，深夜学习（产品文案鼓励的场景）
 *  的「今日任务 / 到期复习」会整体错一天。插件端用同一时区口径（MT_NOW）。 */
const OPEN_TZ = process.env.MENTORA_OPEN_TZ || "Asia/Shanghai";

function ymd(d: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
}

export async function GET(req: NextRequest) {
  if (!(await rateLimitPersistent(`open:${clientIp(req)}`, { capacity: 30, refillPerSec: 30 / 60 }))) {
    return Response.json({ error: "太频繁了，稍后再试" }, { status: 429 });
  }
  if (!process.env.MENTORA_OPEN_TOKEN) {
    return Response.json({ error: "服务端没配 MENTORA_OPEN_TOKEN，接口未开放" }, { status: 503 });
  }
  if (!tokenOk(req)) {
    logEvent({ ev: "open", msg: "denied", ip: clientIp(req) });
    return Response.json({ error: "令牌不对" }, { status: 401 });
  }

  /* ---- 绑定用户 ----
   * MENTORA_OPEN_USER_ID 语义 = users/ 目录的文件名（邮箱哈希）；
   * 也兼容直接填用户 UUID（data/ 键）——先按 users/<id>.json 找档案，找不到再按邮箱扫索引。
   * 此前键空间错位（users/<uuid> 无 .json）导致绑定档案永远查不到（2026-10-24 修复） */
  let userId = process.env.MENTORA_OPEN_USER_ID || "";
  let email = process.env.MENTORA_OPEN_EMAIL || DEFAULT_EMAIL;
  let name = "";
  const scanByEmail = async (): Promise<boolean> => {
    const files = await dbList("users");
    for (const f of files) {
      const rec = await dbGet<{ userId: string; email: string; name?: string }>(`users/${f.name}`, { encrypted: true });
      if (rec && String(rec.email || "").toLowerCase() === email.toLowerCase()) {
        userId = rec.userId;
        name = rec.name || "";
        return true;
      }
    }
    return false;
  };
  try {
    if (userId) {
      const rec = await dbGet<{ userId: string; email: string; name?: string }>(`users/${userId}.json`, { encrypted: true });
      if (rec) {
        email = rec.email || email;
        name = rec.name || "";
      } else {
        await scanByEmail(); // env 填的是 UUID 或失效键 → 回落邮箱扫描
      }
    } else {
      await scanByEmail();
    }
  } catch { /* 用户索引读失败 → 下方 404 兜底 */ }
  if (!userId) return Response.json({ error: "找不到绑定的用户（检查 MENTORA_OPEN_USER_ID / EMAIL）" }, { status: 404 });

  /* ---- 云端快照（密文统一走 dbGet 解密） ---- */
  let goals: Goal[] = [];
  let knowledge: KnowledgeItem[] = [];
  let updatedAt: string | null = null;
  try {
    const rec = await dbGet<DataRecord>(`data/${userId}.json`, { encrypted: true });
    goals = rec?.data?.goals ?? [];
    knowledge = rec?.data?.knowledge ?? [];
    updatedAt = rec?.updatedAt ?? null;
  } catch (e) {
    logEvent({ ev: "open", msg: "data-failed", err: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "云端数据读取失败" }, { status: 503 });
  }

  const today = ymd(new Date(), OPEN_TZ);
  const tasks: OpenTask[] = [];

  /* ---- 任务 ①：每个进行中目标的「当前该做的那天」（含迁移门） ---- */
  for (const g of goals) {
    if (!g || g.status !== "active" || !g.plan?.days) continue;
    const days = Object.values(g.plan.days);
    const day =
      days.find((d) => d.status === "active") ??
      days.find((d) => d.status === "passed" && d.pendingUnlock);
    if (!day) continue;
    const phase = g.plan.phases.find((p) => p.id === day.phaseId);
    const remainingDays = days.filter((d) => d.status === "active" || d.status === "locked").length;
    const deadlineLeft = g.deadline
      ? Math.round((new Date(g.deadline + "T00:00:00").getTime() - new Date(today + "T00:00:00").getTime()) / 86400000)
      : null;
    tasks.push({
      kind: day.pendingUnlock ? "gate" : "day",
      goal: g.topic,
      goalId: g.id,
      phase: phase?.title,
      dayId: day.id,
      title: day.title,
      points: (day.knowledgePoints || []).slice(0, 4).map((k) => k.text),
      remainingDays,
      deadlineLeft,
      url: `/learn/${g.id}`,
    });
  }

  /* ---- 任务 ②：今天到期的复习（FSRS 排期） ---- */
  const dueReviews = knowledge
    .filter((k) => k && k.nextReviewAt && String(k.nextReviewAt).slice(0, 10) <= today)
    .sort((a, b) => String(a.nextReviewAt).localeCompare(String(b.nextReviewAt)));

  for (const k of dueReviews.slice(0, 8)) {
    tasks.push({
      kind: "review",
      goal: k.sourceTitle || "",
      goalId: "",
      title: k.title,
      points: [],
      url: "/life",
    });
  }

  const counts = {
    tasks: tasks.length,
    days: tasks.filter((t) => t.kind !== "review").length,
    reviewsDue: dueReviews.length,
    activeGoals: goals.filter((g) => g.status === "active").length,
    doneGoals: goals.filter((g) => g.status === "done").length,
  };

  return Response.json(
    { ok: true, generatedAt: new Date().toISOString(), user: { name, email }, today, updatedAt, counts, tasks },
    { headers: { "Cache-Control": "no-store" } }
  );
}
