/* 智能体事件与工具协议（v2，通用 harness）
 *
 * 参照 openai/codex（MIT）codex-rs/protocol/src/items.rs 的模型：
 *   TurnItem = UserMessage | AgentMessage | Plan | Reasoning | CommandExecution | McpToolCall
 *   PlanItem     = { id, text }                      —— 计划是一条条 item
 *   ReasoningItem= { id, summaryText[], rawContent[] } —— 对外只给摘要
 *   Tool 状态    = InProgress | Completed | Failed | Declined
 *
 * v2 纪律：
 *  1. 只读工具自动执行；写入工具必须经用户确认（PendingAction 审批门）；
 *  2. 计划外显，每步状态可见；
 *  3. 工具失败如实标 failed，回答继续；
 *  4. 单轮最多 MAX_TOOL_ROUNDS 轮；同一「工具+参数」连续重复视为打转，强制收尾；
 *  5. 涉密参数（apiKey/baseUrl/密码/账号操作）不进注册表——模型无法调用不存在的东西。
 */

export type ToolStatus = "in_progress" | "completed" | "failed" | "declined";

export type ToolName =
  /* ---- 检索与读取（只读） ---- */
  /** 检索第二大脑笔记（只读） */
  | "search_brain"
  /** 读取当前学习/阅读/会话状态总览（只读） */
  | "read_context"
  /** 按 id 或标题读取笔记全文（只读） */
  | "get_note"
  /** 列出学习目标（只读） */
  | "list_goals"
  /** 读取某个目标详情（只读） */
  | "get_goal"
  /** 列出书架（只读） */
  | "list_books"
  /** 列出人生伙伴会话（只读） */
  | "list_sessions"
  /** 读取公开设置（只读；绝不含 apiKey/baseUrl 值） */
  | "get_settings_public"
  /** 出题检验（只读，不含判分） */
  | "make_quiz"
  /* ---- 联网（只读，服务端守卫） ---- */
  /** 联网搜索（/api/search） */
  | "web_search"
  /** 读取一个公网页面的正文（/api/fetch-page） */
  | "read_url"
  /* ---- 写入（必须用户确认） ---- */
  /** 新建笔记 */
  | "save_note"
  /** 修改已有笔记（按 id 或标题） */
  | "update_note"
  /** 删除笔记 */
  | "delete_note"
  /** 新建学习目标草稿（完整计划在学习页生成） */
  | "create_goal"
  /** 新建书（自动拆阅读章节） */
  | "add_book"
  /** 新建人生伙伴会话 */
  | "create_session"
  /** 修改白名单设置（userName/coachTone/digestWeekly；provider/model 需确认） */
  | "update_settings"
  /** 恢复已有工作流：查学习目标/书架/会话的现有进度，返回接续入口（只读） */
  | "resume_workflow"
  /* ---- 个人扩展（v24.0 二期，action 型；读自动、写需确认） ---- */
  /** 长期记忆：recall / remember / forget */
  | "memory"
  /** 定时提醒：list / create / delete */
  | "reminders";

export interface ToolSpec {
  name: ToolName;
  label: string;
  /** 只读工具自动执行；写入必须用户确认 */
  risk: "read" | "write";
  description: string;
  /** 给模型看的参数说明（一句话） */
  params: string;
}

