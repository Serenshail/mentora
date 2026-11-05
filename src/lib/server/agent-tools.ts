import "server-only";
import { TOOLS } from "@/lib/agent/protocol";

/* 智能体工具契约（服务端组装，不进浏览器包）
 * 与客户端工具执行器保持同名同参；客户端只负责执行，
 * 提示词与 schema 属于产品资产，按 IP 保护纪律留在服务端。
 * v2：双产物——文本提示词（围栏降级通道）+ OpenAI tools JSON（原生通道）。 */

/** 参数说明 → 简化 JSON Schema（type:object + description；让网关侧模型能读懂怎么填参） */
function schemaOf(params: string) {
  return {
    type: "object" as const,
    properties: {},
    description: params,
  };
}

/** 原生 tool_calls 通道的 tools 数组（OpenAI 兼容格式） */
export function agentToolsSchema() {
  return Object.values(TOOLS).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: `${t.description}${t.risk === "write" ? "（写入类：用户会看到确认卡，批准后才执行）" : ""}`,
      parameters: schemaOf(t.params),
    },
  }));
}

/** 围栏降级通道的工具提示词 */
export function agentToolsPrompt(): string {
  const lines = Object.values(TOOLS).map(
    (t) =>
      `- \`${t.name}\`（${t.risk === "write" ? "写入，需用户确认" : "只读，自动执行"}）：${t.description} 参数：${t.params}`
  );
  return `## 你可以使用的工具
${lines.join("\n")}

### 调用方式（围栏协议）
需要调用工具时，先写一句给用户看的说明，然后输出一个 JSON 代码块：
\`\`\`tool
{"name": "search_brain", "args": {"query": "闭包"}}
\`\`\`
可以一次并行调用多个工具（输出多个 tool 块）；拿到结果后再决定下一步。

### 多步任务先出计划
列一个 plan 代码块（字符串数组），用户会看到每一步的状态：
\`\`\`plan
["检索你的笔记", "整理成三条要点", "存为新笔记"]
\`\`\`

### 纪律
- **只在真有帮助时调用**。问"什么是协程"不需要检索笔记；问"我之前记过什么关于 X"才检索。
- 计划只用于多步任务（≥3 步）；单点问答不要建计划。
- 工具失败就如实说失败，禁止编造结果。
- **用户明确说"存成笔记 / 发到笔记 / 记到第二大脑"时，必须调用 save_note**：先把内容写进回答，再调用工具把同一份内容存进去；不要只把文档贴在正文里说"你复制过去"。
- 同一个工具带同样的参数不要连续调用两次；需要更多信息就换参数或换工具。`;
}
