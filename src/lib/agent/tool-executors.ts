"use client";

/* 智能体工具执行器（v2）：按工具名分发到本地 store 或受守卫的服务端端点。
 * 只读工具直接执行；写入工具只做参数校验并返回 PendingAction，
 * 由 UI 审批卡确认后调 executeAction() 真正落库。
 * 涉密操作（apiKey/baseUrl/密码/注销/整包导入导出）不在此表——模型无法调用不存在的东西。 */
import { streamChat, extractJson, readingPlanSchema } from "@/lib/ai/client";
import { useAppStore } from "@/lib/store";
import { verifyBook } from "@/lib/book-verify";
import { buildContext, wikiRetrieve } from "@/lib/rag";
import { todayISO, uid } from "@/lib/utils";
import { track } from "@/lib/track";
import { parseResourceConstraint, classifyResource, validateResources } from "@/lib/resources";
import { searchTerms } from "@/lib/search-relevance";
import { applyPhaseEdit, computePhaseEdit, summarizeDraft, type PhaseEditChanges } from "./phase-edit";
import { DEPOSIT_TYPE_LABELS } from "@/lib/types";
import type { KnowledgeItem, Phase, Plan } from "@/lib/types";
import type {
  PendingAction,
  ToolName,
  ToolResult,
} from "./protocol";
import { TOOLS } from "./protocol";
import { beginRequest, checkBudget, endRequest } from "./request-ledger";
import { goalKey, goalSummary, buildAppContext } from "./app-context";
import { workspaceTool, commitWorkspaceAction } from "./workspace-actions";
import { goalActionTool, commitGoalAction } from "./goal-actions";
import { seatById, ALL_SEAT_METAS, normalizeSeatColor } from "@/lib/ai/persona-meta";
import { isSessionBusy, takePendingRetry, MAX_ROUNDTABLE_SEATS } from "./council-engine";

/** 引用来源（web_search/read_url 产出，随消息持久化渲染） */
export interface Citation {
  title: string;
  url: string;
  /** snippet=搜索摘要（没读过全文）；full=read_url 已取回正文。UI 据此标注，不冒充（PRD §5.2） */
  kind?: "snippet" | "full";
}

export interface ToolOutcome {
  result: ToolResult;
  /** 写入类工具产出：等待用户审批 */
  action?: PendingAction;
  /** 只读联网工具产出：随最终回答展示 */
  citations?: Citation[];
}

const str = (v: unknown) => String(v ?? "").trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** 星期展示：reminders list 与 create 确认文案共用，避免同一字段两种格式（裸数字 0/3） */
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
const formatWeekdays = (days: number[]) =>
  days.length ? `每周${days.map((d) => WEEKDAY_NAMES[d] ?? d).join("、")}` : "每天";

/** 目标定位结果：精确命中 → 单个候选；名称相近 → 候选列表让模型消歧；无命中 → null。
 *  AG-01（PRD §7）：读写动作必须绑定确定目标；同/近名对象不得由包含匹配贪心取值。
 *  优先顺序 = 精确 id → 精确主题名 → 主题唯一识别 → 方向唯一识别。 */
type GoalResolution =
  | { kind: "exact"; goalId: string }
  | { kind: "ambiguous"; candidates: { goalId: string; topic: string; status: string }[] }
  | { kind: "none" };

export function resolveGoal(goals: { id: string; topic: string; direction: string; status: string }[], topic: string, id?: string): GoalResolution {
  const q = goalKey(topic);
  if (id) {
    const g = goals.find((x) => x.id === id);
    return g ? { kind: "exact", goalId: g.id } : { kind: "none" };
  }
  if (!q) return { kind: "none" };
  /* 精确主题名优先（避免「Python」命中「Python Web」这种漂移） */
  const exact = goals.filter((g) => goalKey(g.topic) === q);
  if (exact.length === 1) return { kind: "exact", goalId: exact[0].id };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.map((g) => ({ goalId: g.id, topic: g.topic, status: g.status })) };
  /* 子串但只唯一识别（剩下的不在别的目标主题/方向里重复出现） */
  const sub = goals.filter((g) => goalKey(g.topic).includes(q));
  const uniq = sub.filter((g) => !goals.some((o) => o.id !== g.id && (goalKey(o.topic).includes(q) || goalKey(o.direction || "").includes(q))));
  if (uniq.length === 1) return { kind: "exact", goalId: uniq[0].id };
  const dir = goals.filter((g) => goalKey(g.direction || "").includes(q));
  if (sub.length + dir.length > 0) {
    const candidates = [...new Map([...sub, ...dir].map((g) => [g.id, g])).values()];
    return { kind: "ambiguous", candidates: candidates.map((g) => ({ goalId: g.id, topic: g.topic, status: g.status })) };
  }
  return { kind: "none" };
}

/** 把歧义候选列表渲染成模型可读的消歧文案（不是失败——模型据此再精确指定一次） */
function disambiguateText(candidates: { goalId: string; topic: string; status: string }[]): string {
  const lines = candidates.map((c, i) => {
    const goal=useAppStore.getState().goals.find(g=>g.id===c.goalId);
    return `${i + 1}. 「${c.topic}」（id=${c.goalId}，${c.status}）${goal ? ` 方向：${goal.direction || "未定"}；创建：${goal.createdAt}；当前：${goalSummary(goal).currentDay || "无进行中学习日"}` : ""}`;
  }).join("\n");
  return `有 ${candidates.length} 个相近目标，我不确定你指的是哪个。请选择：\n${lines}\n（回复序号或更精确的主题名）`;
}

/** 书目定位（AG-01，第二批 C）：精确 id → 精确书名 → 唯一子串 → 歧义候选。
 *  书架同书多版本/同名的场景与学习目标同名同样危险，定位语义与 resolveGoal 对齐。 */
type BookResolution =
  | { kind: "exact"; bookId: string }
  | { kind: "ambiguous"; candidates: { bookId: string; title: string; status: string }[] }
  | { kind: "none" };

interface BookLike {
  id: string;
  title: string;
  status: string;
  author?: string;
}

export function resolveBook(books: BookLike[], title: string, id?: string): BookResolution {
  const q = title.trim();
  if (id) {
    const b = books.find((x) => x.id === id);
    return b ? { kind: "exact", bookId: b.id } : { kind: "none" };
  }
  if (!q) return { kind: "none" };
  const exact = books.filter((b) => b.title === q);
  if (exact.length === 1) return { kind: "exact", bookId: exact[0].id };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.map((b) => ({ bookId: b.id, title: b.title, status: b.status })) };
  const sub = books.filter((b) => b.title.includes(q));
  if (sub.length === 1) return { kind: "exact", bookId: sub[0].id };
  if (sub.length > 1) return { kind: "ambiguous", candidates: sub.map((b) => ({ bookId: b.id, title: b.title, status: b.status })) };
  return { kind: "none" };
}

function disambiguateBookText(candidates: { bookId: string; title: string; status: string }[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. 《${c.title}》（${c.status}）`).join("\n");
  return `书架上有 ${candidates.length} 本相近的书，我不确定你指哪本。请选择：\n${lines}\n（回复序号或更精确的书名）`;
}

/** 会话定位（AG-01，批次 D）：精确 id → 精确标题 → 唯一子串 → 歧义候选 */
type SessionResolution =
  | { kind: "exact"; sessionId: string }
  | { kind: "ambiguous"; candidates: { sessionId: string; title: string; count: number }[] }
  | { kind: "none" };

interface SessionLike {
  id: string;
  title: string;
  messages: unknown[];
}

function resolveSession(sessions: SessionLike[], title: string, id?: string): SessionResolution {
  const q = title.trim();
  if (id) {
    const s = sessions.find((x) => x.id === id);
    return s ? { kind: "exact", sessionId: s.id } : { kind: "none" };
  }
  if (!q) return { kind: "none" };
  const exact = sessions.filter((s) => s.title === q);
  if (exact.length === 1) return { kind: "exact", sessionId: exact[0].id };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.map((s) => ({ sessionId: s.id, title: s.title, count: s.messages.length })) };
  const sub = sessions.filter((s) => s.title.includes(q));
  if (sub.length === 1) return { kind: "exact", sessionId: sub[0].id };
  if (sub.length > 1) return { kind: "ambiguous", candidates: sub.map((s) => ({ sessionId: s.id, title: s.title, count: s.messages.length })) };
  return { kind: "none" };
}

function disambiguateSessionText(candidates: { sessionId: string; title: string; count: number }[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. 「${c.title}」（${c.count} 条消息）`).join("\n");
  return `有 ${candidates.length} 个相近会话，我不确定你指哪个。请选择：\n${lines}\n（回复序号或更精确的会话名）`;
}

/** 席位解析（批次 D）：id 或名字 → 引擎席位（内置注册表 / 自建人物）。
 *  missing 返回无法解析的项——席位已被删除时如实列出，不静默跳过。 */
function resolveSeatPersonas(ids: string[]): { list: { id: string; name: string; system?: string }[]; missing: string[] } {
  const store = useAppStore.getState();
  const list: { id: string; name: string; system?: string }[] = [];
  const missing: string[] = [];
  for (const raw of ids) {
    const key = str(raw);
    if (!key) continue;
    const meta = seatById(key);
    if (meta) { list.push({ id: meta.id, name: meta.name }); continue; }
    const custom = store.customPersonas.find((x) => x.id === key);
    if (custom) { list.push({ id: custom.id, name: custom.name, system: custom.system }); continue; }
    const metaByName = ALL_SEAT_METAS.find((m) => m.name === key);
    if (metaByName) { list.push({ id: metaByName.id, name: metaByName.name }); continue; }
    const customByName = store.customPersonas.find((x) => x.name === key);
    if (customByName) { list.push({ id: customByName.id, name: customByName.name, system: customByName.system }); continue; }
    missing.push(key);
  }
  return { list, missing };
}

const seatNameOf = (id: string): string | null =>
  seatById(id)?.name ?? useAppStore.getState().customPersonas.find((x) => x.id === id)?.name ?? null;

/** 继续讨论的上下文合成：原议题 + 最近讨论要点 + 本轮新增约束（有界，防 token 失控） */
function composeSeatQuestion(sess: { messages: { role: string; content: string }[] }, focus: string): string {
  const firstUser = sess.messages.find((m) => m.role === "user");
  const parts: string[] = [];
  if (firstUser) parts.push(`【原议题】${cut(firstUser.content, 200)}`);
  const recent = sess.messages.slice(-4).map((m) => `${m.role === "user" ? "用户" : "AI"}：${cut(m.content, 140)}`);
  if (recent.length) parts.push(`【最近讨论】\n${recent.join("\n")}`);
  if (focus) parts.push(`【本轮新增约束】${focus}`);
  parts.push("请各席位基于以上背景与新增约束发言；不要复述既有发言。");
  return parts.join("\n\n");
}

/** 书路线签名（EX-15 冲突检测）：批准到执行之间书名/目标/路线/章节列表被改则拒绝旧批准 */
function bookRouteSignature(book: { title: string; goal?: unknown; routeType?: string; chapters: { title: string }[] }): string {
  return JSON.stringify({
    title: book.title,
    goal: book.goal ?? null,
    routeType: book.routeType ?? null,
    chapters: book.chapters.map((c) => c.title),
  });
}

/** 工具内触发的真实 provider 生成（审批前预览）：必须与 runner.chat() 同口径记账 + 过预算闸门。
 *  此前 rebuild_reading_route / forge_persona 在**审批之前**直接调 streamChat：既不计入
 *  provider 预算（providerLimit 形同虚设的旁路），也不进账本（花费不可见），
 *  而且没透传 signal（用户点「停止」无法中止在途生成）。三者在此统一收口。
 *  返回 `{ reason }` 表示被预算闸门拒绝（调用方据此返回失败结果，不谎报成功）；
 *  中止/异常原样上抛，与 runner.chat() 的 abort 语义一致。 */
async function streamChatLedgered(opts: {
  task: Parameters<typeof streamChat>[0]["task"];
  args: Record<string, unknown>;
  messages: Parameters<typeof streamChat>[0]["messages"];
  temperature?: number;
  signal?: AbortSignal;
  /** 账本归属（缺省按当前 store 用户 + 工具名合成，供逐条核账） */
  runId: string;
}): Promise<{ text: string; reason?: string }> {
  const store = useAppStore.getState();
  const identity = { userId: store._storeUserId ?? null, sessionId: `tool:${opts.runId}`, runId: opts.runId };
  const gate = checkBudget({ ...identity, task: opts.task ?? "agent", layer: "provider" });
  if (!gate.ok) return { text: "", reason: gate.reason };
  const rec = beginRequest({ ...identity, task: opts.task ?? "agent", round: 0, layer: "provider" });
  /* usage 缺失必须标 unknown（不能当 0，也不能默认声称 provider 回传了用量）。
   * 显式类型：TS 会把「只在回调里赋值」的变量收窄成 never（与 runner.ts 同款写法）。 */
  let usage = null as null | { inputTokens: number; outputTokens: number; cachedTokens: number };
  try {
    const text = await streamChat({
      task: opts.task,
      args: opts.args,
      messages: opts.messages,
      temperature: opts.temperature,
      signal: opts.signal,
      onDelta: () => {},
      onUsage: (u) => {
        usage = u;
      },
    });
    endRequest(rec.id, {
      ok: true,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedTokens: usage?.cachedTokens,
      usageSource: usage ? "provider" : "unknown",
    });
    return { text };
  } catch (e) {
    const aborted = !!opts.signal?.aborted || (e instanceof Error && e.name === "AbortError");
    endRequest(rec.id, { ok: false, error: aborted ? "cancelled" : e instanceof Error ? e.message : "unknown" });
    throw e;
  }
}

/** R04 校验器（异步）：先真实生成新路线，把新旧对照放进审批卡——
 *  修正 F03 模式（先确认请求、执行时才生成写入）：用户批准时已经看得到具体新路线。 */
async function validateRebuildRoute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
  const store = useAppStore.getState();
  const title = str(args.title);
  const id = str(args.id);
  if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
  const res = resolveBook(store.books, title, id);
  if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
  if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
  const book = store.books.find((b) => b.id === res.bookId)!;
  const ROUTE_TYPES = ["full", "core", "goal"];
  const routeType = str(args.routeType);
  if (!ROUTE_TYPES.includes(routeType))
    return { result: { ok: false, content: `routeType 只支持 ${ROUTE_TYPES.join("/")}（完整/核心/目标导向）`, summary: "参数不合法" } };
  const userNote = str(args.userNote);

  try {
    const { readingPlanSchema, extractJson } = await import("@/lib/ai/client");
    const { READING_GOAL_LABELS } = await import("@/lib/types");
    const desc =
      `书名：《${book.title}》${book.author ? ` 作者：${book.author}` : ""}` +
      `${book.verification === "user_material" || book.pastedText ? "\n用户提供的原文材料/目录（以此为准，不要编造未提供的内容）：" : ""}` +
      (book.pastedText ? `\n${book.pastedText.slice(0, 4000)}` : "") +
      `\n当前路线（${book.chapters.length} 节）：${book.chapters.map((c) => c.title).join("、")}`;
    /* 预算 + 记账 + signal 统一走 streamChatLedgered（见其注释：此前审批前生成是账本旁路） */
    const gen = await streamChatLedgered({
      task: "reading-plan",
      args: {
        desc,
        materialOnly: book.verification === "user_material",
        goal: book.goal
          ? {
              primary: READING_GOAL_LABELS[book.goal.primary].label,
              secondary: book.goal.secondary?.map((g) => READING_GOAL_LABELS[g].label).join("、") || undefined,
              intent: book.goal.intent,
            }
          : undefined,
        routeType,
      },
      messages: [{ role: "user", content: userNote ? `重排这本书的阅读路线。用户的调整要求：${userNote}（只要 JSON）。` : "生成阅读路线。（只要 JSON）" }],
      temperature: 0.5,
      signal,
      runId: `rebuild_route:${book.id}`,
    });
    if (gen.reason) return { result: { ok: false, content: gen.reason, summary: "已达上限" } };
    const full = gen.text;
    const plan = readingPlanSchema.parse(extractJson(full));
    const newChapters = plan.chapters.map((c) => ({
      ...c,
      knowledgeType: c.knowledgeType || "concept",
      coreIdea: c.coreIdea || undefined,
      perspectives: c.perspectives || undefined,
      capture: c.capture || undefined,
      keyConcepts: c.keyConcepts || undefined,
      prerequisites: c.prerequisites || undefined,
      expectedOutcome: c.expectedOutcome || undefined,
      assessFocus: c.assessFocus || undefined,
      id: uid("ch"),
      status: "todo" as const,
    }));
    const routeLabel = routeType === "full" ? "完整" : routeType === "core" ? "核心" : "目标导向";
    const oldList = book.chapters.map((c, i) => `  ${i + 1}. [${c.status}] ${c.title}`);
    const newList = newChapters.map((c, i) => `  ${i + 1}. ${c.title}`);
    const preview =
      `《${book.title}》路线重排（${routeLabel}路线，原 ${book.chapters.length} 节 → 新 ${newChapters.length} 节）：\n` +
      `原：\n${oldList.slice(0, 10).join("\n")}${book.chapters.length > 10 ? `\n  …共 ${book.chapters.length} 节` : ""}\n` +
      `新：\n${newList.slice(0, 10).join("\n")}${newChapters.length > 10 ? `\n  …共 ${newChapters.length} 节` : ""}\n` +
      `（应用后：旧路线自动存入历史、可恢复；已完成的验收归档到验收档案；沉淀/对话/洞见保留。生成需一定时间，已提前生成完毕。）`;
    return draftAction("rebuild_reading_route", "重排阅读路线", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      routeType,
      userNote,
      baseSignature: bookRouteSignature(book),
      plan: {
        map: plan.map ? { ...plan.map, generatedAt: new Date().toISOString() } : undefined,
        planSummary: plan.planSummary,
        routeType,
        chapters: newChapters,
      },
      preview,
    });
  } catch (e) {
    return { result: { ok: false, content: `路线生成失败：${e instanceof Error ? e.message : "未知错误"}——未做任何修改，原路线保留。`, summary: "生成失败" } };
  }
}

