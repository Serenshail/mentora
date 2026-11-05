"use client";

/* 智能体工具执行器（v2）：按工具名分发到本地 store 或受守卫的服务端端点。
 * 只读工具直接执行；写入工具只做参数校验并返回 PendingAction，
 * 由 UI 审批卡确认后调 executeAction() 真正落库。
 * 涉密操作（apiKey/baseUrl/密码/注销/整包导入导出）不在此表——模型无法调用不存在的东西。 */
import { streamChat, extractJson, readingPlanSchema } from "@/lib/ai/client";
import { useAppStore } from "@/lib/store";
import { buildContext, wikiRetrieve } from "@/lib/rag";
import { todayISO, uid } from "@/lib/utils";
import type {
  PendingAction,
  ToolName,
  ToolResult,
} from "./protocol";

/** 引用来源（web_search/read_url 产出，随消息持久化渲染） */
export interface Citation {
  title: string;
  url: string;
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

/* ========= 只读工具 ========= */

function readContextPayload() {
  const s = useAppStore.getState();
  const goal = s.goals.find((g) => g.status === "active");
  const day = goal?.plan ? Object.values(goal.plan.days).find((d) => d.status === "active") : null;
  const today = todayISO();
  const due = s.knowledge.filter((k) => k.nextReviewAt && k.nextReviewAt <= today).length;
  const book = s.books.find((b) => b.status === "reading");
  return {
    activeGoal: goal ? { topic: goal.topic, direction: goal.direction } : null,
    currentDay: day?.title ?? null,
    dueReviews: due,
    knowledgeCount: s.knowledge.length,
    readingBook: book ? { title: book.title, chapters: book.chapters.length } : null,
    sessions: s.sessions.length,
    settings: {
      userName: s.settings.userName || null,
      coachTone: s.settings.coachTone,
      digestWeekly: s.settings.digestWeekly,
    },
  };
}

async function runReadTool(name: ToolName, args: Record<string, unknown>): Promise<ToolOutcome> {
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
    const payload = readContextPayload();
    const goal = payload.activeGoal?.topic;
    return {
      result: {
        ok: true,
        content: JSON.stringify(payload),
        summary: goal ? `${goal} · 待复习${payload.dueReviews}` : "无进行中目标",
      },
    };
  }

  if (name === "get_note") {
    const id = str(args.id);
    const title = str(args.title);
    if (!id && !title) return { result: { ok: false, content: "需要 id 或 title 之一", summary: "参数缺失" } };
    const note =
      (id && store.knowledge.find((k) => k.id === id)) ||
      (title &&
        (store.knowledge.find((k) => k.title === title) ??
          store.knowledge.find((k) => k.title.includes(title)))) ||
      null;
    if (!note) return { result: { ok: true, content: "没有找到这篇笔记。", summary: "未找到" } };
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
    const lines = store.goals.slice(0, 10).map((g) => {
      const days = g.plan ? Object.values(g.plan.days) : [];
      const done = days.filter((d) => d.status === "passed" || d.status === "skipped").length;
      return `- ${g.topic}（${g.status}${days.length ? `，${done}/${days.length} 天` : "，无计划"}）方向：${cut(g.direction || "未定", 30)}`;
    });
    return {
      result: { ok: true, content: `共 ${store.goals.length} 个目标：\n${lines.join("\n")}`, summary: `${store.goals.length} 个` },
    };
  }

