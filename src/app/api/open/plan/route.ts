import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { dbGet, dbList, dbPut } from "@/lib/server/db";
import { rateLimitPersistent, clientIp } from "@/lib/server/rate-limit";
import { logEvent } from "@/lib/server/config";
import type { Goal, KnowledgeItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/* 首页仪表盘开放接口（Obsidian vault-home 插件的「今日该做什么」数据源）。
 * 鉴权：请求头 x-open-token，sha256 定长后 timing-safe 比对 env MENTORA_OPEN_TOKEN——
 * 与训记 OpenAPI 同一模式：客户端持令牌，服务端按令牌绑定一个用户。
 * 绑定用户：env MENTORA_OPEN_USER_ID 优先；否则按 MENTORA_OPEN_EMAIL 反查用户档案。
 * 二者都缺时显式 503（不能把部署者之外的邮箱当缺省绑定，静默绑错人比报错更糟）。
 * 只读：数据面 = 该用户云端快照的窄投影，绝不接受任何写路径。 */

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

interface UserRec {
  userId: string;
  email: string;
  name?: string;
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
  /* 绑定是否真的解析到人：env 的 USER_ID 在 users/ 命中档案、或邮箱反查命中，才算 bound。
   * 没 bound 但 userId 仍有值（env 填了无效键且未配 EMAIL / 反查也没命中）时，
   * 不能静默落到 200 空数据——快照读不到就显式 404（见下方绑定校验）。 */
  let bound = false;
  /* EMAIL 不再默认绑作者个人邮箱：其他部署者没配 EMAIL 时会静默绑到第三方邮箱（查不到 404），
   * 与「TOKEN 缺失显式 503」的语义对齐——下面缺配置直接 503。 */
  let email = process.env.MENTORA_OPEN_EMAIL || "";
  let name = "";
  /* EMAIL 反查索引：此前每次请求都全量扫描+解密所有用户档案（插件 30/min 轮询 × N 个加密读烧 KV 配额）。
   * 扫描结果缓存到 open-bind/<sha256(email)> 键（24h），命中后只做 1 次档案校验读；
   * 档案消失/缓存失效自动回落全量重扫并重写缓存。
   * 未命中同样缓存（负缓存，短 TTL）：MENTORA_OPEN_EMAIL 拼错/用户未注册时，
   * 插件按限流上限轮询会持续以 O(N) 全量解密扫描打满 KV/GitHub 配额。 */
  const CACHE_TTL_MS = 24 * 3600_000;
  /* 负缓存 TTL 远短于命中缓存：部署者改 env / 用户注册后 10 分钟内自愈 */
  const MISS_TTL_MS = 10 * 60_000;
  const bindCachePath = (mail: string) =>
    `open-bind/${createHash("sha256").update(mail.toLowerCase()).digest("hex")}.json`;
  const scanByEmail = async (): Promise<boolean> => {
    if (!email) return false; // 没配邮箱就没有可扫的键
    try {
      const cached = await dbGet<{ file?: string; miss?: boolean; at: number }>(bindCachePath(email), { encrypted: true });
      const age = Date.now() - (cached?.at || 0);
      if (cached?.miss && age < MISS_TTL_MS) return false; // 负缓存命中：跳过全量扫描
      if (cached?.file && age < CACHE_TTL_MS) {
        const hit = await dbGet<UserRec>(`users/${cached.file}`, { encrypted: true });
        if (hit) {
          userId = hit.userId;
          name = hit.name || "";
          return true;
        }
      }
    } catch { /* 缓存读失败 → 走全量扫描 */ }
    const files = await dbList("users");
    /* 读成功计数：全部档案都读失败（KV 故障/密钥轮换）时「查不到」不可信，
     * 不能写成负缓存把故障固化成 10 分钟的 404 */
    let readOk = 0;
    for (const f of files) {
      let rec: UserRec | null;
      try {
        rec = await dbGet<UserRec>(`users/${f.name}`, { encrypted: true });
        readOk += 1;
      } catch {
        continue; // 单个档案读失败不拖垮整体扫描
      }
      if (rec && String(rec.email || "").toLowerCase() === email.toLowerCase()) {
        userId = rec.userId;
        name = rec.name || "";
        /* 缓存的是 users/ 目录文件名（f.name 含 .json），不是 UUID——users/ 键空间是邮箱哈希。
         * overwriteOnConflict：该键上可能已有一条负缓存，GitHub 通道裸 PUT 会 422。 */
        await dbPut(bindCachePath(email), { file: f.name, at: Date.now() }, { encrypted: true, overwriteOnConflict: true }).catch(() => {});
        return true;
      }
    }
    /* 未命中写负缓存（不是「什么都没找到」就不缓存）：否则每次轮询都要重扫全部档案。
     * overwriteOnConflict：GitHub 通道对已存在的键裸 PUT 返回 422，不覆盖的话
     * 负缓存 at 永远停在首次写入、TTL 一过就永久失效（等于没修）。写失败不影响本次判定。
     * 仅 readOk > 0 才写：目录为空/全读失败是通道或密钥问题，不是「该邮箱没注册」，
     * 固化成 404 会误导排查。 */
    if (readOk > 0) {
      await dbPut(bindCachePath(email), { miss: true, at: Date.now() }, { encrypted: true, overwriteOnConflict: true }).catch(() => {});
      /* 只在真正扫完一遍时记一次（负缓存把频率压到 10 分钟一次），让配置错误在日志里可见 */
      logEvent({ ev: "open", msg: "bind-miss", scanned: files.length });
    }
    return false;
  };
  try {
    if (userId) {
      const rec = await dbGet<{ userId: string; email: string; name?: string }>(`users/${userId}.json`, { encrypted: true });
      if (rec) {
        bound = true;
        email = rec.email || email;
        name = rec.name || "";
      } else {
        bound = await scanByEmail(); // env 填的是 UUID 或失效键 → 回落邮箱扫描
      }
    } else {
      bound = await scanByEmail();
    }
  } catch (e) {
    /* 绑定阶段读失败是基础设施故障，不能折叠成 404 误诊为「配置错误」（对齐快照读失败的 503 口径） */
    logEvent({ ev: "open", msg: "bind-failed", err: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "绑定用户读取失败，请稍后再试" }, { status: 503 });
  }
  if (!userId && !email) {
    /* 配置缺失要显式失败（与 TOKEN 缺失 503 同语义），不能静默落到 404 让部署者以为是代码坏了 */
    return Response.json(
      { error: "未配置 MENTORA_OPEN_USER_ID / MENTORA_OPEN_EMAIL（二者至少配一个）" },
      { status: 503 }
    );
  }
  if (!userId) return Response.json({ error: "找不到绑定的用户（检查 MENTORA_OPEN_USER_ID / EMAIL）" }, { status: 404 });

  /* ---- 云端快照（密文统一走 dbGet 解密） ---- */
  let goals: Goal[] = [];
  let knowledge: KnowledgeItem[] = [];
  let updatedAt: string | null = null;
  let rec: DataRecord | null = null;
  try {
    rec = await dbGet<DataRecord>(`data/${userId}.json`, { encrypted: true });
    goals = rec?.data?.goals ?? [];
    knowledge = rec?.data?.knowledge ?? [];
    updatedAt = rec?.updatedAt ?? null;
  } catch (e) {
    logEvent({ ev: "open", msg: "data-failed", err: e instanceof Error ? e.message : String(e) });
    return Response.json({ error: "云端数据读取失败" }, { status: 503 });
  }
  if (!bound && !rec) {
    /* env 的 USER_ID 有值但解析不到用户（users/ 档案没命中、邮箱反查没命中或未配 EMAIL），
     * 快照也读不到 → 显式 404。上面 `if (!userId)` 只挡「没值」，挡不住「有值但无效」：
     * 原实现会继续走 data/<无效值>.json 得 null → 200 空任务列表，插件呈现「今日无事可做」，
     * 部署者无从发现配置坏了（env 手误/换库后旧 userId 失效）——与本文件自己的原则
     * （「配置缺失要显式失败」）相悖。注意：bound=false 但快照命中（直接填用户 UUID 兼容
     * data/ 键的旧部署）仍照常放行；档案真实存在（bound=true）但还没同步过快照的新用户
     * 也照常返回空态。 */
    logEvent({ ev: "open", msg: "bind-unresolved", userId });
    return Response.json({ error: "找不到绑定的用户（检查 MENTORA_OPEN_USER_ID / EMAIL）" }, { status: 404 });
  }

  const today = ymd(new Date(), OPEN_TZ);
  const tasks: OpenTask[] = [];

  /* ---- 任务 ①：每个进行中目标的「当前该做的那天」（含迁移门） ---- */
  for (const g of goals) {
    if (!g || g.status !== "active" || !g.plan?.days) continue;
    const days = Object.values(g.plan.days);
    /* d 元素脏数据防护（与下方 counts 的 !g、phases 的 ?. 同口径）：plan.days 的值可能为
     * null/非对象（脏/旧快照经 sync 的 sanitize 直通），裸访问 d.status 抛 TypeError →
     * 整个 GET 裸 500，插件「今日该做什么」整体不可用。 */
    const day =
      days.find((d) => d?.status === "active") ??
      days.find((d) => d?.status === "passed" && d.pendingUnlock);
    if (!day) continue;
    /* phases 缺失的旧快照此前会让整个 GET 500（days 有 ?.,phases 没有防护，口径不一） */
    const phase = g.plan.phases?.find((p) => p.id === day.phaseId);
    const remainingDays = days.filter((d) => d?.status === "active" || d?.status === "locked").length;
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
      /* k 元素脏数据防护（与 !g / counts 同口径）：knowledgePoints 元素可为 null/非对象
       * （sync 的 sanitize 对 FIELDS 数组不做深层校验，任意 JSON 元素可经同步进入快照），
       * 裸 k.text 抛 TypeError → 整个 GET 500。只收 text 为字符串的元素。 */
      points: (day.knowledgePoints || [])
        .slice(0, 4)
        .filter((k) => k != null && typeof k.text === "string")
        .map((k) => k.text),
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
    /* 与上方任务循环的 !g 防护同口径：脏快照混入 null 元素时统计阶段抛 TypeError
     * 会变裸 500（try 只包住读库段），插件「今日该做什么」整体不可用 */
    activeGoals: goals.filter((g) => g && g.status === "active").length,
    doneGoals: goals.filter((g) => g && g.status === "done").length,
  };

  return Response.json(
    { ok: true, generatedAt: new Date().toISOString(), user: { name, email }, today, updatedAt, counts, tasks },
    { headers: { "Cache-Control": "no-store" } }
  );
}
