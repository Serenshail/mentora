/* 指令解析（纯函数，可单测；不与 store/网络耦合）
 * v2：修复 tools 数组丢失（v1 并行工具是死代码）；作为原生 tool_calls 的降级通道。 */
import { TOOLS, type ToolName } from "./protocol";

export interface ParsedDirectives {
  /** 兼容字段：第一个工具 */
  tool?: { name: ToolName; args: Record<string, unknown> };
  /** 全部工具（支持多个=并行调用） */
  tools?: { name: ToolName; args: Record<string, unknown> }[];
  plan?: string[];
  /** 出现但无法解析的 ```tool 块数（坏 JSON / 缺 name / 未知工具名）。
   *  静默丢弃会让「模型以为调了、用户以为办了、实际什么都没发生」——
   *  调用方（runner）必须据此回注模型让其重发，而不是当普通回答收尾。 */
  badToolBlocks?: number;
}

export function parseDirectives(text: string): ParsedDirectives {
  let tool: ParsedDirectives["tool"];
  let tools: ParsedDirectives["tools"];
  let plan: string[] | undefined;
  let badToolBlocks = 0;

  /* 全部 tool 块（支持多个=并行调用；取第一个作兼容字段） */
  const toolMatches = [...text.matchAll(/```tool\s*([\s\S]*?)```/g)];
  for (const m of toolMatches) {
    try {
      const j = JSON.parse(m[1].trim()) as { name?: string; args?: Record<string, unknown> };
      /* Object.hasOwn 而非 in：TOOLS 是普通对象字面量，in 会命中原型链上的
       * toString/constructor 等继承属性，模型写 {"name":"toString"} 即可穿过校验。 */
      if (j?.name && Object.hasOwn(TOOLS, j.name)) {
        const call = { name: j.name as ToolName, args: j.args ?? {} };
        if (!tools) tools = [];
        tools.push(call);
        if (!tool) tool = call;
      } else {
        badToolBlocks += 1;
      }
    } catch { badToolBlocks += 1; /* 坏 JSON → 计数上报，由 runner 回注模型 */ }
  }

  const planMatch = text.match(/```plan\s*([\s\S]*?)```/);
  if (planMatch) {
    try {
      const arr = JSON.parse(planMatch[1].trim());
      if (Array.isArray(arr)) plan = arr.map((s) => String(s)).filter(Boolean).slice(0, 8);
    } catch { /* ignore */ }
  }
  return { tool, tools, plan, badToolBlocks };
}