/** C05 校验器（异步）：蒸馏自定义人物，身份摘要进审批卡供用户核对后入库。
 *  纪律（PRD LIFE-01）：人物观点是模拟分析视角——identityNote 必须如实写明身份来源，
 *  不冒充真实人物对用户问题的真实发言。 */
async function validateForgePersona(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
  const name = str(args.name);
  const hint = str(args.hint);
  if (!name) return { result: { ok: false, content: "需要 name（人物名）", summary: "参数缺失" } };
  try {
    const { personaDistillSchema, extractJson } = await import("@/lib/ai/client");
    const gen = await streamChatLedgered({
      task: "persona-distill",
      args: { name, hint: hint || undefined },
      messages: [{ role: "user", content: `蒸馏：${name}` }],
      temperature: 0.5,
      signal,
      runId: `forge_persona:${name}`,
    });
    if (gen.reason) return { result: { ok: false, content: gen.reason, summary: "已达上限" } };
    const p = personaDistillSchema.parse(extractJson(gen.text));
    const preview =
      `新圆桌人物：${p.name}（${p.tag}）\n` +
      `${p.bio}\n` +
      `身份核对：${p.identityNote}\n` +
      `（人物观点是模拟分析视角，不代表该人物（如有真实原型）对用户问题的真实发言。）`;
    return draftAction("forge_persona", "塑造人物", cut(p.name, 30), {
      name: p.name,
      tag: p.tag,
      bio: p.bio,
      color: normalizeSeatColor(p.color),
      identityNote: p.identityNote,
      system: p.system,
      preview,
    });
  } catch (e) {
    return { result: { ok: false, content: `人物蒸馏失败：${e instanceof Error ? e.message : "未知错误"}——未做任何修改。`, summary: "蒸馏失败" } };
  }
}

/* ========= 只读工具 ========= */

/** read_url 的来源白名单条目归一化：统一 host 大小写/默认端口、去掉 fragment。
 *  两侧（白名单与调用参数）都过一遍同一函数，避免「用户贴的链接末尾多个斜杠/带 #锚点」这类
 *  纯形式差异把合法链接误挡。非 http(s) 或不可解析返回 null。 */
export function normalizeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** executeTool 的可选上下文。只读联网工具（read_url）靠它做来源白名单校验。 */
export interface ToolExecOpts {
  /** 允许 read_url 打开的 URL 集合（归一化后）——用户原话里的链接 + 本轮 web_search 结果。
   *  缺省（直接调用/单测）时不启用该闸门，保持既有语义。 */
  allowedUrls?: ReadonlySet<string>;
  /** 运行的取消信号：透传给联网 fetch，点「停止」才能中止在途只读工具
   *  （P1-2：此前 web_search/read_url 的 fetch 不带 signal，停止后继续跑完，
   *  busy 锁远超 PRD §4.4 的 2s 上限）。 */
  signal?: AbortSignal;
  question?: string;
}

