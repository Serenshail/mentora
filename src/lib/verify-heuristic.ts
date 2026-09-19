/* 三重验收的启发式评分——无 AI Key（演示模式）或评分服务异常时的兜底。
 * 规则设计与权重（通俗举例 30% + 知识迁移 30% + 相似度 40%）移植自用户自己的
 * CogniRead 项目（github.com/1030017080-blip/cogniread, MIT），在此致谢。 */

export interface HeuristicScores {
  example: number;
  transfer: number;
  similarity: number;
  total: number;
  level: "understood" | "partial" | "not";
  suggestion: string;
}

/** 简化 Jaccard 相似度（按词/字） */
function jaccard(text1: string, text2: string): number {
  const seg = (t: string) => new Set(t.toLowerCase().split(/\s+/).filter((w) => w.length > 0));
  const w1 = seg(text1);
  const w2 = seg(text2);
  const inter = [...w1].filter((x) => w2.has(x)).length;
  const union = new Set([...w1, ...w2]).size;
  return union === 0 ? 0 : inter / union;
}

const EXAMPLE_PATTERNS = [
  /例如[，,：:]?\s*.+/,
  /比如[，,：:]?\s*.+/,
  /举个例子[，,：:]?\s*.+/,
  /举例说明[，,：:]?\s*.+/,
  /以.+为例/,
  /就像.+一样/,
  /相当于.+/,
];

const TRANSFER_PATTERNS = [
  /这让我联想到/,
  /类似的情况/,
  /同样地/,
  /相似地/,
  /对比.+来看/,
  /从这个角度/,
  /换个角度/,
  /延伸到/,
  /应用[到在]/,
  /可以用于/,
];

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(text)).length;
}

/** answers: 三题作答；coreIdea: 本章核心论点（作为相似度基准） */
export function heuristicVerify(args: {
  answers: string[];
  coreIdea: string;
  focusQuestion: string;
}): HeuristicScores {
  const all = args.answers.join("\n");
  const exampleHits = countMatches(all, EXAMPLE_PATTERNS);
  const transferHits = countMatches(all, TRANSFER_PATTERNS);
  const example = Math.min(100, exampleHits * 40 + 30);
  const transfer = Math.min(100, transferHits * 35 + 25);
  const similarity = Math.round(jaccard(all, `${args.coreIdea} ${args.focusQuestion}`) * 100);
  const total = Math.round(example * 0.3 + transfer * 0.3 + similarity * 0.4);
  const level = total >= 80 ? "understood" : total >= 50 ? "partial" : "not";
  const suggestion =
    level === "understood"
      ? "这个单元你已经真懂了，进入下一个。"
      : level === "partial"
        ? example < 50
          ? "补一个你自己的生活实例，比再读一遍有用。"
          : "试着把这个观点用到一件你正在做的具体事情上。"
        : "回正文把核心论点再读一遍，用自己的话复述后再来验收。";
  return { example, transfer, similarity, total, level, suggestion };
}
