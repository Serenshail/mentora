/* 指令解析（纯函数，可单测；不与 store/网络耦合）
 * v2：修复 tools 数组丢失（v1 并行工具是死代码）；作为原生 tool_calls 的降级通道。 */
import { TOOLS, type ToolName } from "./protocol";

export interface ParsedDirectives {
  /** 兼容字段：第一个工具 */
  tool?: { name: ToolName; args: Record<string, unknown> };
  /** 全部工具（支持多个=并行调用） */
  tools?: { name: ToolName; args: Record<string, unknown> }[];
  plan?: string[];
}

export function parseDirectives(text: string): ParsedDirectives {
  let tool: ParsedDirectives["tool"];
  let tools: ParsedDirectives["tools"];
  let plan: string[] | undefined;

  /* 全部 tool 块（支持多个=并行调用；取第一个作兼容字段） */
  const toolMatches = [...text.matchAll(/```tool\s*([\s\S]*?)```/g)];
  for (const m of toolMatches) {
    try {
      const j = JSON.parse(m[1].trim()) as { name?: string; args?: Record<string, unknown> };
      if (j?.name && j.name in TOOLS) {
        const call = { name: j.name as ToolName, args: j.args ?? {} };
        if (!tools) tools = [];
        tools.push(call);
        if (!tool) tool = call;
      }
    } catch { /* 坏 JSON → 跳过这一个 */ }
  }

  const planMatch = text.match(/```plan\s*([\s\S]*?)```/);
  if (planMatch) {
    try {
      const arr = JSON.parse(planMatch[1].trim());
      if (Array.isArray(arr)) plan = arr.map((s) => String(s)).filter(Boolean).slice(0, 8);
    } catch { /* ignore */ }
  }
  return { tool, tools, plan };
}

export function stripDirectives(text: string): string {
  const RULE_WORDS = "(?:不要说|不要寒暄|不要反问|不要附加|不要建议|不要输出|不要工具块|不要写|禁止|只输出|只给|长度短|中文口语|不写小标题|禁寒暄)";
  return text
    /* 统一换行，避免上游 CRLF 残留进渲染 */
    .replace(/\r\n?/g, "\n")
    /* 完整围栏 */
    .replace(/```(?:tool|plan)[\s\S]*?```/g, "")
    /* 流式未闭合的围栏尾巴 */
    .replace(/```(?:tool|plan)[\s\S]*$/g, "")
    /* 独占一行的 JSON 残留 */
    .replace(/^\s*["[\]{}].*$/gm, "")
    /* 模型复读规则：以句号/换行为界，把含指令词的整句删掉 */
    .replace(new RegExp(`(?:^|[。！？\\n])\\s*[^。！？\\n]{0,20}${RULE_WORDS}[^。！？\\n]{0,40}[。；;]?`, "g"), (m) =>
      m.startsWith("\n") || m.startsWith("。") || m.startsWith("！") || m.startsWith("？") ? m[0] : ""
    )
    /* 末尾混入英文内部独白 → 截断到最后一个中文句末 */
    .replace(/([。！？])[^。！？]*[A-Za-z]{2,}[^。！？]*$/g, "$1")
    /* 空围栏（``` 紧跟 ```，中间只有空白）渲染出来是一块黑条：清掉 */
    .replace(/```[^\n]*\n?\s*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