async function runReadTool(
  name: ToolName,
  args: Record<string, unknown>,
  opts: ToolExecOpts = {}
): Promise<ToolOutcome> {
  const store = useAppStore.getState();

  if (name === "search_brain") {
    const query = str(args.query);
    if (!query) return { result: { ok: false, content: "缺少 query 参数", summary: "参数缺失" } };
    const notes = store.knowledge.filter((k) => !(k.tags ?? []).includes("MOC"));
    if (notes.length === 0)
      return { result: { ok: true, content: "用户第二大脑里还没有笔记。", summary: "笔记库为空" } };
    const hits = wikiRetrieve(
      query,
      notes.map((k) => ({
        id: k.id, title: k.title, body: k.body, domain: k.domain,
        links: k.links, version: k.version, updatedAt: k.updatedAt, tags: k.tags,
      })),
      3
    );
    if (hits.length === 0)
      return { result: { ok: true, content: "没有找到相关笔记。", summary: "0 条" } };
    const content = buildContext(hits, query, 1600);
    return {
      result: {
        ok: true,
        content: `找到 ${hits.length} 篇相关笔记：\n${content}`,
        summary: `${hits.length} 篇：${cut(hits.map((h) => h.doc.title).join("、"), 40)}`,
      },
    };
  }

  if (name === "read_context") {
    const payload = JSON.parse(buildAppContext());
    return {
      result: {
        ok: true,
        content: JSON.stringify(payload),
        summary: `${payload.goalCount} 个目标 · 待复习${payload.dueReviews}`,
      },
    };
  }

  if (name === "get_note") {
    const id = str(args.id);
    const title = str(args.title);
    if (!id && !title) return { result: { ok: false, content: "需要 id 或 title 之一", summary: "参数缺失" } };
    /* AG-01：只读直返也必须绑定确定目标——歧义时返回候选让模型消歧，
     * 不能贪心取第一篇（错误正文会无任何关卡直接进模型上下文）。 */
    const res = resolveNote(id, title);
    if (res.kind === "none") return { result: { ok: true, content: "没有找到这篇笔记。", summary: "未找到" } };
    if (res.kind === "ambiguous")
      return { result: { ok: true, content: disambiguateNoteText(res.candidates), summary: `${res.candidates.length} 个候选` } };
    const note = res.note;
    return {
      result: {
        ok: true,
        content: `《${note.title}》（domain: ${note.domain || "未分类"}）\n\n${cut(note.body, 4000)}`,
        summary: cut(note.title, 24),
      },
    };
  }

  if (name === "list_goals") {
    if (store.goals.length === 0)
      return { result: { ok: true, content: "还没有学习目标。", summary: "0 个" } };
    const query=goalKey(str(args.query));
    const filtered=store.goals.filter(g=>(!query||goalKey(`${g.topic} ${g.direction || ""}`).includes(query))&&(!args.status||g.status===args.status));
    const offset=typeof args.offset==="number"&&Number.isFinite(args.offset)?Math.max(0,Math.floor(args.offset)):0;
    const limit=typeof args.limit==="number"&&Number.isFinite(args.limit)?Math.min(50,Math.max(1,Math.floor(args.limit))):25;
    const goals=filtered.slice(offset,offset+limit).map(goalSummary);
    return {
      result: { ok: true, content: JSON.stringify({total:filtered.length,allCount:store.goals.length,offset,goals,nextOffset:offset+goals.length<filtered.length?offset+goals.length:null}), summary: `${filtered.length} 个匹配目标 · 本页 ${goals.length} 个` },
    };
  }

  if (name === "get_goal") {
    const topic = str(args.topic);
    const id = str(args.id);
    if (!topic && !id) return { result: { ok: false, content: "缺少 topic 或 id", summary: "参数缺失" } };
    const res = resolveGoal(store.goals, topic, id);
    if (res.kind === "none") return { result: { ok: true, content: `没有找到与「${topic}」相关的目标。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: true, content: disambiguateText(res.candidates), summary: `${res.candidates.length} 个候选` } };
    const goal = store.goals.find((g) => g.id === res.goalId)!;
    const days = goal.plan ? Object.values(goal.plan.days) : [];
    const active = days.find((d) => d.status === "active");
    const done = days.filter((d) => d.status === "passed").length;
    const content = [
      `目标：${goal.topic}（id=${goal.id}，${goal.status}，创建于 ${goal.createdAt}）`,
      goal.direction ? `方向：${goal.direction}` : "",
      goal.motivation ? `动机：${goal.motivation}` : "",
      goal.plan ? `计划：${goal.plan.summary}（${done}/${days.length} 天完成）` : "尚无计划（引导/计划在学习页进行）",
      /* ACT-01（A01/A02）：把阶段的稳定 id 与序号交给模型——用户说「第二阶段」时它要把
       * 自然语言序号解析成当时的稳定 phaseId，而不是猜。此前 get_goal 不返回任何阶段 id，
       * 模型只能凭空编 id，edit_phase 必然报「阶段不存在」，计划调整因此「只检索不落地」。 */
      goal.plan
        ? `阶段（序号=用户口语顺序；精确修改用 edit_phase 的 changes.phaseMeta[阶段id]）：\n${goal.plan.phases
            .map((ph, i) => {
              const ids = ph.dayIds ?? [];
              const doneN = ids.filter((id) => {
                const st = goal.plan?.days[id]?.status;
                return st === "passed" || st === "skipped";
              }).length;
              const lines = [`  ${i + 1}. ${ph.title}（id=${ph.id}${ph.estDays ? `，约 ${ph.estDays} 天` : ""}，${doneN}/${ids.length} 天已完成）`];
              /* 天级明细（A04/Q08）：模型必须知道**哪一天**已完成，否则改计划时只能猜
               * 「保留已完成」要保留什么。上一轮真实输出就卡在「只看到已完成 1 天的计数，
               * 具体是哪一天没在计划里标出来」。带稳定 dayId 与状态，可直接用于 phaseCatalogs。 */
              for (const id of ids) {
                const d = goal.plan?.days[id];
                if (!d) continue;
                const state =
                  d.status === "passed" ? "已完成"
                  : d.status === "skipped" ? "已跳过"
                  : d.status === "active" ? "进行中"
                  : "未开始";
                lines.push(`       - ${d.title}（id=${id}，${state}）`);
              }
              return lines.join("\n");
            })
            .join("\n")}`
        : "",
      active ? `当前任务：${active.title}——验收标准：${(active.acceptance ?? []).map((a) => a.question).join("；")}` : "",
      goal.successCriteria.length ? `成功标准：${goal.successCriteria.join("；")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return { result: { ok: true, content, summary: cut(goal.topic, 20) } };
  }

  if (name === "list_books") {
    if (store.books.length === 0)
      return { result: { ok: true, content: "书架是空的。", summary: "0 本" } };
    const lines = store.books.slice(0, 10).map((b) => {
      const done = b.chapters.filter((c) => c.status === "done").length;
      return `- 《${b.title}》（${b.status}，${done}/${b.chapters.length} 章）${b.author ? `作者：${b.author}` : ""}`;
    });
    /* 截断必须让模型看见：summary 报真实总数却只列前 10 条时，模型会以为第 11 本起
     * 不存在，用户点名要读的书若排在后面就答「书架上没有」。 */
    if (store.books.length > 10) lines.push(`（仅列出前 10 本，共 ${store.books.length} 本；其余书名请让用户给出更精确的书名或直接打开书架查看）`);
    return { result: { ok: true, content: lines.join("\n"), summary: `${store.books.length} 本` } };
  }

  if (name === "list_sessions") {
    if (store.sessions.length === 0)
      return { result: { ok: true, content: "人生伙伴还没有会话。", summary: "0 个" } };
    const lines = store.sessions.slice(0, 10).map((sess) => {
      const last = sess.messages[sess.messages.length - 1];
      return `- ${sess.title}（${sess.messages.length} 条${last ? `，最近：${cut(last.content, 20)}` : ""}）`;
    });
    if (store.sessions.length > 10) lines.push(`（仅列出前 10 个，共 ${store.sessions.length} 个；其余会话请让用户给出更精确的会话名或直接打开人生伙伴查看）`);
    return { result: { ok: true, content: lines.join("\n"), summary: `${store.sessions.length} 个` } };
  }

  /* 注：get_settings_public 的读取块已删除——executeTool 在分发前就整体拦截该工具
   * （设置不可由智能体读取），此处永远不可达。 */

  if (name === "make_quiz") {
    const topic = str(args.topic) || "刚才讲的内容";
    const count = Math.max(2, Math.min(Number(args.count ?? 3) || 3, 5));
    const goalId = str(args.goalId) || "";
    const dayId = str(args.dayId) || "";
    /* AQ-03（PRD §6）：检验题必须针对刚讲的指定目标/天，不能误用别的活跃项目。
     * 定位顺序：精确 goalId → 精确 dayId 归属 → topic 匹配目标 → 该目标当天。 */
    let targetDay: { goalId: string; day: { title: string; knowledgePoints?: { text: string }[] } } | null = null;
    if (dayId) {
      for (const g of store.goals) {
        const d = g.plan?.days[dayId];
        if (d) { targetDay = { goalId: g.id, day: { title: d.title, knowledgePoints: d.knowledgePoints } }; break; }
      }
    } else if (goalId) {
      const g = store.goals.find((x) => x.id === goalId);
      const d = g?.plan ? Object.values(g.plan.days).find((x) => x.status === "active") : null;
      if (g && d) targetDay = { goalId: g.id, day: { title: d.title, knowledgePoints: d.knowledgePoints } };
    } else if (topic && topic !== "刚才讲的内容") {
      const res = resolveGoal(store.goals, topic);
      if (res.kind === "exact") {
        const g = store.goals.find((x) => x.id === res.goalId)!;
        const d = g.plan ? Object.values(g.plan.days).find((x) => x.status === "active") : null;
        if (d) targetDay = { goalId: g.id, day: { title: d.title, knowledgePoints: d.knowledgePoints } };
      }
    } else {
      /* 兜底：首个 active 目标的当天（与旧行为一致，但明确标注来源） */
      const g = store.goals.find((x) => x.status === "active");
      const d = g?.plan ? Object.values(g.plan.days).find((x) => x.status === "active") : null;
      if (g && d) targetDay = { goalId: g.id, day: { title: d.title, knowledgePoints: d.knowledgePoints } };
    }
    const material = targetDay?.day?.knowledgePoints?.map((k) => k.text).slice(0, count) ?? [];
    const quiz: string[] = [];
    for (let i = 0; i < count; i++) {
      const m = material[i];
      quiz.push(
        m
          ? `${i + 1}. 关于「${m}」：用自己的话解释它是什么、为什么需要它，并举一个最小例子。`
          : `${i + 1}. 关于「${topic}」：说出一个最容易被误解的点，并解释为什么误解是错的。`
      );
    }
    /* AQ-03 纪律：无可用知识点时如实说明来源，不套用到别项目 */
    const sourceNote = targetDay
      ? `\n（题目针对「${targetDay.day.title}」生成）`
      : "";
    const missingNote = targetDay && material.length === 0
      ? `\n注意：该天还没有可检验的知识点清单，题目只能围绕主题泛化；用户说“针对刚讲内容出题”时应如实说明缺材料，不能拿别项目的内容凑数。`
      : "";
    return {
      result: {
        ok: true,
        content: `已生成 ${count} 道自测题${sourceNote}：\n${quiz.join("\n")}${missingNote}\n\n请把题目原样放在回答末尾（不要附答案），提示用户先自己想。`,
        summary: `${count} 道题`,
      },
    };
  }

  if (name === "web_search") {
    const query = str(args.query);
    if (!query) return { result: { ok: false, content: "缺少 query", summary: "参数缺失" } };
    if (opts.question && searchTerms(query).length === 0) {
      return { result: { ok: false, content: "搜索词缺少具体主题。请结合用户问题中的主题重新搜索。", summary: "搜索词过于宽泛" } };
    }
    const requestedExam = /(?:英语)?四级|cet[-\s]?4/i.test(opts.question || "") ? /四级|cet[-\s]?4/i
      : /(?:英语)?六级|cet[-\s]?6/i.test(opts.question || "") ? /六级|cet[-\s]?6/i : null;
    if (requestedExam && !requestedExam.test(query)) {
      return { result: { ok: false, content: "搜索词遗漏用户提出的考试，请带上考试名称重新搜索。", summary: "搜索词缺少主题" } };
    }
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: opts.signal,
      });
      const j = (await res.json()) as { error?: string; results?: { title: string; url: string; snippet: string }[] };
      if (!res.ok || j.error) {
        return { result: { ok: false, content: `搜索失败：${j.error ?? res.status}`, summary: "搜索失败" } };
      }
      const results = j.results ?? [];
      if (results.length === 0)
        return { result: { ok: true, content: "没有搜到相关结果。", summary: "0 条" } };
      /* 这些只是搜索摘要，没有读过全文——kind 标 snippet，UI 不冒充已核实（PRD §5.2） */
      const citations: Citation[] = results.map((r) => ({ title: r.title, url: r.url, kind: "snippet" as const }));
      const content = results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${cut(r.snippet, 200)}`)
        .join("\n\n");
      return {
        result: { ok: true, content: `搜索到 ${results.length} 条结果：\n\n${content}\n\n回答时注明来源编号或链接。`, summary: `${results.length} 条结果` },
        citations,
      };
    } catch (e) {
      /* 与 read_url 同口径：用户点「停止」不是搜索失败，是取消。 */
      if (opts.signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
        return { result: { ok: false, content: "已停止：搜索被取消。", summary: "已取消" } };
      }
      return { result: { ok: false, content: `搜索失败：${e instanceof Error ? e.message : "网络错误"}`, summary: "搜索失败" } };
    }
  }

  if (name === "read_url") {
    const url = str(args.url);
    if (!/^https?:\/\//i.test(url))
      return { result: { ok: false, content: "url 必须以 http/https 开头", summary: "参数不合法" } };
    /* 来源白名单（防间接提示注入外带）：read_url 是自动执行的只读工具，被注入的网页内容
     * 可指示模型把用户笔记拼进 url 的 query（如 https://evil.com/?d=<笔记>）——服务端
     * fetch-page 只做 SSRF/形状校验、不认识 query 语义，照抓不误，攻击者服务器即拿到数据。
     * 合法来源只有两处（与 prompts.ts 的 read_url 纪律同一口径）：用户原话里给出的链接、
     * 本轮 web_search 返回的结果链接。opts.allowedUrls 缺省时不启用（直接调用/单测语义不变）。 */
    if (opts.allowedUrls) {
      const norm = normalizeHttpUrl(url);
      if (!norm || !opts.allowedUrls.has(norm)) {
        return {
          result: {
            ok: false,
            content:
              "这个 URL 不在允许打开的来源里：read_url 只能打开用户原话里给出的链接，或本轮 web_search 返回的结果链接。先 web_search 检索再打开结果里的链接；绝不把用户笔记/上下文数据拼进 URL。",
            summary: "来源受限",
          },
        };
      }
    }
    try {
      const res = await fetch("/api/fetch-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: opts.signal,
      });
      const j = (await res.json()) as { error?: string; title?: string; text?: string };
      if (!res.ok || j.error || !j.text) {
        return { result: { ok: false, content: `读取失败：${j.error ?? res.status}`, summary: "读取失败" } };
      }
      return {
        result: {
          ok: true,
          content: `《${j.title || "无标题"}》正文（截取）：\n${j.text}`,
          summary: cut(j.title || url, 24),
        },
        citations: [{ title: j.title || url, url, kind: "full" as const }],
      };
    } catch (e) {
      if (opts.signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
        return { result: { ok: false, content: "已停止：读取被取消。", summary: "已取消" } };
      }
      return { result: { ok: false, content: `读取失败：${e instanceof Error ? e.message : "网络错误"}`, summary: "读取失败" } };
    }
  }

  /* ---- 第二批 C（AG-05 R01）：读取指定书的详细状态 ---- */
  if (name === "get_book") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id 之一", summary: "参数缺失" } };
    if (store.books.length === 0) return { result: { ok: true, content: "书架是空的。", summary: "0 本" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: true, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: true, content: disambiguateBookText(res.candidates), summary: `${res.candidates.length} 个候选` } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const done = book.chapters.filter((c) => c.status === "done").length;
    const skipped = book.chapters.filter((c) => c.status === "skipped").length;
    const mastered = book.chapters.filter((c) => c.masteredAt).length;
    const lines: string[] = [
      `《${book.title}》${book.author ? `（${book.author}）` : ""} id=${book.id}`,
      `全书状态：${book.readStatus ?? book.status}${book.routeType ? ` · ${book.routeType === "full" ? "完整" : book.routeType === "core" ? "核心" : "目标导向"}路线` : ""}${book.verification ? ` · 核查:${book.verification}` : ""}`,
      book.goal
        ? `阅读目标：主=${book.goal.primary}${book.goal.secondary.length ? `，次=${book.goal.secondary.join("/")}` : ""}${book.goal.intent ? `（${book.goal.intent}）` : ""}${book.goal.background ? `；已有基础：${book.goal.background}` : ""}`
        : "阅读目标：未设定",
      `进度：${done}/${book.chapters.length} 章读完，${skipped} 章跳过，${mastered} 章验收通过`,
      ...book.chapters.slice(0, 20).map((c, i) => `  ${i + 1}. [${c.status}] ${c.title}${c.masteredAt ? "（已验收掌握）" : ""}`),
      book.chapters.length > 20 ? `  …共 ${book.chapters.length} 章` : "",
      book.deposits?.length ? `沉淀：${book.deposits.length} 条` : "沉淀：0 条",
      book.transfers?.length ? `迁移：${book.transfers.length} 次` : "",
    ].filter(Boolean);

    /* R06：带章节详情——给模型讨论/检验当前材料所需的全部上下文 */
    const chapterKey = str(args.chapterTitle);
    if (chapterKey) {
      const byIdx = /^\d+$/.test(chapterKey) ? book.chapters[Number(chapterKey) - 1] : null;
      const ch = byIdx ?? book.chapters.find((c) => c.title === chapterKey) ?? book.chapters.find((c) => c.title.includes(chapterKey)) ?? null;
      if (!ch) {
        lines.push(`\n没有找到章节「${chapterKey}」。`);
      } else {
        lines.push(
          ``,
          `—— 章节详情（id=${ch.id}）：${ch.title} [${ch.status}${ch.masteredAt ? " · 已掌握" : ""}] ——`,
          ch.coreIdea ? `核心论点：${ch.coreIdea}` : "",
          `本章问题：${ch.focusQuestion}`,
          ch.keyConcepts?.length ? `关键概念：${ch.keyConcepts.join("、")}` : "",
          ch.perspectives?.length ? `其他观点：${ch.perspectives.join("；")}` : "",
          ch.prerequisites?.length ? `前置：${ch.prerequisites.join("、")}` : "",
          ch.expectedOutcome ? `预期成果：${ch.expectedOutcome}` : "",
          ch.assessFocus ? `验收锚点：${ch.assessFocus}` : "",
          `接续入口：/read/${book.id}（打开后从「${ch.title}」继续，带着用户的问题与上面这些背景讨论）`
        );
        /* 该章已有沉淀：作为讨论素材（保留原话） */
        const chDeposits = (book.deposits ?? []).filter((d) => d.chapterId === ch.id);
        if (chDeposits.length) lines.push(`用户本章已有沉淀：${chDeposits.slice(0, 3).map((d) => `「${cut(d.text, 60)}」`).join("；")}`);
        /* 该章最近验收：避免重复出题、衔接上次结果 */
        const lastAssess = (book.assessments ?? []).filter((a) => a.chapterId === ch.id).slice(-1)[0];
        if (lastAssess) lines.push(`上次验收（${lastAssess.kind}/${lastAssess.level}）：${cut(lastAssess.question, 60)}`);
      }
    }
    return { result: { ok: true, content: lines.filter(Boolean).join("\n"), summary: cut(book.title, 20) } };
  }

  /* ---- 第二批 C（AG-05 N05）：复习队列（list 读；enable/record 走审批） ---- */
  if (name === "review_queue") {
    const action = str(args.action) || "list";
    if (action === "list") {
      const today = todayISO();
      const due = store.knowledge.filter((k) => k.nextReviewAt && k.nextReviewAt <= today);
      const inQueue = store.knowledge.filter((k) => k.nextReviewAt);
      if (inQueue.length === 0) return { result: { ok: true, content: "复习队列是空的。学习/读书产出的知识点会自动进入。", summary: "0 条" } };
      const lines = [
        `今日待复习 ${due.length} 条，队列共 ${inQueue.length} 条：`,
        ...inQueue.slice(0, 10).map((k) => `- ${k.title}${k.nextReviewAt && k.nextReviewAt <= today ? "（今天）" : `（${k.nextReviewAt}）`}`),
        inQueue.length > 10 ? `…共 ${inQueue.length} 条` : "",
      ].filter(Boolean);
      return { result: { ok: true, content: lines.join("\n"), summary: `${due.length}/${inQueue.length} 待复习` } };
    }
    if (action === "enable") {
      const r = resolveNoteOrFail(str(args.id), str(args.title), "没有找到这篇笔记。");
      if ("failure" in r) return r.failure;
      const note = r.note;
      const enabled = typeof args.enabled === "boolean" ? args.enabled : true;
      return draftAction("review_queue", enabled ? "加入复习队列" : "移出复习队列", cut(note.title, 30), {
        action: "enable",
        id: note.id,
        title: note.title,
        enabled,
      });
    }
    if (action === "record") {
      const r = resolveNoteOrFail(str(args.id), str(args.title), "没有找到这篇笔记。");
      if ("failure" in r) return r.failure;
      const note = r.note;
      if (typeof args.ok !== "boolean")
        return { result: { ok: false, content: "需要 ok（boolean）：用户这次复习答对了吗。依据用户真实作答提交，不能凭模型判断伪造。", summary: "参数缺失" } };
      return draftAction("review_queue", "提交复习表现", cut(note.title, 30), {
        action: "record",
        id: note.id,
        title: note.title,
        ok: args.ok,
      });
    }
    return { result: { ok: false, content: "action 只支持 list/enable/record", summary: "参数不合法" } };
  }

  /* ---- 批次 D（AG-06 C01）：读取指定会话详情 ---- */
  if (name === "get_session") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id 之一", summary: "参数缺失" } };
    if (store.sessions.length === 0) return { result: { ok: true, content: "人生伙伴还没有会话。", summary: "0 个" } };
    const res = resolveSession(store.sessions, title, id);
    if (res.kind === "none") return { result: { ok: true, content: `没有找到会话「${title}」。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: true, content: disambiguateSessionText(res.candidates), summary: `${res.candidates.length} 个候选` } };
    const sess = store.sessions.find((s) => s.id === res.sessionId)!;
    const firstUser = sess.messages.find((m) => m.role === "user");
    const last3 = sess.messages.slice(-3).map((m) => `${m.role === "user" ? "用户" : "AI"}：${cut(m.content, 80)}`);
    const content = [
      `会话「${sess.title}」 id=${sess.id}（${sess.messages.length} 条消息，创建于 ${sess.createdAt.slice(0, 10)}）`,
      sess.participants?.length ? `与会人物：${sess.participants.join("、")}` : `席位：${sess.personaId}`,
      firstUser ? `议题（首条）：${cut(firstUser.content, 120)}` : "议题：（还没有消息）",
      sess.messages.length ? `最近消息：\n${last3.join("\n")}` : "",
      `接续入口：/council?session=${sess.id}（打开即自动选中本会话）`,
    ].filter(Boolean).join("\n");
    return { result: { ok: true, content, summary: cut(sess.title, 20) } };
  }

  if (name === "resume_workflow") {
    const kind = str(args.kind) || "auto";
    const title = str(args.title);
    const tryKinds: string[] =
      kind === "auto" ? ["learning", "reading", "council"] : [kind];
    for (const k of tryKinds) {
      if (k === "learning") {
        /* 无 title 时按「活跃/草稿目标」兜底，可能一个都没有——goalId 允许为 null。
         * 用独立的局部联合类型表达，而不是 `as GoalResolution`：exact 变体在
         * GoalResolution 里约定 goalId 必为 string，硬压断言会把「可能没有目标」
         * 这一事实从类型系统里抹掉，下方的 !res.goalId 守卫就失去类型保护。 */
        const res: GoalResolution | { kind: "exact"; goalId: string | null } = title || str(args.id)
          ? resolveGoal(store.goals, title, str(args.id))
          : { kind: "exact", goalId: store.goals.find((g) => g.status === "active")?.id ?? store.goals.find((g) => g.status === "draft")?.id ?? null };
        if (res.kind === "ambiguous") {
          return { result: { ok: true, content: disambiguateText(res.candidates), summary: `${res.candidates.length} 个候选` } };
        }
        if (res.kind !== "exact" || !res.goalId) continue;
        const goal = store.goals.find((g) => g.id === res.goalId)!;
        const days = goal.plan ? Object.values(goal.plan.days) : [];
        const done = days.filter((d) => d.status === "passed" || d.status === "skipped").length;
        const url = !goal.plan || goal.status === "draft" ? `/learn/new?goal=${goal.id}` : `/learn/${goal.id}`;
        track("workflow_resume", { to: "learn", topic: cut(goal.topic, 24) });
        return {
          result: {
            ok: true,
            content: `找到学习目标「${goal.topic}」（${goal.status}${days.length ? `，${done}/${days.length} 天完成` : "，尚无计划"}）。接续入口：[${!goal.plan || goal.status === "draft" ? "继续引导对话" : "继续学习"}](${url})${goal.status === "draft" ? "（从上次引导对话继续）" : ""}`,
            summary: cut(goal.topic, 24),
          },
        };
      }
      if (k === "reading") {
        /* 与 learning 分支同一纪律（文件头 98-99 行）：有 title 时走 resolveBook，
         * 同书多版本（《深度工作》vs《深度工作（注释版）》）必须交给模型消歧，
         * 不能用裸 includes 取第一个子串命中。 */
        let book: (typeof store.books)[number] | undefined;
        if (title || str(args.id)) {
          const res = resolveBook(store.books, title, str(args.id));
          if (res.kind === "ambiguous") {
            return { result: { ok: true, content: disambiguateBookText(res.candidates), summary: `${res.candidates.length} 个候选` } };
          }
          if (res.kind !== "exact") continue;
          book = store.books.find((b) => b.id === res.bookId);
        } else {
          book = store.books.find((b) => b.status === "reading") ?? store.books[0];
        }
        if (!book) continue;
        const doneCh = book.chapters.filter((c) => c.status === "done").length;
        track("workflow_resume", { to: "read", title: cut(book.title, 24) });
        return {
          result: {
            ok: true,
            content: `找到书架里的《${book.title}》（${book.status}，${doneCh}/${book.chapters.length} 章完成）。接续入口：[继续阅读](/read/${book.id})——打开后从当前节点继续。`,
            summary: cut(book.title, 24),
          },
        };
      }
      if (k === "council") {
        /* 同 reading 分支：会话同名/近名交给模型消歧，不用裸 includes 贪心取首个。 */
        let sess: (typeof store.sessions)[number] | undefined;
        if (title || str(args.id)) {
          const res = resolveSession(store.sessions, title, str(args.id));
          if (res.kind === "ambiguous") {
            return { result: { ok: true, content: disambiguateSessionText(res.candidates), summary: `${res.candidates.length} 个候选` } };
          }
          if (res.kind !== "exact") continue;
          sess = store.sessions.find((x) => x.id === res.sessionId);
        } else {
          sess = store.sessions[0];
        }
        if (!sess) continue;
        track("workflow_resume", { to: "council", title: cut(sess.title, 24) });
        return {
          result: {
            ok: true,
            content: `找到会话「${sess.title}」（${sess.messages.length} 条消息）。接续入口：[进入这场讨论](/council?session=${sess.id})——打开即自动选中该会话。`,
            summary: cut(sess.title, 24),
          },
        };
      }
    }
    return {
      result: {
        ok: true,
        content: "没有找到可恢复的工作流。可以问用户想开始什么，或用 create_goal/add_book/create_session 新建。",
        summary: "无可恢复项",
      },
    };
  }

  if (name === "memory" || name === "reminders") {
    return runPersonalTool(name, args, opts);
  }

  return { result: { ok: false, content: "未知只读工具", summary: "未知工具" } };
}

/* ========= 个人扩展工具（v24.0 二期）：读走 API 直查，写产 action 待确认 ========= */