  if (name === "get_goal") {
    const topic = str(args.topic);
    if (!topic) return { result: { ok: false, content: "缺少 topic", summary: "参数缺失" } };
    const goal =
      store.goals.find((g) => g.topic.includes(topic)) ??
      store.goals.find((g) => topic.includes(g.topic) || g.direction.includes(topic));
    if (!goal) return { result: { ok: true, content: `没有找到与「${topic}」相关的目标。`, summary: "未找到" } };
    const days = goal.plan ? Object.values(goal.plan.days) : [];
    const active = days.find((d) => d.status === "active");
    const done = days.filter((d) => d.status === "passed").length;
    const content = [
      `目标：${goal.topic}（${goal.status}）`,
      goal.direction ? `方向：${goal.direction}` : "",
      goal.motivation ? `动机：${goal.motivation}` : "",
      goal.plan ? `计划：${goal.plan.summary}（${done}/${days.length} 天完成）` : "尚无计划（引导/计划在学习页进行）",
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
    return { result: { ok: true, content: lines.join("\n"), summary: `${store.books.length} 本` } };
  }

  if (name === "list_sessions") {
    if (store.sessions.length === 0)
      return { result: { ok: true, content: "人生伙伴还没有会话。", summary: "0 个" } };
    const lines = store.sessions.slice(0, 10).map((sess) => {
      const last = sess.messages[sess.messages.length - 1];
      return `- ${sess.title}（${sess.messages.length} 条${last ? `，最近：${cut(last.content, 20)}` : ""}）`;
    });
    return { result: { ok: true, content: lines.join("\n"), summary: `${store.sessions.length} 个` } };
  }

  if (name === "get_settings_public") {
    const st = store.settings;
    const payload = {
      provider: st.provider,
      model: st.model,
      usingCustomKey: Boolean(st.apiKey),
      usingCustomBaseUrl: st.provider === "custom" && Boolean(st.baseUrl),
      userName: st.userName || null,
      coachTone: st.coachTone,
      digestWeekly: st.digestWeekly,
    };
    return {
      result: { ok: true, content: JSON.stringify(payload), summary: `${st.provider}/${st.model}` },
    };
  }

  if (name === "make_quiz") {
    const topic = str(args.topic) || "刚才讲的内容";
    const count = Math.max(2, Math.min(Number(args.count ?? 3) || 3, 5));
    const goal = store.goals.find((g) => g.status === "active");
    const day = goal?.plan
      ? Object.values(goal.plan.days).find((d) => d.status === "active")
      : null;
    const material = day?.knowledgePoints?.map((k) => k.text).slice(0, count) ?? [];
    const quiz: string[] = [];
    for (let i = 0; i < count; i++) {
      const m = material[i];
      quiz.push(
        m
          ? `${i + 1}. 关于「${m}」：用自己的话解释它是什么、为什么需要它，并举一个最小例子。`
          : `${i + 1}. 关于「${topic}」：说出一个最容易被误解的点，并解释为什么误解是错的。`
      );
    }
    return {
      result: {
        ok: true,
        content: `已生成 ${count} 道自测题：\n${quiz.join("\n")}\n\n请把题目原样放在回答末尾（不要附答案），提示用户先自己想。`,
        summary: `${count} 道题`,
      },
    };
  }

  if (name === "web_search") {
    const query = str(args.query);
    if (!query) return { result: { ok: false, content: "缺少 query", summary: "参数缺失" } };
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const j = (await res.json()) as { error?: string; results?: { title: string; url: string; snippet: string }[] };
      if (!res.ok || j.error) {
        return { result: { ok: false, content: `搜索失败：${j.error ?? res.status}`, summary: "搜索失败" } };
      }
      const results = j.results ?? [];
      if (results.length === 0)
        return { result: { ok: true, content: "没有搜到相关结果。", summary: "0 条" } };
      const citations: Citation[] = results.map((r) => ({ title: r.title, url: r.url }));
      const content = results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${cut(r.snippet, 200)}`)
        .join("\n\n");
      return {
        result: { ok: true, content: `搜索到 ${results.length} 条结果：\n\n${content}\n\n回答时注明来源编号或链接。`, summary: `${results.length} 条结果` },
        citations,
      };
    } catch (e) {
      return { result: { ok: false, content: `搜索失败：${e instanceof Error ? e.message : "网络错误"}`, summary: "搜索失败" } };
    }
  }

  if (name === "read_url") {
    const url = str(args.url);
    if (!/^https?:\/\//i.test(url))
      return { result: { ok: false, content: "url 必须以 http/https 开头", summary: "参数不合法" } };
    try {
      const res = await fetch("/api/fetch-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
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
        citations: [{ title: j.title || url, url }],
      };
    } catch (e) {
      return { result: { ok: false, content: `读取失败：${e instanceof Error ? e.message : "网络错误"}`, summary: "读取失败" } };
    }
  }

  return { result: { ok: false, content: "未知只读工具", summary: "未知工具" } };
}

/* ========= 写入工具：校验 + 生成待确认 action（不执行） ========= */

function findNote(id: string, title: string) {
  const store = useAppStore.getState();
  return (
    (id && store.knowledge.find((k) => k.id === id)) ||
    (title && (store.knowledge.find((k) => k.title === title) ?? store.knowledge.find((k) => k.title.includes(title)))) ||
    null
  );
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
    const note = findNote(str(args.id), str(args.title));
    if (!note) return { result: { ok: false, content: "没有找到要修改的笔记。", summary: "未找到" } };
    const newTitle = str(args.newTitle);
    const body = typeof args.body === "string" ? args.body.trim() : "";
    if (!newTitle && !body)
      return { result: { ok: false, content: "newTitle 和 body 至少提供一个", summary: "参数缺失" } };
    return draftAction(
      "update_note",
      "修改笔记",
      `${cut(note.title, 20)}${newTitle ? ` → ${cut(newTitle, 20)}` : ""}`,
      { id: note.id, newTitle: newTitle || undefined, body: body || undefined }
    );
  }

  if (name === "delete_note") {
    const note = findNote(str(args.id), str(args.title));
    if (!note) return { result: { ok: false, content: "没有找到要删除的笔记。", summary: "未找到" } };
    return draftAction("delete_note", "删除笔记", cut(note.title, 30), { id: note.id, title: note.title });
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
    });
  }

  if (name === "create_session") {
    const title = str(args.title);
    if (!title) return { result: { ok: false, content: "缺少 title", summary: "参数缺失" } };
    return draftAction("create_session", "新建会话", cut(title, 30), {
      title,
      personaId: str(args.personaId) || "roundtable",
    });
  }

  if (name === "update_settings") {
    const st = store.settings;
    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    if (typeof args.userName === "string" && args.userName.trim()) {
      patch.userName = args.userName.trim().slice(0, 20);
      changes.push(`称呼 → ${patch.userName}`);
    }
    if (args.coachTone === "standard" || args.coachTone === "gentle") {
      if (st.coachTone !== args.coachTone) {
        patch.coachTone = args.coachTone;
        changes.push(`教练风格 → ${args.coachTone === "gentle" ? "温和鼓励" : "标准直接"}`);
      }
    }
    if (typeof args.digestWeekly === "boolean" && st.digestWeekly !== args.digestWeekly) {
      patch.digestWeekly = args.digestWeekly;
      changes.push(`每周复习邮件 → ${args.digestWeekly ? "开" : "关"}`);
    }
    if (typeof args.provider === "string" && args.provider && args.provider !== st.provider) {
      const known = ["demo", "zai", "deepseek", "moonshot", "openai", "maas", "custom"];
      if (!known.includes(args.provider))
        return { result: { ok: false, content: `不支持的 provider：${args.provider}`, summary: "参数不合法" } };
      patch.provider = args.provider;
      changes.push(`模型服务商 → ${args.provider}`);
    }
    if (typeof args.model === "string" && args.model.trim() && args.model.trim() !== st.model) {
      patch.model = args.model.trim();
      changes.push(`模型 → ${args.model.trim()}`);
    }
    if (Object.keys(patch).length === 0)
      return { result: { ok: true, content: "设置已经是目标状态，无需修改。", summary: "无变化" } };
    return draftAction("update_settings", "修改设置", changes.join("、").slice(0, 60), { patch });
  }

  return { result: { ok: false, content: "未知写入工具", summary: "未知工具" } };
}

/** 工具入口：读 → 直接执行；写 → 校验并返回待确认 action */
export async function executeTool(name: ToolName, args: Record<string, unknown>): Promise<ToolOutcome> {
  const spec = (
    {
      save_note: 1, update_note: 1, delete_note: 1, create_goal: 1,
      add_book: 1, create_session: 1, update_settings: 1,
    } as Partial<Record<ToolName, number>>
  )[name];
  return spec ? validateWriteTool(name, args) : runReadTool(name, args);
}

/* ========= 批准后的真正执行 ========= */

export async function executeAction(action: PendingAction): Promise<ToolResult> {
  const store = useAppStore.getState();
  const p = action.payload;

  switch (action.kind) {
    case "save_note": {
      const title = str(p.title);
      const body = str(p.body);
      const domain = str(p.domain) || "笔记";
      store.addKnowledge([{ title, body, domain }], "manual", "智能体");
      return { ok: true, content: `笔记《${title}》已存入第二大脑。`, summary: "已保存" };
    }
    case "update_note": {
      const id = str(p.id);
      const patch: { title?: string; body?: string } = {};
      if (typeof p.newTitle === "string" && p.newTitle) patch.title = p.newTitle;
      if (typeof p.body === "string" && p.body) patch.body = p.body;
      store.updateKnowledge(id, patch);
      return { ok: true, content: `笔记已更新（${Object.keys(patch).join("、")}）。`, summary: "已更新" };
    }
    case "delete_note": {
      store.removeKnowledge(str(p.id));
      return { ok: true, content: `笔记《${str(p.title)}》已删除。`, summary: "已删除" };
    }
    case "create_goal": {
      const goalId = uid("goal");
      store.addGoal({
        id: goalId,
        topic: str(p.topic),
        direction: str(p.direction),
        domainKind: "other",
        motivation: str(p.motivation),
        background: "",
        weeklyHours: 8,
        successCriteria: Array.isArray(p.successCriteria)
          ? (p.successCriteria as unknown[]).map((c) => str(c)).filter(Boolean)
          : [],
        status: "draft",
        createdAt: new Date().toISOString(),
        quizLog: [],
        intakeTranscript: [],
      });
      return {
        ok: true,
        content: `学习目标「${str(p.topic)}」已创建（草稿）。完整计划需要引导对话：请到「学习」页打开这个目标继续。`,
        summary: "已创建",
      };
    }
    case "add_book": {
      const title = str(p.title);
      const author = str(p.author);
      const brief = str(p.brief);
      const desc = `书名：《${title}》${author ? ` 作者：${author}` : ""}${brief ? `\n简介：${brief}` : ""}`;
      const full = await streamChat({
        args: { desc },
        messages: [{ role: "user", content: "生成阅读计划。" }],
        temperature: 0.5,
        task: "reading-plan",
        onDelta: () => {},
      });
      const plan = readingPlanSchema.parse(extractJson(full));
      const bookId = uid("book");
      store.addBook({
        id: bookId,
        title,
        author: author || undefined,
        status: "reading",
        profile: plan.bookProfile || undefined,
        planSummary: plan.planSummary,
        chapters: plan.chapters.map((c) => ({
          ...c,
          knowledgeType: c.knowledgeType || "concept",
          coreIdea: c.coreIdea || undefined,
          perspectives: c.perspectives || undefined,
          capture: c.capture || undefined,
          id: uid("ch"),
          status: "todo" as const,
        })),
        insights: [],
        chat: [],
        createdAt: new Date().toISOString(),
      });
      return {
        ok: true,
        content: `《${title}》已上架，阅读计划拆了 ${plan.chapters.length} 章：${plan.chapters.map((c) => c.title).join("、")}。可以去「读书伙伴」开始读。`,
        summary: `${plan.chapters.length} 章`,
      };
    }
    case "create_session": {
      const sessionId = uid("sess");
      store.addSession({
        id: sessionId,
        personaId: str(p.personaId) || "roundtable",
        title: str(p.title),
        messages: [],
        createdAt: new Date().toISOString(),
      });
      return {
        ok: true,
        content: `会话「${str(p.title)}」已创建。去「人生伙伴」打开它开始对话。`,
        summary: "已创建",
      };
    }
    case "update_settings": {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      store.setSettings(patch as never);
      return { ok: true, content: `设置已更新：${Object.keys(patch).join("、")}。`, summary: "已更新" };
    }
    default:
      return { ok: false, content: "未知动作类型", summary: "未知动作" };
  }
}
