/* 指令解析（纯函数，可单测；不与 store/网络耦合） */
import { TOOLS, type ToolName } from "./protocol";

export function parseDirectives(text: string): {
  tool?: { name: ToolName; args: Record<string, unknown> };
  /** 多工具并行（Codex 式）：一次输出多个 tool 块时全部解析 */
  tools?: { name: ToolName; args: Record<string, unknown> }[];
  plan?: string[];
} {
  let tool: { name: ToolName; args: Record<string, unknown> } | undefined;
  let tools: { name: ToolName; args: Record<string, unknown> }[] | undefined;
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
  return { tool, plan };
}

export function stripDirectives(text: string): string {
  const RULE_WORDS = "(?:不要说|不要寒暄|不要反问|不要附加|不要建议|不要输出|不要工具块|不要写|禁止|只输出|只给|长度短|中文口语|不写小标题|禁寒暄)";
  return text
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