async function runPersonalTool(name: ToolName, args: Record<string, unknown>, opts: ToolExecOpts = {}): Promise<ToolOutcome> {
  const action = str(args.action);
  const signal = opts.signal;

  if (name === "memory") {
    if (action === "recall") {
      const q = str(args.query);
      const res = await fetch(`/api/memory?q=${encodeURIComponent(q)}&limit=20`, { signal });
      const j = (await res.json().catch(() => ({}))) as { error?: string; entries?: { id: string; text: string; tags: string[] }[]; total?: number };
      /* 与写路径（executeAction memory）一致检查 res.ok：服务端 5xx 不得伪装成「还没有记忆」 */
      if (!res.ok || j.error)
        return { result: { ok: false, content: `记忆检索失败：${j.error ?? res.status}`, summary: "检索失败" } };
      const entries = j.entries ?? [];
      if (entries.length === 0)
        return { result: { ok: true, content: q ? "没有检索到相关记忆。" : "还没有长期记忆。", summary: "0 条" } };
      return {
        result: {
          ok: true,
          content: entries.map((m) => `- ${m.text}${m.tags.length ? `（${m.tags.join("/")}）` : ""}`).join("\n"),
          summary: `${entries.length} 条（共 ${j.total ?? entries.length}）`,
        },
      };
    }
    if (action === "remember") {
      const text = str(args.text);
      if (text.length < 4) return { result: { ok: false, content: "text 太短", summary: "参数不足" } };
      return draftAction("memory", "记住一条事实", cut(text, 40), {
        action: "remember",
        text,
        tags: Array.isArray(args.tags) ? args.tags.map((t) => str(t)).filter(Boolean).slice(0, 5) : [],
      });
    }
    if (action === "forget") {
      const id = str(args.id);
      if (!id) return { result: { ok: false, content: "需要 id（先用 action=recall 拿到）", summary: "参数不足" } };
      return draftAction("memory", "忘掉一条记忆", cut(str(args.text) || id, 40), { action: "forget", id });
    }
    return { result: { ok: false, content: "action 只支持 recall/remember/forget", summary: "参数不合法" } };
  }

  /* reminders */
  if (action === "list") {
    const res = await fetch("/api/reminders", { signal });
    const j = (await res.json().catch(() => ({}))) as {
      error?: string;
      reminders?: { id: string; title: string; time: string; days: number[]; enabled: boolean }[];
    };
    /* 与 memory recall 一致：服务端错误不得伪装成「还没有提醒」 */
    if (!res.ok || j.error)
      return { result: { ok: false, content: `提醒列表获取失败：${j.error ?? res.status}`, summary: "获取失败" } };
    const list = j.reminders ?? [];
    if (list.length === 0) return { result: { ok: true, content: "还没有定时提醒。", summary: "0 条" } };
    const dayNames = WEEKDAY_NAMES;
    return {
      result: {
        ok: true,
        content: list
          .map(
            (r) =>
              `- ${r.title}：${r.time}${r.days.length ? `，周${r.days.map((d) => dayNames[d]).join("")}` : "，每天"}${r.enabled ? "" : "（已停用）"}（id: ${r.id}）`
          )
          .join("\n"),
        summary: `${list.length} 条`,
      },
    };
  }
  if (action === "create") {
    const title = str(args.title);
    const time = str(args.time);
    if (!title || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      return { result: { ok: false, content: "需要 title 和 HH:mm 格式的 time", summary: "参数不足" } };
    const days = Array.isArray(args.days)
      ? args.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];
    return draftAction("reminders", "新建定时提醒", `${cut(title, 20)} · ${time}`, {
      action: "create",
      title,
      prompt: str(args.prompt) || title,
      time,
      days,
    });
  }
  if (action === "delete") {
    const id = str(args.id);
    if (!id) return { result: { ok: false, content: "需要 id（先用 action=list 拿到）", summary: "参数不足" } };
    return draftAction("reminders", "删除定时提醒", cut(str(args.title) || id, 30), { action: "delete", id });
  }
  return { result: { ok: false, content: "action 只支持 list/create/delete", summary: "参数不合法" } };
}

/* ========= 写入工具：校验 + 生成待确认 action（不执行） ========= */

/** 笔记定位（AG-01，PRD §7）：精确 id → 精确标题 → 唯一子串 → 歧义候选。
 *  此前 findNote 用 `find(k => k.title.includes(title))` 取第一个命中：库里同时有《Python》
 *  和《Python 进阶》时按插入序贪心取值，delete_note 可能删错、get_note（只读直返）会把
 *  错误内容直接喂给模型且无任何关卡。与 resolveGoal/resolveBook/resolveSession 同口径。 */
type NoteResolution =
  | { kind: "exact"; note: KnowledgeItem }
  | { kind: "ambiguous"; candidates: { id: string; title: string }[] }
  | { kind: "none" };

function resolveNote(id: string, title: string): NoteResolution {
  const store = useAppStore.getState();
  /* id 先查；查不到再退回标题（调用方常把同一串同时当 id 与 title 传，
   * 如 link_notes 的 from/to；不能因为「看着像 id」就放弃标题匹配）。 */
  if (id) {
    const n = store.knowledge.find((k) => k.id === id);
    if (n) return { kind: "exact", note: n };
  }
  const q = title.trim();
  if (!q) return { kind: "none" };
  const exact = store.knowledge.filter((k) => k.title === q);
  if (exact.length === 1) return { kind: "exact", note: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.map((k) => ({ id: k.id, title: k.title })) };
  const sub = store.knowledge.filter((k) => k.title.includes(q));
  if (sub.length === 1) return { kind: "exact", note: sub[0] };
  if (sub.length > 1) return { kind: "ambiguous", candidates: sub.map((k) => ({ id: k.id, title: k.title })) };
  return { kind: "none" };
}

function disambiguateNoteText(candidates: { id: string; title: string }[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. 《${c.title}》（id=${c.id}）`).join("\n");
  return `有 ${candidates.length} 篇相近笔记，我不确定你指哪篇。请选择：\n${lines}\n（回复序号、更精确的标题，或直接用 id）`;
}

/** 写入类工具用的笔记定位：唯一命中才返回 note，歧义/未命中都返回可直接回给模型的失败结果。 */
function resolveNoteOrFail(
  id: string,
  title: string,
  notFound: string
): { note: KnowledgeItem } | { failure: ToolOutcome } {
  const res = resolveNote(id, title);
  if (res.kind === "exact") return { note: res.note };
  if (res.kind === "ambiguous")
    return { failure: { result: { ok: false, content: disambiguateNoteText(res.candidates), summary: "需消歧" } } };
  return { failure: { result: { ok: false, content: notFound, summary: "未找到" } } };
}

function draftAction(
  kind: ToolName,
  label: string,
  summary: string,
  payload: Record<string, unknown>
): ToolOutcome {
  return {
    result: { ok: true, content: `已生成「${label}」草稿，等待用户确认后执行。`, summary: "待确认" },
    action: { id: uid("pa"), kind, label, summary, payload },
  };
}

/** 是否为「明确、可逆的小改动」：只涉及一个阶段的 title，且没有任何其它改动类别。
 *  多阶段/多字段/任何结构改动都返回 false，走审批门（ACT-02）。
 *  planSignature 的冲突校验由 applyPhaseEdit 内部继续兜底（版本变了会拒绝）。 */
function isExplicitPhaseRename(changes: PhaseEditChanges): boolean {
  const keys = Object.keys(changes).filter((k) => {
    const v = (changes as Record<string, unknown>)[k];
    if (v == null) return false;
    return Array.isArray(v) ? v.length > 0 : Object.keys(v as Record<string, unknown>).length > 0;
  });
  if (keys.length !== 1 || keys[0] !== "phaseMeta") return false;
  const meta = changes.phaseMeta ?? {};
  const ids = Object.keys(meta);
  if (ids.length !== 1) return false;
  const patch = meta[ids[0]] ?? {};
  const fields = Object.keys(patch).filter((f) => (patch as Record<string, unknown>)[f] != null);
  return fields.length === 1 && fields[0] === "title" && !!String(patch.title ?? "").trim();
}

/** 阶段定位（AG-01，与 resolveGoal/resolveBook/resolveSession 同口径）：
 *  精确标题 → 唯一子串 → 歧义候选；phaseTitle 缺省时取当前阶段（活跃天所属 → active → 首阶段）。
 *  此前 regenerate_phase / update_plan_resources 都用 `phases.find(ph => ph.title.includes(x))`
 *  贪心取第一个：「第二阶段」同时命中「第二阶段 基础」和「第二阶段 进阶」时会静默改错阶段。 */
type PhaseResolution =
  | { kind: "exact"; phase: Phase }
  | { kind: "ambiguous"; candidates: { id: string; title: string }[] }
  | { kind: "none" };

function resolvePhase(plan: Plan, phaseTitle: string): PhaseResolution {
  const q = phaseTitle.trim();
  if (!q) {
    const active =
      plan.phases.find((ph) => plan.days && Object.values(plan.days).some((d) => d.phaseId === ph.id && d.status === "active")) ??
      plan.phases.find((ph) => ph.status === "active") ??
      plan.phases[0];
    return active ? { kind: "exact", phase: active } : { kind: "none" };
  }
  const exact = plan.phases.filter((ph) => ph.title === q);
  if (exact.length === 1) return { kind: "exact", phase: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact.map((ph) => ({ id: ph.id, title: ph.title })) };
  const sub = plan.phases.filter((ph) => ph.title.includes(q));
  if (sub.length === 1) return { kind: "exact", phase: sub[0] };
  if (sub.length > 1) return { kind: "ambiguous", candidates: sub.map((ph) => ({ id: ph.id, title: ph.title })) };
  return { kind: "none" };
}

function disambiguatePhaseText(candidates: { id: string; title: string }[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. 「${c.title}」（id=${c.id}）`).join("\n");
  return `该目标有 ${candidates.length} 个相近阶段，我不确定你指哪个。请选择：\n${lines}\n（回复序号或更精确的阶段名）`;
}

