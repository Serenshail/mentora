/* 读书对话·五模式(客户端安全元数据;模式硬契约在 prompts.ts/server-only)
 * UI 引这个文件;规则文本绝不下发到浏览器包。 */
export type ReadingMode = "socratic" | "feynman" | "collision" | "close-read" | "recall-check";

export interface ReadingModeMeta {
  id: ReadingMode;
  label: string;
  hint: string;
  forType: string;
}

export const READING_MODES: ReadingModeMeta[] = [
  { id: "socratic", label: "苏格拉底", hint: "只提问不讲解：定义→依据→反例→边界,追到你自己讲通", forType: "概念/原理" },
  { id: "feynman", label: "费曼讲桌", hint: "你讲,它当聪明外行只听:黑话/断裂/跳跃打回,绝不代讲", forType: "检验真懂" },
  { id: "collision", label: "思想碰撞", hint: "它站本书观点的对立面逼你辩护,每 3 轮可反转立场", forType: "判断/争议" },
  { id: "close-read", hint: "一次一段:原文主张→论证位置→一个理解性问题", label: "精读带读", forType: "原文细读" },
  { id: "recall-check", label: "复盘检验", hint: "先合书回忆再迁移,四级判定并记掌握状态", forType: "读完验收" },
];

/** 按章节知识类型推荐默认模式(不锁死,用户可切) */
export function defaultReadingMode(knowledgeType?: string): ReadingMode {
  switch (knowledgeType) {
    case "fact":
    case "discrimination":
      return "socratic";
    case "concept":
      return "socratic";
    case "procedure":
      return "recall-check";
    case "judgment":
      return "collision";
    case "creative":
      return "close-read";
    default:
      return "socratic";
  }
}