export function stripDirectives(text: string): string {
  /* 只收「模型复述自己输出纪律」的短语。「禁止」「只给」这类词在正常教学内容里极常见
   * （「gets 是禁止使用的」「老师只给了一个提示」），整句删除会把用户已在流式里看过的
   * 正文吞掉且无标记——违反 output-integrity.ts「不删内容只标记」与 PRD §5.2
   * 「最终消息必须与被接受的流式内容相符」。 */
  const RULE_WORDS = "(?:不要说|不要寒暄|不要反问|不要附加|不要建议|不要输出|不要工具块|不要写|只输出|长度短|中文口语|不写小标题|禁寒暄)";
  /* 普通代码围栏先摘成占位符（\u0000 序号 \u0000）：下面的行级清理与尾部截断
   * 不再伤及代码内容（json/js 示例曾整段被删）。空围栏不摘（留给黑条清理）；
   * 占位符不含中英文，其余清理规则也扫不到它（各类字符类均排除 \u0000）。 */
  const fences: string[] = [];
  const stripped = text
    /* 统一换行，避免上游 CRLF 残留进渲染 */
    .replace(/\r\n?/g, "\n")
    /* 完整围栏 */
    .replace(/```(?:tool|plan)[\s\S]*?```/g, "")
    /* 流式未闭合的围栏尾巴 */
    .replace(/```(?:tool|plan)[\s\S]*$/g, "")
    /* 有内容的普通代码围栏 → 占位符 */
    .replace(/```[^\n]*\n[\s\S]*?```/g, (m) => {
      const inner = m.slice(m.indexOf("\n") + 1, m.length - 3);
      if (!inner.trim()) return m;
      fences.push(m);
      return `\u0000${fences.length - 1}\u0000`;
    })
    /* 独占一行的 JSON 残留（已在围栏外）：
     * 只删「整体能被 JSON.parse 通过」的行（{...}/[...]/"..." 残留）；
     * 不再按行首字符粗删——此前 ["[\]{}.*$ 会把行首 markdown 链接（[标题](url)）、
     * 引用样式行（[1] 标题）、引号对白整行吞掉，用户答案缺内容且无提示。
     * 裸 ASCII 引号字符串本身是合法 JSON 值，但独立成行且带中文句读的
     * `"好的，我们明天开始"` 是对白/确认语而非残留——按内容判据保留。 */
    .replace(/^\s*["[{][^\n]*$/gm, (line) => {
      const t = line.trim();
      try {
        const v = JSON.parse(t) as unknown;
        if (typeof v === "string" && /[\u4e00-\u9fff]/.test(v) && /[，、。！？：；…—]/.test(v)) return line;
        return "";
      } catch {
        /* 不是完整 JSON 值 → 是正常内容（如 [标题](url) 链接行、[1] 引用行、引号对白），保留 */
        return line;
      }
    })
    /* 模型复读规则：只删「整句就是在复述指令」的句子——句首（可带括号/标点）即指令词。
     * 此前只要指令词出现在句中任意位置就整句删除：「在 C 语言里，gets 函数是禁止使用的，
     * 因为缓冲区溢出风险。」「老师只给了一个提示，剩下的要自己推导。」这类正常教学内容
     * 被静默吞掉且无标记——违反 output-integrity.ts 的「不删内容只标记」纪律与
     * PRD §5.2「最终消息必须与被接受的流式内容相符」。 */
    .replace(new RegExp(`(?:^|[。！？\\n])\\s*(?:[（(【\\[]\\s*)?${RULE_WORDS}[^。！？\\n\\u0000]{0,40}[。；;]?`, "g"), (m) =>
      m.startsWith("\n") || m.startsWith("。") || m.startsWith("！") || m.startsWith("？") ? m[0] : ""
    )
    /* 末尾混入英文内部独白 → 截断到最后一个中文句末（限单行：跨行会把收尾代码块整个删掉） */
    .replace(/([。！？])[^\n。！？\u0000]*[A-Za-z]{2,}[^\n。！？\u0000]*$/g, "$1")
    /* 空围栏（``` 紧跟 ```，中间只有空白）渲染出来是一块黑条：清掉 */
    .replace(/```[^\n]*\n?\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  /* 还原代码围栏 */
  return stripped.replace(/\u0000(\d+)\u0000/g, (_, i: string) => fences[Number(i)] ?? "");
}

/** 原生 tool_calls 聚合器：把 OpenAI 流式分片拼成完整调用（服务端/客户端共用逻辑） */
export interface NativeToolCall {
  id: string;
  name: string;
  /** 未解析的 arguments JSON 字符串 */
  argsRaw: string;
}

export class ToolCallAggregator {
  private parts = new Map<number, { id: string; name: string; argsRaw: string }>();

  /** 喂入一个 delta.tool_calls 分片 */
  feed(deltas: unknown): void {
    if (!Array.isArray(deltas)) return;
    for (const d of deltas) {
      const idx = Number((d as { index?: unknown }).index ?? 0);
      const cur = this.parts.get(idx) ?? { id: "", name: "", argsRaw: "" };
      const piece = d as { id?: string; function?: { name?: string; arguments?: string } };
      if (piece.id) cur.id = piece.id;
      if (piece.function?.name) cur.name += piece.function.name;
      if (piece.function?.arguments) cur.argsRaw += piece.function.arguments;
      this.parts.set(idx, cur);
    }
  }

  /** 输出全部聚合完成的调用（按 index 顺序） */
  finish(): NativeToolCall[] {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, p]) => ({ id: p.id || `call_${p.name}`, name: p.name, argsRaw: p.argsRaw }))
      .filter((c) => c.name);
  }

  get isEmpty(): boolean {
    return this.parts.size === 0;
  }
}