function validateWriteTool(name: ToolName, args: Record<string, unknown>): ToolOutcome {
  const store = useAppStore.getState();

  if (name === "save_note") {
    const title = str(args.title);
    const body = str(args.body);
    if (!title || !body)
      return { result: { ok: false, content: "缺少 title 或 body", summary: "参数缺失" } };
    if (store.knowledge.some((k) => k.title.trim() === title))
      return {
        result: { ok: false, content: `已存在同名笔记《${title}》。要更新内容请用 update_note。`, summary: "同名已存在" },
      };
    return draftAction("save_note", "新建笔记", cut(title, 30), {
      title,
      body,
      domain: str(args.domain) || "笔记",
    });
  }

  if (name === "update_note") {
    const r = resolveNoteOrFail(str(args.id), str(args.title), "没有找到要修改的笔记。");
    if ("failure" in r) return r.failure;
    const note = r.note;
    const newTitle = str(args.newTitle);
    const body = typeof args.body === "string" ? args.body.trim() : "";
    if (!newTitle && !body)
      return { result: { ok: false, content: "newTitle 和 body 至少提供一个", summary: "参数缺失" } };
    /* 改名必须查重名（与 save_note/update_book 同口径）：否则会造出两篇同名笔记，
     * 破坏 resolveNote/AG-01 的精确匹配，后续按标题定位都会变成歧义。 */
    if (newTitle && newTitle !== note.title && store.knowledge.some((k) => k.id !== note.id && k.title.trim() === newTitle))
      return {
        result: { ok: false, content: `已有同名笔记《${newTitle}》。请换一个标题，或先合并/删除同名笔记。`, summary: "同名已存在" },
      };
    return draftAction(
      "update_note",
      "修改笔记",
      `${cut(note.title, 20)}${newTitle ? ` → ${cut(newTitle, 20)}` : ""}`,
      { id: note.id, newTitle: newTitle || undefined, body: body || undefined }
    );
  }

  if (name === "delete_note") {
    const r = resolveNoteOrFail(str(args.id), str(args.title), "没有找到要删除的笔记。");
    if ("failure" in r) return r.failure;
    return draftAction("delete_note", "删除笔记", cut(r.note.title, 30), { id: r.note.id, title: r.note.title });
  }

  if (name === "regenerate_phase") {
    const topic = str(args.topic);
    const userNote = str(args.userNote);
    if (!topic) return { result: { ok: false, content: "需要 topic", summary: "参数不足" } };
    const res = resolveGoal(store.goals, topic, str(args.id));
    if (res.kind === "none") return { result: { ok: false, content: "没有找到该目标的计划。", summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateText(res.candidates), summary: "需消歧" } };
    const goal = store.goals.find((g) => g.id === res.goalId)!;
    if (!goal?.plan) return { result: { ok: false, content: "没有找到该目标的计划。", summary: "未找到" } };
    const phaseTitle = str(args.phaseTitle);
    const pr = resolvePhase(goal.plan, phaseTitle);
    if (pr.kind === "none") return { result: { ok: false, content: "没有找到指定阶段。", summary: "未找到阶段" } };
    if (pr.kind === "ambiguous") return { result: { ok: false, content: disambiguatePhaseText(pr.candidates), summary: "需消歧" } };
    const phase = pr.phase;
    const completed = phase.dayIds.filter((id) => {
      const d = goal.plan!.days[id];
      return d && (d.status === "passed" || d.status === "skipped");
    }).length;
    return draftAction("regenerate_phase", "重排学习阶段", cut(`${goal.topic} · ${phase.title}`, 30), {
      goalId: goal.id,
      phaseId: phase.id,
      phaseTitle: phase.title,
      userNote,
      completed,
    });
  }

  if (name === "update_plan_resources") {
    const topic = str(args.topic);
    const constraintText = str(args.constraintText);
    if (!topic || !constraintText)
      return { result: { ok: false, content: "需要 topic 和 constraintText（用户原话）", summary: "参数不足" } };
    const res = resolveGoal(store.goals, topic, str(args.id));
    if (res.kind === "none") return { result: { ok: false, content: "没有找到该目标的计划。", summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateText(res.candidates), summary: "需消歧" } };
    const goal = store.goals.find((g) => g.id === res.goalId)!;
    if (!goal?.plan) return { result: { ok: false, content: "没有找到该目标的计划。", summary: "未找到" } };
    const days = Object.values(goal.plan.days);
    const phaseTitle = str(args.phaseTitle);
    /* 与 regenerate_phase 同一套 AG-01 阶段定位：缺省取首阶段（本工具语义就是「整阶段重出」），
     * 指定了名字则精确→唯一→歧义，不再贪心取第一个子串命中。 */
    const pr = phaseTitle.trim() ? resolvePhase(goal.plan, phaseTitle) : { kind: "exact" as const, phase: goal.plan.phases[0] };
    if (pr.kind === "none" || (pr.kind === "exact" && !pr.phase))
      return { result: { ok: false, content: "没有找到指定阶段。", summary: "未找到阶段" } };
    if (pr.kind === "ambiguous") return { result: { ok: false, content: disambiguatePhaseText(pr.candidates), summary: "需消歧" } };
    const phase = pr.phase;
    /* 只处理已展开（非 stub）的天：stub 天进入时会由 setDayDetail 整体重写，
     * 此前写入 stub 天的资源会被新生成的 detail 静默覆盖，操作无效还谎报成功。 */
    const dayIds = phase.dayIds.filter((id) => {
      const d = goal.plan!.days[id];
      return d && !d.stub;
    });
    if (dayIds.length === 0)
      return {
        result: {
          ok: false,
          content: "该阶段的天级目录还没有展开为完整计划（都是占位天），暂时不能替换资源——这些天进入学习时会按最新约束自动生成内容。",
          summary: "无可替换天",
        },
      };
    const constraint = parseResourceConstraint(constraintText);
    if (constraint.resourceType !== "video")
      return { result: { ok: false, content: "本工具目前只处理视频类资源。请直接用一句话告诉我想换成的资源类型（比如“换成图文教程”“换成B站视频”），我按新约束重新检索并更新；文档类资源调整能力在后续版本开放。", summary: "约束不支持" } };
    return draftAction("update_plan_resources", "重出阶段视频资源", cut(`${goal.topic} · ${phase.title}`, 30), {
      goalId: goal.id,
      phaseId: phase.id,
      phaseTitle: phase.title,
      topic,
      constraintText,
      dayIds,
    });
  }

  if (name === "edit_phase") {
    const topic = str(args.topic);
    const id = str(args.id);
    if (!topic && !id) return { result: { ok: false, content: "需要 topic 或 id（精确目标）", summary: "参数缺失" } };
    const res = resolveGoal(store.goals, topic, id);
    if (res.kind === "none") return { result: { ok: false, content: "没有找到该目标。", summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateText(res.candidates), summary: "需消歧" } };
    const goal = store.goals.find((g) => g.id === res.goalId)!;
    if (!goal?.plan) return { result: { ok: false, content: "该目标还没有计划，无法编辑阶段。", summary: "无计划" } };
    const changes = (args.changes ?? {}) as PhaseEditChanges;
    /* 计算方案草稿（只计算、展示差异，不写业务数据——AG-02） */
    const computed = computePhaseEdit(goal, changes);
    if (!computed.ok) return { result: { ok: false, content: computed.content, summary: computed.summary } };
    /* ACT-01/A01（PRD §1.2.6）：明确、可逆的小改动按用户原指令**执行一次**，不再要求二次批准。
     * 判据故意收窄到「只改一个阶段的标题」——这是 A01「把 Python 第二阶段标题改为文件与数据处理」
     * 那一类；结构性重排/增删阶段/重出天目录/改边界一律仍走审批（下方 draftAction）。
     * 直接执行同样先 snapshotPhase 存历史，可恢复，不是无痕迹的偷改。 */
    if (isExplicitPhaseRename(computed.draft.changes)) {
      const applied = applyPhaseEdit(computed.draft);
      if (!applied.ok) return { result: applied };
      return {
        result: {
          ok: true,
          content: `${applied.content}
（这是你明确指定的单个小改动，已按原指令直接执行一次；阶段历史版本已保留，可在学习页恢复。）`,
          summary: applied.summary,
        },
      };
    }
    return draftAction("edit_phase", "编辑学习计划", cut(goal.topic, 30), {
      goalId: goal.id,
      changes: computed.draft.changes,
      impactText: computed.draft.impactText,
      preview: summarizeDraft(computed.draft),
      addedPhaseTitles: computed.draft.addedPhaseTitles,
      removedPhaseTitles: computed.draft.removedPhaseTitles,
      removedCompletedDays: computed.draft.removedCompletedDays,
      /* R4/EX-15：批准时冻结基线签名，执行时比对——期间被并发修改则拒绝 */
      baseSignature: computed.draft.baseSignature,
    });
  }

  /* ---- 第二批 C（AG-05 R03）：修改阅读目标（预览旧→新，批准后写入） ---- */
  if (name === "edit_book_goal") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const GOAL_TYPES = ["understand", "think", "apply", "retain"];
    const primary = str(args.primary);
    if (primary && !GOAL_TYPES.includes(primary))
      return { result: { ok: false, content: `primary 只支持 ${GOAL_TYPES.join("/")}`, summary: "参数不合法" } };
    const secondary = Array.isArray(args.secondary)
      ? (args.secondary as unknown[]).map((t) => str(t)).filter((t) => GOAL_TYPES.includes(t))
      : [];
    if (Array.isArray(args.secondary) && (args.secondary as unknown[]).length !== secondary.length)
      return { result: { ok: false, content: `secondary 里的值必须是 ${GOAL_TYPES.join("/")}`, summary: "参数不合法" } };
    const intent = str(args.intent);
    const background = str(args.background);
    if (!primary && secondary.length === 0 && !intent && !background)
      return { result: { ok: false, content: "至少要改一项：primary/secondary/intent/background", summary: "无修改内容" } };
    const cur = book.goal;
    /* 预览旧 → 新（AG-02：方案先展示再应用） */
    const previewLines: string[] = [`《${book.title}》阅读目标修改：`];
    if (primary && (!cur || cur.primary !== primary))
      previewLines.push(`  主目标：${cur?.primary ?? "（未设定）"} → ${primary}`);
    if (Array.isArray(args.secondary))
      previewLines.push(`  次目标：${cur?.secondary?.join("/") || "（无）"} → ${secondary.join("/") || "（无）"}`);
    if (intent) previewLines.push(`  为什么读：${cur?.intent ? `${cur.intent} → ` : ""}${intent}`);
    if (background) previewLines.push(`  当前基础：${cur?.background ? `${cur.background} → ` : ""}${background}`);
    if (primary && cur && cur.primary !== primary && book.chapters.length > 0)
      previewLines.push("  ⚠ 主目标变化会影响路线侧重——应用后可在阅读页按新目标重排路线（已完成的验收与沉淀会保留）。");
    return draftAction("edit_book_goal", "改阅读目标", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      primary: primary || undefined,
      secondary: Array.isArray(args.secondary) ? secondary : undefined,
      intent: intent || undefined,
      background: background || undefined,
      preview: previewLines.join("\n"),
      prevPrimary: cur?.primary,
    });
  }

  /* ---- 第二批 C（AG-05 R05）：设置阅读进度（章节状态 / 全书状态） ---- */
  if (name === "set_reading_progress") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const CHAPTER_STATUSES = ["reading", "done", "skipped", "todo"];
    const READ_STATUSES = ["reading", "finished", "assessing", "unread"];
    const chapterStatus = str(args.chapterStatus);
    const readStatus = str(args.readStatus);
    if (!chapterStatus && !readStatus)
      return { result: { ok: false, content: "chapterStatus 与 readStatus 至少提供一个", summary: "参数缺失" } };
    if (chapterStatus && !CHAPTER_STATUSES.includes(chapterStatus))
      return { result: { ok: false, content: `chapterStatus 只支持 ${CHAPTER_STATUSES.join("/")}`, summary: "参数不合法" } };
    if (readStatus && !READ_STATUSES.includes(readStatus))
      return { result: { ok: false, content: `readStatus 只支持 ${READ_STATUSES.join("/")}`, summary: "参数不合法" } };
    let chapter = null;
    if (chapterStatus) {
      const chapterKey = str(args.chapterTitle);
      if (!chapterKey) return { result: { ok: false, content: "改章节状态需要 chapterTitle（章节名或序号）", summary: "参数缺失" } };
      const byIdx = /^\d+$/.test(chapterKey) ? book.chapters[Number(chapterKey) - 1] : null;
      chapter =
        byIdx ??
        book.chapters.find((c) => c.title === chapterKey) ??
        book.chapters.find((c) => c.title.includes(chapterKey)) ??
        null;
      if (!chapter) return { result: { ok: false, content: `没有找到章节「${chapterKey}」。`, summary: "章节未找到" } };
      if (chapter.status === chapterStatus)
        return { result: { ok: true, content: `《${book.title}》的「${chapter.title}」已经是 ${chapterStatus}，无需修改。`, summary: "无变化" } };
    }
    const previewLines: string[] = [`《${book.title}》阅读进度：`];
    if (chapter) previewLines.push(`  章节「${chapter.title}」：${chapter.status} → ${chapterStatus}`);
    if (readStatus) previewLines.push(`  全书状态：${book.readStatus ?? book.status} → ${readStatus}`);
    if (chapterStatus === "done")
      previewLines.push("  （手动标记已读完，不等于验收掌握——验收通过才会记 masteredAt）");
    return draftAction("set_reading_progress", "更新阅读进度", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      chapterId: chapter?.id,
      chapterTitle: chapter?.title,
      chapterStatus: chapterStatus || undefined,
      readStatus: readStatus || undefined,
      preview: previewLines.join("\n"),
    });
  }

  /* ---- 第二批 C（AG-05 R04）：调整阅读路线节点顺序 ---- */
  if (name === "move_chapter") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const chapterKey = str(args.chapterTitle);
    if (!chapterKey) return { result: { ok: false, content: "需要 chapterTitle", summary: "参数缺失" } };
    const dir = Number(args.dir);
    if (dir !== -1 && dir !== 1)
      return { result: { ok: false, content: "dir 只能是 -1（上移）或 1（下移）", summary: "参数不合法" } };
    const byIdx = /^\d+$/.test(chapterKey) ? book.chapters[Number(chapterKey) - 1] : null;
    const chapter =
      byIdx ?? book.chapters.find((c) => c.title === chapterKey) ?? book.chapters.find((c) => c.title.includes(chapterKey)) ?? null;
    if (!chapter) return { result: { ok: false, content: `没有找到章节「${chapterKey}」。`, summary: "章节未找到" } };
    const idx = book.chapters.findIndex((c) => c.id === chapter.id);
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= book.chapters.length)
      return { result: { ok: true, content: `「${chapter.title}」已经是${dir === -1 ? "第一个" : "最后一个"}节点，无需移动。`, summary: "无变化" } };
    const neighbor = book.chapters[targetIdx];
    return draftAction("move_chapter", "调整节点顺序", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      dir,
      preview: `《${book.title}》路线顺序：「${chapter.title}」${dir === -1 ? "上移" : "下移"}一位（与「${neighbor.title}」交换）。内容与状态不变。`,
    });
  }

  /* ---- 第二批 C（AG-05 R07）：保存阅读沉淀（带章节来源） ---- */
  if (name === "save_reading_deposit") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const DEPOSIT_TYPES = ["explanation", "point", "question", "view", "practice", "unresolved", "aiFeedback"];
    const type = str(args.type) || "explanation";
    if (!DEPOSIT_TYPES.includes(type))
      return { result: { ok: false, content: `type 只支持 ${DEPOSIT_TYPES.join("/")}`, summary: "参数不合法" } };
    const text = str(args.text);
    if (!text) return { result: { ok: false, content: "需要 text（沉淀内容，尽量保留用户原话）", summary: "参数缺失" } };
    const chapterKey = str(args.chapterTitle);
    let chapter = null;
    if (chapterKey) {
      const byIdx = /^\d+$/.test(chapterKey) ? book.chapters[Number(chapterKey) - 1] : null;
      chapter = byIdx ?? book.chapters.find((c) => c.title.includes(chapterKey)) ?? null;
      if (!chapter) return { result: { ok: false, content: `没有找到章节「${chapterKey}」。`, summary: "章节未找到" } };
    }
    const typeLabel = DEPOSIT_TYPE_LABELS[type as keyof typeof DEPOSIT_TYPE_LABELS] ?? type;
    return draftAction("save_reading_deposit", "存阅读沉淀", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      chapterId: chapter?.id,
      chapterTitle: chapter?.title,
      type,
      text,
      preview: `《${book.title}》${chapter ? `章节「${chapter.title}」` : "整本书"} 新增沉淀（${typeLabel}）：\n${cut(text, 200)}`,
    });
  }

  /* ---- 第二批 C（AG-05 R06）：记录节点验收结果（检验理解） ---- */
  if (name === "record_book_assessment") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const KINDS = ["explain", "connect", "apply"];
    const LEVELS = ["mastered", "partial", "not", "ungradable"];
    const kind = str(args.kind);
    if (!KINDS.includes(kind))
      return { result: { ok: false, content: `kind 只支持 ${KINDS.join("/")}`, summary: "参数不合法" } };
    const level = str(args.level);
    if (!LEVELS.includes(level))
      return { result: { ok: false, content: `level 只支持 ${LEVELS.join("/")}`, summary: "参数不合法" } };
    const question = str(args.question);
    const answer = str(args.answer);
    const evidence = str(args.evidence);
    const feedback = str(args.feedback);
    if (!question || !answer || !evidence || !feedback)
      return {
        result: {
          ok: false,
          content: "question/answer/evidence/feedback 都必填——answer 用用户原话，evidence 写判分依据（引用原话或指出具体缺什么）。判而不解释=无效判。",
          summary: "参数缺失",
        },
      };
    const chapterKey = str(args.chapterTitle);
    if (!chapterKey) return { result: { ok: false, content: "需要 chapterTitle", summary: "参数缺失" } };
    const byIdx = /^\d+$/.test(chapterKey) ? book.chapters[Number(chapterKey) - 1] : null;
    const chapter = byIdx ?? book.chapters.find((c) => c.title === chapterKey) ?? book.chapters.find((c) => c.title.includes(chapterKey)) ?? null;
    if (!chapter) return { result: { ok: false, content: `没有找到章节「${chapterKey}」。`, summary: "章节未找到" } };
    const levelLabel = { mastered: "掌握", partial: "部分掌握", not: "未通过", ungradable: "无法判定" }[level];
    return draftAction("record_book_assessment", "记验收结果", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      kind,
      question,
      answer,
      level,
      evidence,
      feedback,
      preview:
        `《${book.title}》章节「${chapter.title}」${kind === "explain" ? "理解" : kind === "connect" ? "结构" : "迁移"}验收：${levelLabel}\n` +
        `题目：${cut(question, 120)}\n` +
        `用户回答：${cut(answer, 160)}\n` +
        `判分依据：${cut(evidence, 160)}` +
        (level === "mastered" ? "\n（通过 → 本章节将标记为已验收掌握）" : ""),
    });
  }

  /* ---- 第二批 C（AG-05 R02）：修改书目信息（字段差异预览） ---- */
  if (name === "update_book") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const newTitle = str(args.newTitle);
    const author = str(args.author);
    if (!newTitle && !author)
      return { result: { ok: false, content: "newTitle 与 author 至少提供一个", summary: "无修改内容" } };
    if (newTitle && newTitle !== book.title && store.books.some((b) => b.title === newTitle))
      return { result: { ok: false, content: `书架里已经有《${newTitle}》，不能重名。`, summary: "重名" } };
    const previewLines = [`《${book.title}》书目信息修改：`];
    if (newTitle && newTitle !== book.title) previewLines.push(`  书名：《${book.title}》 → 《${newTitle}》`);
    if (author && author !== (book.author ?? "")) previewLines.push(`  作者：${book.author ?? "（未填）"} → ${author}`);
    previewLines.push("  （章节、进度、验收、沉淀、对话全部保留不变。）");
    return draftAction("update_book", "修改书目", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      newTitle: newTitle || undefined,
      author: author || undefined,
      preview: previewLines.join("\n"),
    });
  }

  /* ---- 第二批 C（AG-05 R02）：删除书籍（影响范围先展示） ---- */
  if (name === "remove_book") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const doneCh = book.chapters.filter((c) => c.status === "done").length;
    const masteredCh = book.chapters.filter((c) => c.masteredAt).length;
    const impact =
      `将删除《${book.title}》：\n` +
      `  章节进度：${book.chapters.length} 章（其中已完成 ${doneCh}、验收掌握 ${masteredCh}）\n` +
      `  阅读对话：${book.chat.length} 条\n` +
      `  沉淀：${(book.deposits ?? []).length} 条\n` +
      `  验收档案：${(book.assessments ?? []).length} 条\n` +
      `  迁移记录：${(book.transfers ?? []).length} 条\n` +
      `  洞见：${book.insights.length} 条\n` +
      `（第二大脑里的笔记不会删除；删除后随云同步，双端不可恢复——请谨慎确认。）`;
    return draftAction("remove_book", "删除书籍", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      impactText: impact,
      preview: impact,
    });
  }

  /* ---- 第二批 C（AG-05 R04）：恢复阅读路线历史版本 ---- */
  if (name === "restore_book_route") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveBook(store.books, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `书架上没有找到《${title}》。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateBookText(res.candidates), summary: "需消歧" } };
    const book = store.books.find((b) => b.id === res.bookId)!;
    const hist = book.routeHistory ?? [];
    if (hist.length === 0)
      return { result: { ok: false, content: `《${book.title}》还没有路线历史——重排过路线后才有可恢复的版本。`, summary: "无历史" } };
    const version = Number(args.version);
    const entry = Number.isFinite(version) && version >= 1 ? hist[version - 1] : hist[hist.length - 1];
    if (!entry) return { result: { ok: false, content: `版本 ${version} 不存在（历史共 ${hist.length} 条，1=最早）。`, summary: "版本无效" } };
    const routeLabel = entry.routeType === "core" ? "核心" : entry.routeType === "goal" ? "目标导向" : "完整";
    const curList = book.chapters.map((c, i) => `${i + 1}. ${c.title}`);
    const oldList = entry.chapters.map((c, i) => `${i + 1}. ${c.title}`);
    return draftAction("restore_book_route", "恢复阅读路线", cut(book.title, 30), {
      bookId: book.id,
      bookTitle: book.title,
      historyId: entry.id,
      version: Number.isFinite(version) && version >= 1 ? version : hist.length,
      preview:
        `《${book.title}》路线恢复到 ${entry.at.slice(0, 16).replace("T", " ")}（${entry.reason}，${routeLabel}路线 ${entry.chapters.length} 节）：\n` +
        `现：\n  ${curList.slice(0, 8).join("\n  ")}${curList.length > 8 ? `\n  …共 ${curList.length} 节` : ""}\n` +
        `恢复为：\n  ${oldList.slice(0, 8).join("\n  ")}${oldList.length > 8 ? `\n  …共 ${oldList.length} 节` : ""}\n` +
        `（对话/沉淀/洞见/学习状态/验收档案全部保留；恢复前先快照当前版，可再回退。）`,
    });
  }

  /* ---- 第二批 C（AG-05 N04）：笔记双链关联 ---- */
  if (name === "link_notes") {
    const fromKey = str(args.from);
    const toKey = str(args.to);
    if (!fromKey || !toKey) return { result: { ok: false, content: "需要 from 和 to（笔记标题或 id）", summary: "参数缺失" } };
    /* 两侧都走 AG-01 定位：任一歧义就整体拒绝并列出候选，不能贪心取第一篇去关联 */
    const rf = resolveNote(fromKey, fromKey);
    const rt = resolveNote(toKey, toKey);
    if (rf.kind === "ambiguous" || rt.kind === "ambiguous") {
      const parts: string[] = [];
      if (rf.kind === "ambiguous") parts.push(`「${fromKey}」${disambiguateNoteText(rf.candidates)}`);
      if (rt.kind === "ambiguous") parts.push(`「${toKey}」${disambiguateNoteText(rt.candidates)}`);
      return { result: { ok: false, content: parts.join("\n\n"), summary: "需消歧" } };
    }
    const from = rf.kind === "exact" ? rf.note : null;
    const to = rt.kind === "exact" ? rt.note : null;
    if (!from || !to) return { result: { ok: false, content: `没有找到笔记：${!from ? `「${fromKey}」` : ""}${!from && !to ? "、" : ""}${!to ? `「${toKey}」` : ""}。`, summary: "未找到" } };
    if (from.id === to.id) return { result: { ok: true, content: "两条笔记是同一篇，无需关联。", summary: "无变化" } };
    if (from.links.includes(to.id)) return { result: { ok: true, content: `《${from.title}》已经关联到《${to.title}》，无需重复。`, summary: "已存在" } };
    return draftAction("link_notes", "关联笔记", `${cut(from.title, 20)} ↔ ${cut(to.title, 20)}`, {
      fromId: from.id,
      fromTitle: from.title,
      toId: to.id,
      toTitle: to.title,
      preview: `建立双向关联：《${from.title}》 ↔ 《${to.title}》。不修改两边正文。`,
    });
  }

  if (name === "create_goal") {
    const topic = str(args.topic);
    if (!topic) return { result: { ok: false, content: "缺少 topic", summary: "参数缺失" } };
    if (store.goals.some((g) => g.topic === topic && g.status === "active"))
      return { result: { ok: false, content: `已有进行中的目标「${topic}」。`, summary: "已存在" } };
    const criteria = Array.isArray(args.successCriteria)
      ? args.successCriteria.map((c) => str(c)).filter(Boolean).slice(0, 5)
      : [];
    return draftAction("create_goal", "新建学习目标", cut(topic, 30), {
      topic,
      direction: str(args.direction),
      motivation: str(args.motivation),
      background: str(args.background),
      successCriteria: criteria,
    });
  }

  if (name === "add_book") {
    const title = str(args.title);
    if (!title) return { result: { ok: false, content: "缺少 title", summary: "参数缺失" } };
    if (store.books.some((b) => b.title === title))
      return { result: { ok: false, content: `书架里已经有《${title}》。`, summary: "已在书架" } };
    return draftAction("add_book", "加书上架", cut(title, 30), {
      title,
      author: str(args.author),
      brief: str(args.brief),
      material: str(args.material),
    });
  }

  if (name === "create_session") {
    const title = str(args.title);
    if (!title) return { result: { ok: false, content: "缺少 title", summary: "参数缺失" } };
    const participants = Array.isArray(args.participants)
      ? (args.participants as unknown[]).map((p) => str(p)).filter(Boolean).slice(0, 6)
      : undefined;
    const opening = str(args.opening);
    const preview = opening
      ? `新建会话「${title}」，并把议题作为第一条消息带入：\n${cut(opening, 160)}`
      : `新建会话「${title}」（空会话，打开后开始对话）。`;
    return draftAction("create_session", "新建会话", cut(title, 30), {
      title,
      personaId: str(args.personaId) || "roundtable",
      participants: participants?.length ? participants : undefined,
      opening: opening || undefined,
      preview,
    });
  }

  /* ---- 批次 D（AG-06 C06）：重命名 / 删除会话 ---- */
  if (name === "manage_session") {
    const action = str(args.action);
    if (action !== "rename" && action !== "delete")
      return { result: { ok: false, content: 'action 只支持 "rename"|"delete"', summary: "参数不合法" } };
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveSession(store.sessions, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `没有找到会话「${title}」。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateSessionText(res.candidates), summary: "需消歧" } };
    const sess = store.sessions.find((s) => s.id === res.sessionId)!;
    if (action === "rename") {
      const newTitle = str(args.newTitle);
      if (!newTitle) return { result: { ok: false, content: "rename 需要 newTitle", summary: "参数缺失" } };
      if (newTitle === sess.title) return { result: { ok: true, content: "会话名没变，无需修改。", summary: "无变化" } };
      return draftAction("manage_session", "重命名会话", cut(sess.title, 30), {
        action: "rename",
        sessionId: sess.id,
        sessionTitle: sess.title,
        newTitle,
        preview: `会话「${sess.title}」重命名为「${newTitle}」。消息与人物不变。`,
      });
    }
    /* delete：影响先展示（C06 纪律） */
    return draftAction("manage_session", "删除会话", cut(sess.title, 30), {
      action: "delete",
      sessionId: sess.id,
      sessionTitle: sess.title,
      preview:
        `将删除会话「${sess.title}」（${sess.messages.length} 条消息）。删除后不可恢复。\n` +
        `（如果只是想整理列表，用 rename 重命名即可。）`,
    });
  }

  /* ---- 批次 D（AG-06 C03）：发起/继续讨论（真实执行，写回原会话） ---- */
  if (name === "run_discussion") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveSession(store.sessions, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `没有找到会话「${title}」。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateSessionText(res.candidates), summary: "需消歧" } };
    const sess = store.sessions.find((s) => s.id === res.sessionId)!;
    if (isSessionBusy(sess.id))
      return { result: { ok: false, content: `「${sess.title}」正在执行一轮讨论，等它结束再发起。`, summary: "执行中" } };
    const retry = args.retry === true;
    const focus = str(args.focus);
    if (!retry && !focus)
      return { result: { ok: false, content: "需要 focus（本轮想重点讨论/追问什么）；或 retry=true 重试挂起的失败席位与纪要。", summary: "参数缺失" } };
    if (retry && !sess.pendingRetry)
      return { result: { ok: false, content: "该会话没有挂起的重试（全部席位与纪要都已完成，或没有失败记录）。", summary: "无可重试" } };
    const isRt = sess.personaId === "roundtable";
    const mode: "single" | "roundtable" = isRt ? "roundtable" : "single";
    const baseLineup = isRt ? sess.participants ?? [] : [sess.personaId];
    const { list: lineup, missing } = resolveSeatPersonas(baseLineup);
    const names = lineup.map((x) => x.name).join("、");
    const previewLines = [
      `会话「${sess.title}」（${mode === "roundtable" ? `圆桌 · ${lineup.length} 席` : "单人对话"}）`,
      `议题：${cut(sess.messages.find((m) => m.role === "user")?.content ?? "（空）", 100)}`,
      retry ? `重试挂起项：${sess.pendingRetry?.hostFailed ? "主持人纪要（复用已完成发言，不重跑席位）" : `${sess.pendingRetry?.failedSeatIds.length ?? 0} 个失败席位（已完成发言保留）`}` : `本轮阵容：${names}${missing.length ? `（⚠ 无法解析的席位：${missing.join("、")}——将被跳过）` : ""}`,
      focus ? `新增约束：${focus}` : "",
      "真实执行并写回本会话；需要真实生成，耗时较长。",
    ].filter(Boolean).join("\n");
    return draftAction("run_discussion", "发起讨论", cut(sess.title, 30), {
      sessionId: sess.id,
      sessionTitle: sess.title,
      mode,
      lineup,
      retry,
      focus,
      question: retry ? sess.pendingRetry!.question : focus,
      userMessage: retry ? "" : focus,
      seatQuestion: retry ? sess.pendingRetry?.seatQuestion : composeSeatQuestion(sess, focus),
      history: mode === "single" ? sess.messages.slice(-8).map((m) => ({ role: m.role as "user" | "assistant", content: cut(m.content, 400) })) : undefined,
      baseLineup,
      preview: previewLines,
    });
  }

  /* ---- 批次 D（AG-06 C04）：调整圆桌阵容（下一轮生效） ---- */
  if (name === "set_participants") {
    const title = str(args.title);
    const id = str(args.id);
    if (!title && !id) return { result: { ok: false, content: "需要 title 或 id", summary: "参数缺失" } };
    const res = resolveSession(store.sessions, title, id);
    if (res.kind === "none") return { result: { ok: false, content: `没有找到会话「${title}」。`, summary: "未找到" } };
    if (res.kind === "ambiguous") return { result: { ok: false, content: disambiguateSessionText(res.candidates), summary: "需消歧" } };
    const sess = store.sessions.find((s) => s.id === res.sessionId)!;
    if (sess.personaId !== "roundtable")
      return { result: { ok: false, content: "只有圆桌会话可以调整阵容；单人会话的人物在创建时已定。", summary: "非圆桌" } };
    if (isSessionBusy(sess.id))
      return { result: { ok: false, content: `「${sess.title}」正在执行一轮讨论——不能中途换人，等它结束后再调整。`, summary: "执行中" } };
    const rawList = Array.isArray(args.participants) ? (args.participants as unknown[]).map((x) => str(x)).filter(Boolean) : [];
    const { list, missing } = resolveSeatPersonas(rawList);
    if (missing.length)
      return { result: { ok: false, content: `这些人物不存在（内置席位或自建人物）：${missing.join("、")}。可用 forge_persona 先塑造。`, summary: "人物不存在" } };
    if (list.length < 2)
      return { result: { ok: false, content: `圆桌至少 2 位与会者（当前解析到 ${list.length} 位）。`, summary: "人数不足" } };
    /* 与 create_session 同口径（那里 slice(0,6)）：每席 = 一次真实模型调用，
     * 模型驱动路径不得无上限扩容——否则一次批准就能触发 19+ 并发请求。 */
    if (list.length > MAX_ROUNDTABLE_SEATS)
      return {
        result: {
          ok: false,
          content: `圆桌最多 ${MAX_ROUNDTABLE_SEATS} 位与会者（当前解析到 ${list.length} 位）——每席一次真实模型调用，席位越多越慢、消耗越大。请先精简名单。`,
          summary: "人数超限",
        },
      };
    const newIds = list.map((x) => x.id);
    const oldIds = sess.participants ?? [];
    const oldNames = oldIds.map((x) => seatNameOf(x) ?? x);
    const added = newIds.filter((x) => !oldIds.includes(x)).map((x) => seatNameOf(x) ?? x);
    const removed = oldIds.filter((x) => !newIds.includes(x)).map((x) => seatNameOf(x) ?? x);
    const preview =
      `会话「${sess.title}」阵容调整：
` +
      `原（${oldNames.length}）：${oldNames.join("、") || "（未设）"}
` +
      `新（${list.length}）：${list.map((x) => x.name).join("、")}
` +
      `${added.length ? `新增：${added.join("、")}
` : ""}${removed.length ? `移出：${removed.join("、")}
` : ""}` +
      `（自下一轮讨论生效；历史发言全部保留。）`;
    return draftAction("set_participants", "调整阵容", cut(sess.title, 30), {
      sessionId: sess.id,
      sessionTitle: sess.title,
      participants: newIds,
      added,
      removed,
      preview,
    });
  }

  /* 注：update_settings / get_settings_public 的完整实现块已删除。
   * executeTool 在分发前就把这两个工具整体拦下（设置只能由用户本人在设置页改），
   * 此处的分支永远不可达；保留它会让读者误以为 provider 白名单等校验在某处生效。
   * protocol.TOOLS 仍保留两个条目（agent-tools.ts 另做过滤），这是唯一的注册事实来源。 */

  return { result: { ok: false, content: "未知写入工具", summary: "未知工具" } };
}

/** 工具入口：读 → 直接执行；写 → 校验并返回待确认 action
 *  （单一事实来源：写工具名单直接从 TOOLS[name].risk 派生，避免手抄两份表漂移——
 *  此前 spec 表漏掉 regenerate_phase 导致该工具被当只读分发、永远返回「未知只读工具」。） */
export async function executeTool(
  name: ToolName,
  args: Record<string, unknown>,
  opts: ToolExecOpts = {}
): Promise<ToolOutcome> {
  /* 五段埋点·意图段：每次工具调用即一次"Agent 判断需要动手"的记录。
   * 必须放在**所有** early-return 之前：此前 manage_workspace/manage_goal 在 track 之前就返回，
   * 这两个高频复合工具（workspace 带 writeActions create/update/delete）从不产生
   * agent_tool_intent 事件，依赖该漏斗的转化分析会系统性漏掉它们。 */
  const writeAction = typeof args.action === "string" ? str(args.action) : "";
  const trackedWrite =
    TOOLS[name]?.risk === "write" || Boolean(writeAction && TOOLS[name]?.writeActions?.includes(writeAction));
  track("agent_tool_intent", { tool: name, write: trackedWrite ? 1 : 0 });
  if(name==="update_settings"||name==="get_settings_public")return {result:{ok:false,summary:"设置不可由智能体操作",content:"设置由用户本人在设置页管理，智能体不会读取或修改设置。"}};
  if(name==="manage_workspace")return workspaceTool(args);
  if(name==="manage_goal")return goalActionTool(args);
  /* R04 重排路线 / C05 塑造人物：校验阶段就要真实生成供预览（异步校验器，带预算记账 + signal） */
  if (name === "rebuild_reading_route") return validateRebuildRoute(args, opts.signal);
  if (name === "forge_persona") return validateForgePersona(args, opts.signal);
  /* 分发判据仍只认 TOOLS[name].risk——混合工具（review_queue/memory/reminders 的写动作）
   * 必须走 runReadTool 才能进各自的 action 分支，不能因为埋点口径被改到写路径。 */
  return TOOLS[name]?.risk === "write" ? validateWriteTool(name, args) : runReadTool(name, args, opts);
}

/* ========= 批准后的真正执行 ========= */

/** 重复批准防护（批次 D 补充）：同一审批动作只允许执行一次。
 *  执行中重复提交与执行完成后重复提交都返回「已执行过」——不重复调用模型、
 *  不重复追加问题、不重复保存纪要。重试失败部分是**新的审批动作**（新 id），不受影响。
 *  内存 Map 即可：审批卡生命周期短于页面会话；容量封顶防泄漏。 */
const executedActions = new Set<string>();
const EXECUTED_ACTIONS_MAX = 200;

export async function executeAction(action: PendingAction, signal?: AbortSignal): Promise<ToolResult> {
  if(action.kind==="update_settings"||action.kind==="get_settings_public")return {ok:false,summary:"设置不可由智能体操作",content:"此设置操作已禁用，没有修改设置。"};
  if (executedActions.has(action.id)) {
    return {
      ok: false,
      content: "该动作已执行过，本次提交被忽略——不会重复调用模型、追加问题或保存纪要。（重试失败部分请发起新的请求或使用 retry。）",
      summary: "已执行过",
    };
  }
  /* 先登记再执行：执行中的重复提交同样被挡住 */
  executedActions.add(action.id);
  if (executedActions.size > EXECUTED_ACTIONS_MAX) {
    const first = executedActions.values().next().value;
    if (first) executedActions.delete(first);
  }
  const store = useAppStore.getState();
  const p = action.payload;

  switch (action.kind) {
    case "manage_workspace": return commitWorkspaceAction(action);
    case "manage_goal": return commitGoalAction(action);
    case "save_note": {
      const title = str(p.title);
      const body = str(p.body);
      const domain = str(p.domain) || "笔记";
      const added=store.addKnowledge([{ title, body, domain }], "manual", "智能体");
      if(!added)return {ok:false,content:`未新建笔记《${title}》：当前已有同名内容，请先读取，再决定更新或更换标题。`,summary:"未新建"};
      return { ok: true, content: `笔记《${title}》已存入第二大脑。`, summary: "已保存" };
    }
    case "update_note": {
      const id = str(p.id);
      /* 批准到执行之间笔记可能已被另一标签页/入口删除：store.updateKnowledge 对不存在的 id
       * 是静默 no-op，旧实现仍返回「笔记已更新」——等于向用户谎报成功。
       * 与 book/session 分支同口径：先查存在性再写。 */
      if (!store.knowledge.some((k) => k.id === id))
        return { ok: false, content: "要修改的笔记已不存在（可能已被删除），本次没有做任何修改。", summary: "未找到" };
      const patch: { title?: string; body?: string } = {};
      if (typeof p.newTitle === "string" && p.newTitle) patch.title = p.newTitle;
      if (typeof p.body === "string" && p.body) patch.body = p.body;
      /* 执行期再查一次重名（批准期间可能新增同名笔记）——同名会破坏按标题定位 */
      if (patch.title && store.knowledge.some((k) => k.id !== id && k.title.trim() === patch.title!.trim()))
        return { ok: false, content: `已有同名笔记《${patch.title}》，为避免出现两篇同名笔记，本次没有改名。`, summary: "同名已存在" };
      store.updateKnowledge(id, patch);
      return { ok: true, content: `笔记已更新（${Object.keys(patch).join("、")}）。`, summary: "已更新" };
    }
    case "delete_note": {
      const id = str(p.id);
      if (!store.knowledge.some((k) => k.id === id))
        return { ok: false, content: "要删除的笔记已不存在（可能已被删除），本次没有做任何操作。", summary: "未找到" };
      store.removeKnowledge(id);
      return { ok: true, content: `笔记《${str(p.title)}》已删除。`, summary: "已删除" };
    }
    case "create_goal": {
      const goalId = uid("goal");
      const topic = str(p.topic);
      const background = str(p.background);
      const direction = str(p.direction);
      const motivation = str(p.motivation);
      const criteria = Array.isArray(p.successCriteria)
        ? (p.successCriteria as unknown[]).map((c) => str(c)).filter(Boolean)
        : [];
      /* 交接的核心：把主对话里已掌握的背景种进引导 transcript——
       * /learn/new?goal= 会回放这段对话，教练只补必要的问题，用户不用重讲一遍。 */
      const knownBits = [direction, motivation, background].filter(Boolean).join("；");
      store.addGoal({
        id: goalId,
        topic,
        direction,
        domainKind: "other",
        motivation,
        background,
        weeklyHours: 8,
        successCriteria: criteria,
        status: "draft",
        createdAt: new Date().toISOString(),
        quizLog: [],
        intakeTranscript: [
          {
            role: "user",
            content: `我想学${topic}。${background ? `背景：${background}。` : ""}${motivation ? `动机：${motivation}。` : ""}`,
          },
          {
            role: "assistant",
            content: `（交接自主对话框）我已经了解：${knownBits || `你想学${topic}`}。${criteria.length ? `你定的验收标准：${criteria.join("；")}。` : ""}这些我记下了，不会重复问。接下来我只补真正影响计划的问题。`,
          },
        ],
      });
      track("workflow_handoff", { to: "learn", topic: cut(topic, 24) });
      return {
        ok: true,
        content: `学习目标「${topic}」已创建，对话里说过的背景都带过去了。接续入口：[继续引导对话](/learn/new?goal=${goalId})——引导只会补必要的问题，不会让你重讲一遍。`,
        summary: "已创建",
      };
    }
    case "add_book": {
      const title = str(p.title);
      const author = str(p.author);
      const brief = str(p.brief);
      const material = str(p.material);
      /* V26.2-H2（PRD §5.4）：正式生成前必须核查书籍真实性。
       * 用户随材料走的路径（material 非空）→ user_material，仍生成但如实标注；
       * 无材料且核查不过 → 拒绝生成，由模型向用户转述并索要作者/ISBN/原文材料。 */
      let verification: "verified" | "user_material" = "user_material";
      if (!material) {
        let v: Awaited<ReturnType<typeof verifyBook>> | null = null;
        try {
          v = await verifyBook(title, author);
        } catch {
          v = null; // 核查服务不可用（C7）——同样拒绝，话术区分
        }
        if (!v || v.status !== "verified") {
          return {
            ok: false,
            summary: "书籍未核实",
            content:
              !v || v.status === "unsearchable"
                ? `《${title}》暂时无法核实（核查服务不可用），所以这次没有生成书籍内容——不能为无法确认真实性的书编目录。请告诉用户稍后再试，或请 ta 补充作者/出版社/ISBN，或直接粘贴这本书的原文片段（有材料就能基于材料生成）。`
                : `没有找到《${title}》的可信图书来源（豆瓣/百科/出版社等）${author ? `，或来源与作者「${author}」不符` : ""}，所以这次没有生成书籍内容。请如实告诉用户，并请 ta 确认书名/作者是否准确（同名书请区分版本），或粘贴原文材料后再试——绝不要为无法确认的书编造目录或作者观点。`,
          };
        }
        verification = "verified";
      }
      const desc = `书名：《${title}》${author ? ` 作者：${author}` : ""}${brief ? `\n简介：${brief}` : ""}${
        material ? `\n用户提供的原文材料/目录（以此为准，不要编造未提供的内容）：\n${material.slice(0, 6000)}` : ""
      }`;
      const full = await streamChat({
        args: { desc, materialOnly: verification === "user_material" },
        messages: [{ role: "user", content: "生成阅读计划。" }],
        temperature: 0.5,
        task: "reading-plan",
        signal, // 用户点「停止」时中止在途的阅读计划生成（长任务，此前无法中断）
        onDelta: () => {},
      });
      const plan = readingPlanSchema.parse(extractJson(full));
      const bookId = uid("book");
      store.addBook({
        id: bookId,
        title,
        author: author || undefined,
        status: "reading",
        verification, // V26.2-H2：核查状态落库，详情页/书架如实展示
        pastedText: material || undefined,
        /* v25：新链路给 map（认知地图四区域）；旧输出没有 map 时从 bookProfile 转换，两代数据都接 */
        map: plan.map
          ? { ...plan.map, generatedAt: new Date().toISOString() }
          : plan.bookProfile
            ? {
                coreProblem: plan.bookProfile.positioning,
                authorStance: plan.bookProfile.author,
                lineage: plan.bookProfile.lineage,
                controversies: plan.bookProfile.controversies,
                generatedAt: new Date().toISOString(),
              }
            : undefined,
        profile: plan.bookProfile || undefined,
        planSummary: plan.planSummary,
        chapters: plan.chapters.map((c) => ({
          ...c,
          knowledgeType: c.knowledgeType || "concept",
          coreIdea: c.coreIdea || undefined,
          perspectives: c.perspectives || undefined,
          capture: c.capture || undefined,
          keyConcepts: c.keyConcepts || undefined,
          prerequisites: c.prerequisites || undefined,
          expectedOutcome: c.expectedOutcome || undefined,
          assessFocus: c.assessFocus || undefined,
          id: uid("ch"),
          status: "todo" as const,
        })),
        insights: [],
        chat: [],
        createdAt: new Date().toISOString(),
      });
      track("workflow_handoff", { to: "read", title: cut(title, 24) });
      return {
        ok: true,
        content: `《${title}》已上架，阅读计划拆了 ${plan.chapters.length} 章：${plan.chapters.map((c) => c.title).join("、")}。可以去「学习」页的「读书伙伴」开始读。`,
        summary: `${plan.chapters.length} 章`,
      };
    }
    case "create_session": {
      const sessionId = uid("sess");
      /* C02：participants 显式指定圆桌阵容；opening 议题作为第一条消息存入——已讨论的问题不丢 */
      const opening = str(p.opening);
      store.addSession({
        id: sessionId,
        personaId: str(p.personaId) || "roundtable",
        ...(Array.isArray(p.participants) && p.participants.length ? { participants: p.participants as string[] } : {}),
        title: str(p.title),
        messages: opening ? [{ id: uid("m"), role: "user" as const, content: opening, at: new Date().toISOString() }] : [],
        createdAt: new Date().toISOString(),
      });
      track("workflow_handoff", { to: "council" });
      return {
        ok: true,
        content:
          `会话「${str(p.title)}」已创建${Array.isArray(p.participants) && p.participants.length ? `（与会人物：${(p.participants as string[]).join("、")}）` : ""}。` +
          (opening ? "议题已作为第一条消息带入，打开后人物会先回应这个议题。" : "") +
          `接续入口：/council?session=${sessionId}（打开即自动选中）。`,
        summary: "已创建",
      };
    }
    /* ---- 批次 D（AG-06 C06）：重命名 / 删除会话 ---- */
    case "manage_session": {
      const sessionId = str(p.sessionId);
      const sess = store.sessions.find((s) => s.id === sessionId);
      if (!sess) return { ok: false, content: "会话已不存在。", summary: "未找到" };
      if (str(p.action) === "rename") {
        const newTitle = str(p.newTitle);
        if (!newTitle || newTitle === sess.title) return { ok: true, content: "会话名未变化。", summary: "无变化" };
        store.updateSession(sessionId, { title: newTitle });
        return { ok: true, content: `会话已重命名为「${newTitle}」。`, summary: "已重命名" };
      }
      store.removeSession(sessionId);
      return { ok: true, content: `会话「${str(p.sessionTitle)}」已删除。`, summary: "已删除" };
    }
    /* ---- 批次 D（AG-06 C03）：真实执行讨论并写回原会话 ---- */
    case "run_discussion": {
      const { runDiscussion } = await import("@/lib/agent/council-engine");
      const sessionId = str(p.sessionId);
      const sess = store.sessions.find((s) => s.id === sessionId);
      if (!sess) return { ok: false, content: "会话已不存在（可能已被删除）。", summary: "未找到" };
      if (isSessionBusy(sessionId))
        return { ok: false, content: "该会话正在执行一轮讨论（本动作未重复发起）。", summary: "执行中" };
      /* EX-15：批准后阵容被改 → 拒绝旧批准，让用户基于新阵容重新确认 */
      const curIds = sess.personaId === "roundtable" ? sess.participants ?? [] : [sess.personaId];
      const baseLineup = Array.isArray(p.baseLineup) ? (p.baseLineup as string[]) : curIds;
      if (JSON.stringify(curIds) !== JSON.stringify(baseLineup))
        return { ok: false, content: "检测到冲突：方案批准后，会话阵容已被修改。为避免按旧阵容执行，本次未发起——请重新确认阵容后再发起。", summary: "检测到冲突" };
      const { list: lineup, missing } = resolveSeatPersonas(curIds);
      if (lineup.length === 0)
        return { ok: false, content: "席位已全部失效（人物被删除），无法执行讨论。", summary: "无有效席位" };
      const mode = str(p.mode) === "single" ? "single" : "roundtable";
      const retry = p.retry === true;
      /* 重试路径：消费会话上挂起的重试态（失败席位/主持人），已完成发言不重复调用 */
      let retryOpts: Parameters<typeof runDiscussion>[0] | null = null;
      if (retry) {
        const pr = takePendingRetry(sessionId);
        if (!pr) return { ok: false, content: "没有挂起的重试（可能已被处理）。", summary: "无可重试" };
        retryOpts = {
          sessionId,
          question: pr.question,
          userMessage: "",
          seatQuestion: pr.seatQuestion,
          participants: lineup,
          mode: "roundtable",
          goodTakes: pr.goodTakes,
          onlySeats: pr.hostFailed ? undefined : pr.failedSeatIds,
          hostOnly: pr.hostFailed,
          signal: signal ?? new AbortController().signal,
        };
      }
      const result = await runDiscussion(
        retry
          ? retryOpts!
          : {
              sessionId,
              question: str(p.question) || str(p.focus),
              userMessage: str(p.userMessage),
              seatQuestion: str(p.seatQuestion) || undefined,
              participants: mode === "roundtable" ? lineup : [lineup[0]],
              mode: mode as "single" | "roundtable",
              history: Array.isArray(p.history) ? (p.history as { role: "user" | "assistant"; content: string }[]) : undefined,
              signal: signal ?? new AbortController().signal,
            },
        (id) => store.customPersonas.find((c) => c.id === id)
      );
      if (missing.length)
        return {
          ok: result.status === "done" || result.status === "partial",
          content: `讨论已执行（有无法解析的席位被跳过：${missing.join("、")}）。`,
          summary: "已执行（席位缺失）",
        };
      const entry = `入口：/council?session=${sessionId}（打开即自动选中本次讨论的会话）`;
      switch (result.status) {
        case "done":
          return { ok: true, content: `讨论完成：${result.savedMessages} 条消息已写回「${str(p.sessionTitle)}」（含主持人纪要）。${entry}`, summary: "讨论完成" };
        case "partial":
          return { ok: true, content: `讨论部分完成：纪要已按 ${Object.keys(result.goodTakes).length} 席生成并写回；${result.failedSeatIds.length} 席发言失败（失败发言未进纪要）。可用 run_discussion retry=true 补齐失败席位后重出纪要。${entry}`, summary: "部分完成" };
        case "insufficient":
          return { ok: true, content: `本轮有效发言不足 2 席（${Object.keys(result.goodTakes).length}/${lineup.length}），未生成纪要——失败残片未进纪要。${result.failedSeatIds.length ? "可用 run_discussion retry=true 重试失败席位。" : "与会席位已失效，请重建圆桌。"}${entry}`, summary: "不足两席" };
        case "failed":
          return {
            ok: false,
            content: result.hostFailed
              ? "主持人纪要生成失败：各席发言已完整保留并写回会话，可用 run_discussion retry=true 单独重试纪要。"
              /* 文案必须与事实一致：用户消息（以及可能的失败备注）确实已写入会话。
               * 附上引擎带回的真实原因，模型才能如实转述（配额/Key/断网）。 */
              : `讨论执行失败：${result.error ? `原因：${result.error.slice(0, 160)}。` : ""}会话里已留下失败记录（${result.savedMessages} 条），可以重发一次继续。`,
            summary: "执行失败",
          };
        case "cancelled":
          return { ok: true, content: `讨论已停止：已完成发言保留（${result.savedMessages} 条已写回），未再启动后续请求。${entry}`, summary: "已停止" };
      }
      return { ok: false, content: "未知结果状态。", summary: "未知" };
    }
    /* ---- 批次 D（AG-06 C04）：阵容变更落库（下一轮生效） ---- */
    case "set_participants": {
      const sessionId = str(p.sessionId);
      const sess = store.sessions.find((s) => s.id === sessionId);
      if (!sess) return { ok: false, content: "会话已不存在。", summary: "未找到" };
      if (isSessionBusy(sessionId))
        return { ok: false, content: "该会话正在执行讨论——本轮不受影响，阵容变更未生效。请等结束后重试。", summary: "执行中" };
      const ids = Array.isArray(p.participants) ? (p.participants as string[]) : [];
      if (ids.length < 2) return { ok: false, content: "圆桌至少 2 位与会者。", summary: "人数不足" };
      store.updateSession(sessionId, { participants: ids });
      track("council_participants", { via: "agent", session: cut(str(p.sessionTitle), 24), count: ids.length });
      const names = ids.map((x) => seatNameOf(x) ?? x).join("、");
      return {
        ok: true,
        content: `「${str(p.sessionTitle)}」下一轮阵容已更新（${ids.length} 人：${names}）。历史发言全部保留；正在进行的轮次不受影响。`,
        summary: "阵容已更新",
      };
    }

    /* ---- 批次 D（AG-06 C05）：自定义人物入库（蒸馏已在审批卡核对） ---- */
    case "forge_persona": {
      /* 重名拦截（与 council 页 saveForged 同一规则）：圆桌历史按 **【显示名】** 前缀
       * 归属各席发言（引擎落库与 rebuildRtRetry 反推都只用名字），同名两个人物进同一张
       * 桌会把同一段历史错配给两席。内置席位名同样占用。 */
      const wantedName = str(p.name).trim();
      if (
        ALL_SEAT_METAS.some((m) => m.name === wantedName) ||
        (store.customPersonas ?? []).some((c) => c.name === wantedName)
      ) {
        return {
          ok: false,
          content: `已有同名人物「${wantedName}」，未重复入库——圆桌按显示名归属发言，同名会错配席位。请用户换个名字或直接使用已有的人物。`,
          summary: "重名未入库",
        };
      }
      const persona = {
        id: `custom:${uid("p")}`,
        name: str(p.name),
        tag: str(p.tag),
        bio: str(p.bio),
        color: normalizeSeatColor(p.color),
        identityNote: str(p.identityNote),
        system: str(p.system),
        createdAt: new Date().toISOString(),
      };
      store.addCustomPersona(persona);
      track("persona_forge", { via: "agent", name: cut(persona.name, 24) });
      return {
        ok: true,
        content: `人物「${persona.name}」（${persona.tag}）已加入你的圆桌。身份核对说明已存档；发起新会话时选择这个人物即可对话。`,
        summary: "已入库",
      };
    }
    /* ---- V26.1 P0-B7/B11：阶段重排（结构性修改，完成日>0 时审批卡带警告） ---- */
    case "regenerate_phase": {
      const { regeneratePhase } = await import("@/lib/agent/phase-regen");
      const r = await regeneratePhase(str(p.goalId), str(p.phaseId), str(p.userNote), true, signal);
      return { ok: r.ok, content: r.content, summary: r.summary };
    }
    /* ---- 第一批 P0：讨论后精确修改学习计划（方案已在审批卡预览，此处落地） ---- */
    case "edit_phase": {
      const { applyPhaseEdit } = await import("@/lib/agent/phase-edit");
      const goal = store.goals.find((g) => g.id === str(p.goalId));
      if (!goal?.plan) return { ok: false, content: "目标或计划已不存在，未做修改。", summary: "未找到" };
      const changes = (p.changes ?? {}) as PhaseEditChanges;
      /* R4/EX-15：用批准时保存的基线签名重建草稿——不重算。
       * 重算会把批准之后的新改动吃进方案里，等于静默覆盖用户的新编辑。
       * 冲突检测在 applyPhaseEdit 内比对 baseSignature 完成。 */
      const baseSignature = str(p.baseSignature);
      const computed = computePhaseEdit(goal, changes);
      if (!computed.ok) return { ok: false, content: computed.content, summary: computed.summary };
      const draft = { ...computed.draft, baseSignature: baseSignature || computed.draft.baseSignature };
      return applyPhaseEdit(draft);
    }
    /* ---- 第二批 C（AG-05）：阅读与笔记业务动作落地 ---- */
    case "edit_book_goal": {
      const book = store.books.find((b) => b.id === str(p.bookId));
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      const cur = book.goal;
      const GOAL_TYPES = ["understand", "think", "apply", "retain"] as const;
      const primary = str(p.primary);
      const secondary = Array.isArray(p.secondary) ? (p.secondary as string[]) : undefined;
      const intent = str(p.intent);
      const background = str(p.background);
      /* 目标字段整体替换：没有提供且原值存在的项保持原值（局部更新语义） */
      const nextGoal = {
        primary: ((GOAL_TYPES as readonly string[]).includes(primary) ? primary : cur?.primary ?? "understand") as (typeof GOAL_TYPES)[number],
        secondary: (secondary ?? cur?.secondary ?? []).filter((t): t is (typeof GOAL_TYPES)[number] => (GOAL_TYPES as readonly string[]).includes(t)),
        intent: intent || cur?.intent,
        background: background || cur?.background,
        inferred: false, // 用户显式修改 = 不再是推断值
        setAt: new Date().toISOString(),
      };
      store.setBookGoal(book.id, nextGoal);
      track("reading_goal_edit", { via: "agent", book: cut(book.title, 24) });
      const primaryChanged = !cur || cur.primary !== nextGoal.primary;
      return {
        ok: true,
        content:
          `《${book.title}》阅读目标已更新（主=${nextGoal.primary}${nextGoal.secondary.length ? `，次=${nextGoal.secondary.join("/")}` : ""}）。` +
          (primaryChanged && book.chapters.length > 0
            ? "主目标变了，建议在阅读页按新目标重排路线；已完成的验收与沉淀会保留。"
            : ""),
        summary: "目标已更新",
      };
    }
    case "set_reading_progress": {
      const bookId = str(p.bookId);
      const chapterId = str(p.chapterId);
      const chapterStatus = str(p.chapterStatus);
      const readStatus = str(p.readStatus);
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      if (chapterId && chapterStatus) {
        /* done 与掌握分开：手动标记不写 masteredAt（PRD 4.3 语义） */
        store.setChapterStatus(bookId, chapterId, chapterStatus as "reading" | "done" | "skipped" | "todo");
      }
      if (readStatus) {
        store.setBookReadStatus(bookId, readStatus as "reading" | "finished" | "assessing" | "unread");
      }
      track("reading_progress", { via: "agent", book: cut(str(p.bookTitle), 24), chapter: chapterStatus || "-", read: readStatus || "-" });
      const parts = [
        chapterId && chapterStatus ? `章节「${str(p.chapterTitle)}」→ ${chapterStatus}` : "",
        readStatus ? `全书状态 → ${readStatus}` : "",
      ].filter(Boolean);
      return { ok: true, content: `《${str(p.bookTitle)}》已更新：${parts.join("；")}。`, summary: "进度已更新" };
    }
    case "move_chapter": {
      const bookId = str(p.bookId);
      const dir = Number(p.dir) === -1 ? -1 : 1;
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      store.moveChapter(bookId, str(p.chapterId), dir as -1 | 1);
      return {
        ok: true,
        content: `《${str(p.bookTitle)}》路线已调整：「${str(p.chapterTitle)}」${dir === -1 ? "上移" : "下移"}一位。内容与状态不变。`,
        summary: "顺序已调整",
      };
    }
    case "save_reading_deposit": {
      const bookId = str(p.bookId);
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      store.addBookDeposit(bookId, {
        chapterId: str(p.chapterId) || undefined,
        type: str(p.type) as keyof typeof DEPOSIT_TYPE_LABELS,
        text: str(p.text),
      });
      track("reading_deposit", { via: "agent", book: cut(str(p.bookTitle), 24), type: str(p.type) });
      return {
        ok: true,
        content: `已保存《${str(p.bookTitle)}》${str(p.chapterTitle) ? `章节「${str(p.chapterTitle)}」` : ""}的沉淀（${DEPOSIT_TYPE_LABELS[str(p.type) as keyof typeof DEPOSIT_TYPE_LABELS] ?? str(p.type)}）。可以在阅读页的沉淀区查看。`,
        summary: "沉淀已保存",
      };
    }
    case "link_notes": {
      const from = store.knowledge.find((k) => k.id === str(p.fromId));
      const to = store.knowledge.find((k) => k.id === str(p.toId));
      if (!from || !to) return { ok: false, content: "笔记已不存在。", summary: "未找到" };
      if (from.links.includes(to.id)) return { ok: true, content: "两条笔记已关联，无需重复。", summary: "已存在" };
      store.linkNotes(from.id, to.id);
      return { ok: true, content: `已建立双向关联：《${from.title}》 ↔ 《${to.title}》。`, summary: "已关联" };
    }
    case "review_queue": {
      const action = str(p.action);
      const noteId = str(p.id);
      /* 批准到执行之间笔记可能已被删除：enableReview/recordReview 对不存在的 id 都是
       * 静默 no-op（recordReview 直接 return），旧实现仍报「已加入/已记录」= 谎报成功。 */
      if (!store.knowledge.some((k) => k.id === noteId))
        return { ok: false, content: "这篇笔记已不存在（可能已被删除），本次没有记录任何复习状态。", summary: "未找到" };
      if (action === "enable") {
        store.enableReview(noteId, p.enabled === true);
        return {
          ok: true,
          content: `《${str(p.title)}》已${p.enabled === true ? "加入" : "移出"}复习队列。`,
          summary: p.enabled === true ? "已加入" : "已移出",
        };
      }
      /* record：依据用户真实作答更新，不凭模型判断伪造复习记录 */
      store.recordReview(noteId, p.ok === true);
      return {
        ok: true,
        content: `《${str(p.title)}》本次复习已记为${p.ok === true ? "答对" : "未答对"}，复习计划会据此调整。`,
        summary: "已记录",
      };
    }
    /* ---- 第二批 C（AG-05 R06）：节点验收落库；通过即记掌握 ---- */
    case "record_book_assessment": {
      const bookId = str(p.bookId);
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      const chapterId = str(p.chapterId);
      if (!book.chapters.some((c) => c.id === chapterId)) return { ok: false, content: "章节已不存在（可能路线已重排）。", summary: "章节未找到" };
      store.addChapterAssessment(bookId, {
        id: uid("as"),
        chapterId,
        kind: str(p.kind) as "explain" | "connect" | "apply",
        question: str(p.question),
        answer: str(p.answer),
        level: str(p.level) as "mastered" | "partial" | "not" | "ungradable",
        evidence: str(p.evidence),
        feedback: str(p.feedback),
        at: new Date().toISOString(),
      });
      let masteredNote = "";
      if (str(p.level) === "mastered") {
        store.markChapterMastered(bookId, chapterId, str(p.evidence));
        masteredNote = "本章已标记为验收掌握（masteredAt）。";
      }
      track("reading_assessment", { via: "agent", book: cut(str(p.bookTitle), 24), kind: str(p.kind), level: str(p.level) });
      return {
        ok: true,
        content: `《${str(p.bookTitle)}》章节「${str(p.chapterTitle)}」验收已记录（${str(p.level)}，判分依据已存档）。${masteredNote}`,
        summary: "验收已记录",
      };
    }
    /* ---- 第二批 C（AG-05 R02）：书目信息修改 ---- */
    case "update_book": {
      const bookId = str(p.bookId);
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      const patch: { title?: string; author?: string } = {};
      if (p.newTitle) patch.title = str(p.newTitle);
      if (p.author) patch.author = str(p.author);
      store.updateBook(bookId, patch);
      return { ok: true, content: `《${str(p.bookTitle)}》书目信息已更新。章节、进度、验收、沉淀、对话全部保留。`, summary: "已更新" };
    }
    /* ---- 第二批 C（AG-05 R02）：删除书籍（影响已在审批卡展示） ---- */
    case "remove_book": {
      const bookId = str(p.bookId);
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在（可能已删除）。", summary: "未找到" };
      store.removeBook(bookId);
      track("reading_remove", { via: "agent", book: cut(str(p.bookTitle), 24) });
      return {
        ok: true,
        content: `《${str(p.bookTitle)}》已从书架删除（章节进度/对话/沉淀/验收档案一并清除；第二大脑笔记不受影响）。`,
        summary: "已删除",
      };
    }
    /* ---- 第二批 C（AG-05 R04）：重排路线（预览时已生成，执行前冲突检测） ---- */
    case "rebuild_reading_route": {
      const bookId = str(p.bookId);
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      /* EX-15：批准到执行之间书的路线被改过则拒绝，不静默覆盖 */
      const nowSig = bookRouteSignature(book);
      const baseSig = str(p.baseSignature);
      if (baseSig && nowSig !== baseSig) {
        return {
          ok: false,
          content: "检测到冲突：方案展示之后，这本书的目标或路线已被修改（可能是另一标签页）。为避免覆盖你的新改动，本次未应用——请重新生成方案。",
          summary: "检测到冲突",
        };
      }
      /* 先快照旧路线（可恢复），再写入预览时已生成的方案 */
      store.snapshotBookRoute(bookId, `重排为${str(p.routeType)}路线${str(p.userNote) ? `：${str(p.userNote)}` : ""}`);
      store.regenerateBookRoute(bookId, p.plan as Parameters<typeof store.regenerateBookRoute>[1]);
      track("reading_route_rebuild", { via: "agent", book: cut(str(p.bookTitle), 24), routeType: str(p.routeType) });
      const n = Array.isArray(p.plan) ? 0 : ((p.plan as { chapters?: unknown[] })?.chapters?.length ?? 0);
      return {
        ok: true,
        content: `《${str(p.bookTitle)}》已重排为${str(p.routeType) === "core" ? "核心" : str(p.routeType) === "goal" ? "目标导向" : "完整"}路线（${n} 节）。旧路线已存入历史（可恢复）；已完成的验收归档到验收档案；沉淀/对话/洞见保留。`,
        summary: `已重排 ${n} 节`,
      };
    }
    case "restore_book_route": {
      const bookId = str(p.bookId);
      const book = store.books.find((b) => b.id === bookId);
      if (!book) return { ok: false, content: "书已不存在。", summary: "未找到" };
      const ok = store.restoreBookRoute(bookId, str(p.historyId));
      return ok
        ? { ok: true, content: `《${str(p.bookTitle)}》路线已恢复到所选版本。对话/沉淀/洞见/验收档案保留；恢复前的路线也已存入历史，可再回退。`, summary: "已恢复" }
        : { ok: false, content: "恢复失败：历史版本不存在。", summary: "失败" };
    }
    /* ---- V26.1 P0：资源硬约束重出（B4/B5） ---- */
    case "update_plan_resources": {
      const goalId = str(p.goalId);
      const phaseId = str(p.phaseId);
      const topic = str(p.topic);
      const dayIds = Array.isArray(p.dayIds) ? (p.dayIds as string[]) : [];
      const constraint = parseResourceConstraint(str(p.constraintText));
      const store2 = useAppStore.getState();
      const goal = store2.goals.find((g) => g.id === goalId);
      if (!goal?.plan) return { ok: false, content: "目标或计划不存在。", summary: "未找到" };

      /* 每天检索：B站优先（query 直接带 site 或关键词），取结果里能确定性分类为视频且大陆可达的。
       * 双保险：执行期再查一次 stub（批准到执行之间天可能被重排/展开）——stub 天跳过不写入。
       * 单次上限只用来保护 /api/search 的每用户每日配额；超出部分**必须如实告知**，
       * 不能像旧实现那样 slice(0,5) 静默截断却把消息写成整阶段已换（用户设的硬约束未完整应用）。 */
      const MAX_RESOURCE_DAYS = 10;
      const report = { checked: 0, replaced: 0, skipped: 0, failed: 0 };
      const curGoal = useAppStore.getState().goals.find((g) => g.id === goalId);
      const executableDayIds = dayIds.filter((id) => {
        const d = curGoal?.plan?.days[id];
        return d && !d.stub;
      });
      const targetDayIds = executableDayIds.slice(0, MAX_RESOURCE_DAYS);
      for (const dayId of targetDayIds) {
        const day = goal.plan.days[dayId];
        if (!day) continue;
        const query = `bilibili ${topic} ${day.title} 教程`;
        try {
          const res = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
            signal,
          });
          const j = (await res.json().catch(() => ({}))) as {
            error?: string;
            results?: { title: string; url: string; snippet: string }[];
          };
          report.checked += 1;
          /* 服务端故障/限流不得被吞成「没找到合格视频」的空态：那是把错误态伪装成空态，
           * 会误导用户改关键词重试（同文件 web_search 对同一端点有完整检查）。 */
          if (!res.ok || j.error) {
            report.failed += 1;
            continue;
          }
          const validated = validateResources(j.results ?? [], constraint);
          const goodVideos = validated.verdicts
            .filter((v) => v.resType === "video" && v.access === "verified" && v.violations.length === 0)
            .slice(0, 2);
          if (goodVideos.length === 0) {
            report.skipped += 1;
            continue;
          }
          const newResources = goodVideos.map((v) => ({
            title: cut(v.title, 60),
            url: v.url || undefined,
            why: `视频硬约束重出：${day.title}`,
            kind: "course" as const,
          }));
          store2.updateDayResources(goalId, dayId, newResources);
          report.replaced += 1;
        } catch (e) {
          /* 用户点停止：中止在途检索，不再继续烧配额（与 web_search/read_url 同纪律） */
          if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw e;
          report.failed += 1;
        }
      }

      const truncated = executableDayIds.length - targetDayIds.length;
      const notes: string[] = [];
      if (report.skipped > 0)
        notes.push(`有 ${report.skipped} 天暂时没找到合格视频——如实告知：宁缺毋滥，可以稍后再让我重试，或换更宽泛的关键词。`);
      if (report.failed > 0)
        notes.push(`有 ${report.failed} 天检索失败（搜索服务暂时不可用/限流），不是「没有合格视频」——请稍后让我重试。`);
      if (truncated > 0)
        notes.push(`本阶段共 ${executableDayIds.length} 天，单次最多处理 ${MAX_RESOURCE_DAYS} 天，其余 ${truncated} 天仍是原资源——需要的话再说一次继续。`);
      return {
        ok: report.replaced > 0,
        content:
          report.replaced > 0
            ? `已为 ${report.replaced}/${targetDayIds.length} 天换上经校验的大陆可访问视频资源（B站单集直链）。` + notes.join("")
            : executableDayIds.length === 0
              ? "该阶段的天在执行前已变成占位状态（可能刚被重排），没有可替换的天。"
              : report.failed === targetDayIds.length
                ? `检索全部失败（${report.failed} 天，搜索服务暂时不可用/限流）——没有替换任何资源，不是「没有合格视频」。请稍后重试。`
                : `没有找到合格的中文视频资源（检索了 ${report.checked} 天）——如实告知：不会用文档凑数。可以换关键词（比如更具体的主题词）再试，或允许部分天使用文档并在 why 里注明。` +
                  notes.join(""),
        summary: report.replaced > 0 ? `${report.replaced} 天已换` : report.failed > 0 ? "检索失败" : "未找到合格视频",
      };
    }
    /* ---- 个人扩展（v24.0 二期）：批准后写服务端 KV（技能/记忆/提醒都在云端，跨设备生效） ---- */
    case "memory": {
      const action = str(p.action);
      if (action === "forget") {
        const res = await fetch(`/api/memory?id=${encodeURIComponent(str(p.id))}`, { method: "DELETE", signal });
        if (!res.ok) return { ok: false, content: "删除记忆失败", summary: "删除失败" };
        return { ok: true, content: "已忘掉这条记忆。", summary: "已遗忘" };
      }
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: p.text, tags: p.tags, source: "agent" }),
        signal,
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || j.error) return { ok: false, content: `记忆保存失败：${j.error ?? res.status}`, summary: "保存失败" };
      return { ok: true, content: `记住了：${str(p.text)}`, summary: "已记住" };
    }
    case "reminders": {
      const action = str(p.action);
      if (action === "delete") {
        const res = await fetch(`/api/reminders?id=${encodeURIComponent(str(p.id))}`, { method: "DELETE", signal });
        if (!res.ok) return { ok: false, content: "删除提醒失败", summary: "删除失败" };
        return { ok: true, content: "提醒已删除。", summary: "已删除" };
      }
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: p.title,
          prompt: p.prompt,
          time: p.time,
          days: p.days,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
        }),
        signal,
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; reminder?: { time: string; days: number[] } };
      if (!res.ok || j.error) return { ok: false, content: `提醒创建失败：${j.error ?? res.status}`, summary: "创建失败" };
      return {
        ok: true,
        content: `定时提醒已创建：${str(p.title)} —— ${str(p.time)} ${formatWeekdays(Array.isArray(p.days) ? (p.days as number[]) : [])}（到点发到你的注册邮箱）。`,
        summary: "已创建",
      };
    }
    default:
      return { ok: false, content: "未知动作类型", summary: "未知动作" };
  }
}

/* 仅开发环境：把工具执行器挂到 window，供 UI 走查/诊断脚本驱动与 UI 完全相同的代码路径。
 * 生产构建（NODE_ENV=production）不暴露。 */
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __mentoraTools?: unknown }).__mentoraTools = { executeTool, executeAction };
}