export const TOOLS: Record<ToolName, ToolSpec> = {
  search_brain: {
    name: "search_brain",
    label: "检索笔记",
    risk: "read",
    description: "在用户第二大脑里检索相关笔记，返回标题与关键摘录。",
    params: "query: string（检索词，2-30 字）",
  },
  read_context: {
    name: "read_context",
    label: "查看我的状态",
    risk: "read",
    description: "读取当前学习目标、今日任务、待复习数、正在读的书、最近会话一览。",
    params: "（无参数）",
  },
  get_note: {
    name: "get_note",
    label: "读笔记全文",
    risk: "read",
    description: "按标题或 id 读取一篇笔记的完整内容。",
    params: "title?: string, id?: string（二选一）",
  },
  list_goals: {
    name: "list_goals",
    label: "列出学习目标",
    risk: "read",
    description: "列出所有学习目标及其进度概况。",
    params: "（无参数）",
  },
  get_goal: {
    name: "get_goal",
    label: "看目标详情",
    risk: "read",
    description: "按主题关键词读取某个学习目标的计划与当前进度。",
    params: "topic: string（主题关键词）",
  },
  list_books: {
    name: "list_books",
    label: "看书架",
    risk: "read",
    description: "列出书架上的书与阅读状态。",
    params: "（无参数）",
  },
  list_sessions: {
    name: "list_sessions",
    label: "列出会话",
    risk: "read",
    description: "列出人生伙伴的会话（含圆桌）。",
    params: "（无参数）",
  },
  get_settings_public: {
    name: "get_settings_public",
    label: "查看设置",
    risk: "read",
    description: "读取当前设置（模型选择、称呼、教练风格、周报开关）。不含 API Key 等敏感值。",
    params: "（无参数）",
  },
  make_quiz: {
    name: "make_quiz",
    label: "出题检验",
    risk: "read",
    description: "针对刚讲过的内容出 2-5 道小题（不含答案），帮助用户自检。",
    params: "topic: string, count?: number",
  },
  web_search: {
    name: "web_search",
    label: "联网搜索",
    risk: "read",
    description: "联网搜索公开网页，返回标题、链接与摘要。回答时注明来源。",
    params: "query: string（搜索词，可用用户语言）",
  },
  read_url: {
    name: "read_url",
    label: "读网页正文",
    risk: "read",
    description: "读取一个公网 URL 的正文文本（搜索结果里挑值得细读的用）。",
    params: "url: string（http/https 公网地址）",
  },
  save_note: {
    name: "save_note",
    label: "存为新笔记",
    risk: "write",
    description: "把一段内容整理成新笔记存入第二大脑。必须先在正文里给出草稿，由用户确认后才写入。",
    params: "title: string, body: string, domain?: string",
  },
  update_note: {
    name: "update_note",
    label: "修改笔记",
    risk: "write",
    description: "修改一篇已有笔记的标题或正文（按标题或 id 定位）。",
    params: "title?: string, id?: string, newTitle?: string, body?: string",
  },
  delete_note: {
    name: "delete_note",
    label: "删除笔记",
    risk: "write",
    description: "删除一篇笔记（按标题或 id 定位）。谨慎使用。",
    params: "title?: string, id?: string",
  },
  create_goal: {
    name: "create_goal",
    label: "新建学习目标",
    risk: "write",
    description: "创建学习目标草稿并交接给学习引导：把对话里已掌握的背景写进参数（用户不用重复讲），引导只补必要的问题。成功后返回接续入口。",
    params: "topic: string, direction?: string, motivation?: string, background?: string（对话中已知的用户背景，交接用）, successCriteria?: string[]",
  },
  add_book: {
    name: "add_book",
    label: "加书上架",
    risk: "write",
    description: "把一本书加入书架并自动生成阅读计划（拆章节）。耗时较长。",
    params: "title: string, author?: string, brief?: string",
  },
  create_session: {
    name: "create_session",
    label: "新建会话",
    risk: "write",
    description: "在人生伙伴里新建一个会话（指定人物或圆桌席位）。",
    params: "title: string, personaId?: string（人物 id，缺省为默认人物）",
  },
  update_settings: {
    name: "update_settings",
    label: "修改设置",
    risk: "write",
    description: "修改白名单内的设置：称呼、教练风格、周报开关、模型选择。API Key 与自定义端点不可通过此工具修改。",
    params: "userName?: string, coachTone?: \"standard\"|\"gentle\", digestWeekly?: boolean, provider?: string, model?: string",
  },
  resume_workflow: {
    name: "resume_workflow",
    label: "恢复工作流",
    risk: "read",
    description: "用户说\"继续学/接着读/我的进度\"时，查找已有的学习目标、书架或会话，返回当前进度与接续入口。恢复而不是重建。",
    params: "kind?: \"learning\"|\"reading\"|\"council\"（缺省自动识别）, title?: string（按主题/书名/会话名匹配）",
  },
  memory: {
    name: "memory",
    label: "长期记忆",
    risk: "read",
    description:
      "长期记忆：action=recall 按 query 检索；action=remember 记一条用户事实（写，需确认）；action=forget 删除一条（写）。只记关于用户本人的稳定事实（保留用户原话要点，不要过度改写），不记寒暄。",
    params: 'action: "recall"|"remember"|"forget", query?, text?, tags?: string[], id?',
  },
  reminders: {
    name: "reminders",
    label: "定时提醒",
    risk: "read",
    description:
      "定时提醒（到点发邮件）：action=list 列出；action=create 新建（写，需确认）；action=delete 删除（写）。用户说\"每天早上 8 点提醒我复习\"就用这个。",
    params: 'action: "list"|"create"|"delete", title?, prompt?, time?（HH:mm）, days?: number[]（0=周日）, id?',
  },
};

