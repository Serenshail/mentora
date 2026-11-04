/* 智能体事件与工具协议（M3）
 *
 * 参照 openai/codex（MIT）codex-rs/protocol/src/items.rs 的真实模型：
 *   TurnItem = UserMessage | AgentMessage | Plan | Reasoning | CommandExecution | McpToolCall …
 *   PlanItem     = { id, text }                      —— 计划是一条条 item
 *   ReasoningItem= { id, summaryText[], rawContent[] } —— 对外只给摘要
 *   Tool 状态    = InProgress | Completed | Failed | Declined
 *
 * 我们的纪律（与学习场景对齐）：
 *  1. 只读工具自动执行；写入工具必须先 Confirmation；
 *  2. 计划是「外显的」——每一步都要能看到状态流转，不允许只报结果；
 *  3. 任何工具失败都要如实标 Failed，回答继续（不阻塞）；
 *  4. 单轮最多 MAX_TOOL_ROUNDS 轮，超限强制收尾并说明。
 */

export type ToolStatus = "in_progress" | "completed" | "failed" | "declined";

export type ToolName =
  /** 检索第二大脑笔记（只读） */
  | "search_brain"
  /** 读取当前学习上下文：目标/今日任务/待复习/当前书（只读） */
  | "read_context"
  /** 把内容存为笔记（写入，需确认） */
  | "save_note"
  /** 出题检验（只读，不含判分） */
  | "make_quiz";

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
    description: "按关键词在用户第二大脑里检索相关笔记，返回标题+摘要。",
    params: 'query: string（检索词，2-30 字）',
  },
  read_context: {
    name: "read_context",
    label: "查看学习状态",
    risk: "read",
    description: "读取用户当前的学习目标、今日任务、待复习数量、正在读的书。",
    params: "（无参数）",
  },
  save_note: {
    name: "save_note",
    label: "存为新笔记",
    risk: "write",
    description: "把一段内容整理成笔记存入第二大脑。必须先在正文里给出草稿，由用户确认后才会真正写入。",
    params: "title: string, body: string, domain?: string",
  },
  make_quiz: {
    name: "make_quiz",
    label: "出题检验",
    risk: "read",
    description: "针对刚讲过的内容出 2-3 道小题（不含答案），帮助用户自检。",
    params: "topic: string, count?: number",
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

/** 工具提示词：告诉模型有哪些工具、怎么调用、什么时候别用 */
export function toolsPrompt(): string {
  const lines = Object.values(TOOLS).map(
    (t) =>
      `- \`${t.name}\`（${t.risk === "write" ? "写入，需用户确认" : "只读，自动执行"}）：${t.description} 参数：${t.params}`
  );
  return `## 你可以使用的工具
${lines.join("\n")}

### 调用方式
需要调用工具时，先输出一行纯文本说明你要做什么（用户会看到），然后输出一个 JSON 代码块：
\`\`\`tool
{"name": "search_brain", "args": {"query": "闭包"}}
\`\`\`
每次只调用一个工具；拿到结果后再决定下一步。

### 纪律
- **只在真的有帮助时调用**。用户问"什么是协程"，不需要检索笔记；用户问"我之前记过什么关于 X"，才检索。
- 计划（plan）只用于**多步任务**（≥3 步、有依赖）。单点问答不要建计划。
- 需要多步时，先输出一个 plan 代码块：
\`\`\`plan
["检索你的笔记", "整理成三条要点", "存为新笔记"]
\`\`\`
- 工具返回失败时，如实告诉用户"检索失败"，不要编造结果。
- 写入类工具（save_note）只在你已经把内容完整写进回答后调用；用户会看到确认卡。`;
}
