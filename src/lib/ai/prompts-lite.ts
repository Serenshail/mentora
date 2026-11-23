/* 提示词相关的纯判定（可被客户端引用；prompts.ts 是 server-only，不能进浏览器包） */

/** 是否进入"深度讲解"模式：带图片，或用户明确要求讲解/分析材料
 *  判定完全委托 decideExplainDepth（单一口径）：deep/reteach 为真、brief 为假。
 *  此前这里还留了一条 `if (hasImage) return true` 兜底，但 decideExplainDepth 在
 *  hasImage 为真时必然先命中 deep（或被 RETEACH/BRIEF 提前截走），该行永不可达；
 *  下方兜底正则也与 DEEP/RETEACH 两组模式大量重叠——两份清单并存，
 *  改一处忘另一处就会静默分叉。故只保留 standard 档的「明确要求讲解」判定。 */
export function wantsDeepExplanation(text: string, hasImage = false): boolean {
  const decision = decideExplainDepth(text, { hasImage });
  if (decision.depth === "brief") return false;
  if (decision.depth === "reteach" || decision.depth === "deep") return true;
  /* standard 档：decideExplainDepth 不区分「只是随口一问」与「要求讲解材料」，
   * 后者仍应深讲。这里只列 DEEP/RETEACH 未覆盖的「要求讲解」词。
   * 「什么意思」虽由 CONCEPT_ONLY 归到 standard（概念问答），但此前 wantsDeepExplanation
   * 对它返回 true，此处保留，避免悄悄改变既有温度/篇幅档位。 */
  return /讲解|讲一下|解释一下|分析一下|怎么理解|讲讲|说说这|这段代码|这道题|这篇文章|这本书|这一章|什么意思/.test(text);
}

/* 讲解深度分级（ANS-01 / PRD §7.1）
 * 用户抱怨：「回答不够透彻」和「我只要两句话」是同时存在的两种需求。
 * 现在的实现只有 deep / 非 deep 两档，非 deep 时模型容易只给结论；
 * 用户说「还是不懂」时也不会换讲法。这里做三档判定，供提示词选择不同的收束方式。
 *
 * 判定只看用户原话与上下文事实，不调模型（PRD 要求「不能每轮多调用一次压缩模型」）。 */

export type ExplainDepth = "brief" | "standard" | "deep" | "reteach";

/** Product operations should report applied changes, rather than append a teaching workflow. */
export function isProductActionRequest(text:string):boolean {
  return /(?:新建|创建|搭建|修改|调整|删除|重排|改名|重命名|存成|保存|加入|添加|暂停).{0,40}(?:计划|目标|笔记|页面|工作台|清单|记录表|书籍|会话)|把.{0,100}(?:改名|改成|删除)|(?:计划|页面|笔记).{0,30}(?:改名|修改|删除)/.test(text);
}

/** 用户明确要求简短 / 只要结论 */
const BRIEF = /(?:只(?:用|要|需)?.{0,4}(?:两句|一句|一句话|简短|简单说)|两句话|一句话说|简要|简洁点|短一点|别太长|不用解释|直接给(?:结论|答案)|只给结论|只要(?:答案|结论))/;

/** 用户明确要求详细 */
const DEEP = /(?:详细|逐行|逐句|一行一行|一步一步|拆解|拆一下|剖析|讲透|深入|展开讲|为什么|怎么运作|原理|底层)/;

/** 用户表达「没懂」——必须换讲法，不能原样重复（Q04 的核心） */
const RETEACH = /(?:还是不懂|还是不明白|没听懂|看不懂|不理解|不太懂|没搞懂|换个(?:例子|说法|讲法)|别(?:再)?重复|能不能换个|讲得(?:太)?抽象)/;

/** 用户只要概念、不推进项目 */
const CONCEPT_ONLY = /(?:是什么|什么意思|有什么区别|区别是什么|定义)/;

export interface DepthDecision {
  depth: ExplainDepth;
  /** 给提示词的执行指令（明确、可检查） */
  instruction: string;
}

/**
 * 判定本轮讲解深度。
 * @param text 用户本轮原话
 * @param opts.hasImage 带图（默认深讲，用户传图就是要你读懂）
 * @param opts.lastAssistantWasSimilar 上一轮助手刚讲过同类内容（用户接着说「还是不懂」时要换法）
 */
export function decideExplainDepth(
  text: string,
  opts: { hasImage?: boolean; lastAssistantWasSimilar?: boolean } = {}
): DepthDecision {
  const t = text || "";
  /* 顺序很重要：先说「没懂」优先于「详细」——要换讲法，不是把同样的东西再讲一遍更长 */
  if (RETEACH.test(t)) {
    return {
      depth: "reteach",
      instruction:
        "用户上一轮没听懂。**不要重复上一轮的说法**，也不要只是写得更长。换一种讲法：先用一个具体的小例子/类比建立直觉，再回到准确的机制，并明确指出上一轮可能卡在哪一步。不要断言用户已经掌握。",
    };
  }
  if (BRIEF.test(t)) {
    return {
      depth: "brief",
      instruction:
        "用户明确要求简短。直接给结论，**严格按用户给的篇幅上限**（如「两句话」就只写两句）。不要套讲解骨架、不要出题、不要建目标、不要追加「要不要我再详细讲」。",
    };
  }
  if (opts.hasImage || DEEP.test(t)) {
    return {
      depth: "deep",
      instruction:
        "本轮需要讲透。按深讲骨架执行：目标 → 核心因果 → 关键中间过程（含一次具体执行的中间状态）→ 边界与失败路径 → 代价/复杂度。因果和必要前情不能被「简洁」压掉；但不要为凑长度重复。",
    };
  }
  if (CONCEPT_ONLY.test(t)) {
    return {
      depth: "standard",
      instruction:
        "用户只问概念。直接准确回答概念本身（一两段），**不要强行推进到项目/出题/建目标**；如果一句话能说清就一句话。",
    };
  }
  return {
    depth: "standard",
    instruction: "按自然简洁的风格回答：结论先行，必要的因果解释保留，不套骨架、不复述需求。",
  };
}