export interface ToolCall {
  id: string;
  name: ToolName;
  args: Record<string, unknown>;
  status: ToolStatus;
  /** 结果摘要（给 UI 显示，限长） */
  summary?: string;
  startedAt: number;
  endedAt?: number;
}

export interface PlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

/** 写入类工具的确认草稿：UI 渲染审批卡，用户批准后才真正执行 */
export interface PendingAction {
  id: string;
  /** 工具名，执行器按 kind 分发 */
  kind: ToolName;
  /** 卡片标题（如「新建笔记」） */
  label: string;
  /** 一句话摘要 */
  summary: string;
  /** 批准后交给执行器的参数 */
  payload: Record<string, unknown>;
}

export interface ApprovalDecision {
  actionId: string;
  approved: boolean;
}

/** 一轮智能体运行的可观测状态（UI 直接渲染它） */
export interface AgentRun {
  runId: string;
  plan: PlanStep[];
  tools: ToolCall[];
  /** 模型的思考摘要（不是完整思维链，只给骨架） */
  reasoning: string[];
  phase: "thinking" | "acting" | "answering" | "done" | "failed" | "cancelled";
}

/** 单轮最多工具调用轮数：防止模型无限循环烧钱 */
export const MAX_TOOL_ROUNDS = 5;

/** 工具调用结果的统一形状（回注给模型） */
export interface ToolResult {
  ok: boolean;
  /** 给模型看的文本（简洁、结构化） */
  content: string;
  /** 给 UI 看的摘要（更短） */
  summary: string;
}

/** 计划状态机：只允许 pending→in_progress→completed/skipped，禁止跳级 */
export function advancePlan(plan: PlanStep[], stepId: string, status: PlanStep["status"]): PlanStep[] {
  return plan.map((s) => {
    if (s.id !== stepId) return s;
    const legal: Record<PlanStep["status"], PlanStep["status"][]> = {
      pending: ["in_progress", "skipped"],
      in_progress: ["completed", "skipped"],
      completed: [],
      skipped: [],
    };
    return legal[s.status].includes(status) ? { ...s, status } : s;
  });
}

/** 计划推进一步（修复 v1 双推进 bug：每批工具只推进「当前步完成 → 下一步开始」一次） */
export function stepPlanForward(plan: PlanStep[]): PlanStep[] {
  const cur = plan.find((s) => s.status === "in_progress");
  if (!cur) return plan;
  let next = advancePlan(plan, cur.id, "completed");
  const nxt = next.find((s) => s.status === "pending");
  if (nxt) next = advancePlan(next, nxt.id, "in_progress");
  return next;
}

/** 打转守卫：同一「工具名+参数」连续出现两次 → 视为模型在原地打转 */
export function isLooping(lastSig: string | null, sig: string): boolean {
  return lastSig === sig && sig !== "";
}

/** 工具调用签名（用于打转检测） */
export function callSignature(name: ToolName, args: Record<string, unknown>): string {
  let normalized: unknown;
  try {
    normalized = JSON.stringify(args, Object.keys(args).sort());
  } catch {
    normalized = JSON.stringify(args);
  }
  return `${name}:${normalized}`;
}
