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

  if (name === "resume_workflow") {
    const kind = str(args.kind) || "auto";
    const title = str(args.title);
    const tryKinds: string[] =
      kind === "auto" ? ["learning", "reading", "council"] : [kind];
    for (const k of tryKinds) {
      if (k === "learning") {
        const goal = title
          ? store.goals.find((g) => g.topic.includes(title) || title.includes(g.topic))
          : store.goals.find((g) => g.status === "active") ??
            store.goals.find((g) => g.status === "draft");
        if (!goal) continue;
        const days = goal.plan ? Object.values(goal.plan.days) : [];
        const done = days.filter((d) => d.status === "passed" || d.status === "skipped").length;
        const url = !goal.plan || goal.status === "draft" ? `/learn/new?goal=${goal.id}` : `/learn/${goal.id}`;
        track("workflow_resume", { to: "learn", topic: cut(goal.topic, 24) });
        return {
          result: {
            ok: true,
            content: `找到学习目标「${goal.topic}」（${goal.status}${days.length ? `，${done}/${days.length} 天完成` : "，尚无计划"}）。接续入口：${url}${goal.status === "draft" ? "（从上次引导对话继续）" : ""}`,
            summary: cut(goal.topic, 24),
          },
        };
      }
      if (k === "reading") {
        const book = title
          ? store.books.find((b) => b.title.includes(title))
          : store.books.find((b) => b.status === "reading") ?? store.books[0];
        if (!book) continue;
        const doneCh = book.chapters.filter((c) => c.status === "done").length;
        track("workflow_resume", { to: "read", title: cut(book.title, 24) });
        return {
          result: {
            ok: true,
            content: `找到书架里的《${book.title}》（${book.status}，${doneCh}/${book.chapters.length} 章完成）。接续入口：/read/${book.id}——打开后从当前节点继续。`,
            summary: cut(book.title, 24),
          },
        };
      }
      if (k === "council") {
        const sess = title
          ? store.sessions.find((x) => x.title.includes(title))
          : store.sessions[0];
        if (!sess) continue;
        track("workflow_resume", { to: "council", title: cut(sess.title, 24) });
        return {
          result: {
            ok: true,
            content: `找到会话「${sess.title}」（${sess.messages.length} 条消息）。接续入口：/council——打开人生伙伴选择这个会话继续。`,
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
    return runPersonalTool(name, args);
  }

  return { result: { ok: false, content: "未知只读工具", summary: "未知工具" } };
}

/* ========= 个人扩展工具（v24.0 二期）：读走 API 直查，写产 action 待确认 ========= */

async function runPersonalTool(name: ToolName, args: Record<string, unknown>): Promise<ToolOutcome> {
  const action = str(args.action);

  if (name === "memory") {
    if (action === "recall") {
      const q = str(args.query);
      const res = await fetch(`/api/memory?q=${encodeURIComponent(q)}&limit=20`);
      const j = (await res.json().catch(() => ({}))) as { entries?: { id: string; text: string; tags: string[] }[]; total?: number };
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
    const res = await fetch("/api/reminders");
    const j = (await res.json().catch(() => ({}))) as {
      reminders?: { id: string; title: string; time: string; days: number[]; enabled: boolean }[];
    };
    const list = j.reminders ?? [];
    if (list.length === 0) return { result: { ok: true, content: "还没有定时提醒。", summary: "0 条" } };
    const dayNames = ["日", "一", "二", "三", "四", "五", "六"];
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

  if (name === "regenerate_phase") {
    const topic = str(args.topic);
    const userNote = str(args.userNote);
    if (!topic) return { result: { ok: false, content: "需要 topic", summary: "参数不足" } };
    const goal =
      store.goals.find((g) => g.topic.includes(topic)) ??
      store.goals.find((g) => topic.includes(g.topic));
    if (!goal?.plan) return { result: { ok: false, content: "没有找到该目标的计划。", summary: "未找到" } };
    const phaseTitle = str(args.phaseTitle);
    const phase = phaseTitle
      ? goal.plan.phases.find((ph) => ph.title.includes(phaseTitle))
      : goal.plan.phases.find((ph) => goal.plan!.days && Object.values(goal.plan!.days).some((d) => d.phaseId === ph.id && d.status === "active")) ??
        goal.plan.phases.find((ph) => ph.status === "active") ??
        goal.plan.phases[0];
    if (!phase) return { result: { ok: false, content: "没有找到指定阶段。", summary: "未找到阶段" } };
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
    const goal =
      store.goals.find((g) => g.topic.includes(topic)) ??
      store.goals.find((g) => topic.includes(g.topic));
    if (!goal?.plan) return { result: { ok: false, content: "没有找到该目标的计划。", summary: "未找到" } };
    const days = Object.values(goal.plan.days);
    const phaseTitle = str(args.phaseTitle);
    const phase = phaseTitle
      ? goal.plan.phases.find((ph) => ph.title.includes(phaseTitle))
      : goal.plan.phases[0];
    if (!phase) return { result: { ok: false, content: "没有找到指定阶段。", summary: "未找到阶段" } };
    const dayIds = phase.dayIds.filter((id) => goal.plan!.days[id]);
    if (dayIds.length === 0) return { result: { ok: false, content: "该阶段还没有天级计划。", summary: "阶段为空" } };
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
      material: str(args.material),
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
  /* 五段埋点·意图段：每次工具调用即一次"Agent 判断需要动手"的记录 */
  const isWrite = (
    {
      save_note: 1, update_note: 1, delete_note: 1, create_goal: 1,
      add_book: 1, create_session: 1, update_settings: 1, update_plan_resources: 1, regenerate_phase: 1,
    } as Partial<Record<ToolName, number>>
  )[name] != null;
  track("agent_tool_intent", { tool: name, write: isWrite ? 1 : 0 });
  const spec = (
    {
      save_note: 1, update_note: 1, delete_note: 1, create_goal: 1,
      add_book: 1, create_session: 1, update_settings: 1, update_plan_resources: 1,
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
      console.info("[flow] handoff → learn", topic.slice(0, 24));
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
      console.info("[flow] handoff → read", title.slice(0, 24));
      return {
        ok: true,
        content: `《${title}》已上架，阅读计划拆了 ${plan.chapters.length} 章：${plan.chapters.map((c) => c.title).join("、")}。可以去「学习」页的「读书伙伴」开始读。`,
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
      track("workflow_handoff", { to: "council" });
      console.info("[flow] handoff → council", str(p.title).slice(0, 24));
      return {
        ok: true,
        content: `会话「${str(p.title)}」已创建。去「人生伙伴」打开它开始对话。`,
        summary: "已创建",
      };
    }
    /* ---- V26.1 P0-B7/B11：阶段重排（结构性修改，完成日>0 时审批卡带警告） ---- */
    case "regenerate_phase": {
      const { regeneratePhase } = await import("@/lib/agent/phase-regen");
      const r = await regeneratePhase(str(p.goalId), str(p.phaseId), str(p.userNote), true);
      return { ok: r.ok, content: r.content, summary: r.summary };
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

      /* 每天检索：B站优先（query 直接带 site 或关键词），取结果里能确定性分类为视频且大陆可达的 */
      const report = { checked: 0, replaced: 0, skipped: 0 };
      for (const dayId of dayIds.slice(0, 5)) {
        const day = goal.plan.days[dayId];
        if (!day) continue;
        const query = `bilibili ${topic} ${day.title} 教程`;
        try {
          const res = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query }),
          });
          const j = (await res.json().catch(() => ({}))) as {
            results?: { title: string; url: string; snippet: string }[];
          };
          report.checked += 1;
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
        } catch {
          report.skipped += 1;
        }
      }

      const failedDays = dayIds.slice(0, 5).length - report.replaced;
      return {
        ok: report.replaced > 0,
        content:
          report.replaced > 0
            ? `已为 ${report.replaced}/${dayIds.slice(0, 5).length} 天换上经校验的大陆可访问视频资源（B站单集直链）。` +
              (failedDays > 0
                ? `有 ${failedDays} 天暂时没找到合格视频——如实告知：宁缺毋滥，可以稍后再让我重试，或换更宽泛的关键词。`
                : "")
            : `没有找到合格的中文视频资源（检索了 ${report.checked} 天）——如实告知：不会用文档凑数。可以换关键词（比如更具体的主题词）再试，或允许部分天使用文档并在 why 里注明。`,
        summary: report.replaced > 0 ? `${report.replaced} 天已换` : "未找到合格视频",
      };
    }
    case "update_settings": {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      store.setSettings(patch as never);
      return { ok: true, content: `设置已更新：${Object.keys(patch).join("、")}。`, summary: "已更新" };
    }
    /* ---- 个人扩展（v24.0 二期）：批准后写服务端 KV（技能/记忆/提醒都在云端，跨设备生效） ---- */
    case "memory": {
      const action = str(p.action);
      if (action === "forget") {
        const res = await fetch(`/api/memory?id=${encodeURIComponent(str(p.id))}`, { method: "DELETE" });
        if (!res.ok) return { ok: false, content: "删除记忆失败", summary: "删除失败" };
        return { ok: true, content: "已忘掉这条记忆。", summary: "已遗忘" };
      }
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: p.text, tags: p.tags, source: "agent" }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || j.error) return { ok: false, content: `记忆保存失败：${j.error ?? res.status}`, summary: "保存失败" };
      return { ok: true, content: `记住了：${str(p.text)}`, summary: "已记住" };
    }
    case "reminders": {
      const action = str(p.action);
      if (action === "delete") {
        const res = await fetch(`/api/reminders?id=${encodeURIComponent(str(p.id))}`, { method: "DELETE" });
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
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string; reminder?: { time: string; days: number[] } };
      if (!res.ok || j.error) return { ok: false, content: `提醒创建失败：${j.error ?? res.status}`, summary: "创建失败" };
      return {
        ok: true,
        content: `定时提醒已创建：${str(p.title)} —— ${str(p.time)}${Array.isArray(p.days) && p.days.length ? ` 每周${(p.days as number[]).join("、")}` : " 每天"}（到点发到你的注册邮箱）。`,
        summary: "已创建",
      };
    }
    default:
      return { ok: false, content: "未知动作类型", summary: "未知动作" };
  }
}
