"use client";

/* 用户关键事实的确定性提取与更正（CTX-01 / PRD §7.2）
 *
 * 要解决的问题（Q06/C01/C02）：用户早就说过「我会 Python、目的是看懂 ML 论文、每周 3 小时」，
 * 聊了十几轮之后模型又回头问一遍；更糟的是用户把「每周 3 小时」改成「每周 5 小时」之后，
 * 两条事实都被当成当前值同时喂给模型，回答就自相矛盾。
 *
 * 为什么不用模型压缩：PRD 明确「第一次部署优先用确定性事实提取/选择；确需模型压缩时，
 * 达到水位或发生显著变更才触发，不能每轮多调用一次压缩模型」。这里全部是正则 + 结构，
 * 零额外请求、可单测、结果可复现。
 *
 * 纪律：
 *  - 只从**用户自己的原话**里提取（assistant 的复述、模型的猜测、用户否定项都不算事实）；
 *  - 每条事实带来源 messageId 与时间，可追溯；
 *  - 同类事实后者覆盖前者，并把旧值标 superseded（不是两条并列）；
 *  - 明确的否定（"不是/不学/不想"）要记为否定事实，不能当成正向事实。
 */

export interface UserFact {
  /** 事实槽位：同一 slot 的新事实覆盖旧的 */
  slot: FactSlot;
  /** 归一化后的当前值（给模型看的自然语言短句） */
  value: string;
  /** 来源消息 id 与时间（可追溯，PRD §7.2） */
  messageId: string;
  at: string;
  /** 被后来更正的事实（不再进上下文，但保留在记录里以便审计） */
  superseded?: boolean;
  /** 原文片段（保留用户原话，避免改写失真） */
  quote: string;
}

export type FactSlot =
  | "background"   // 已有基础/会什么
  | "purpose"      // 目的/为什么学
  | "time"         // 每周/每天可投入时间
  | "level"        // 水平自评
  | "preference"   // 学习偏好（只要视频/不要文档…）
  | "constraint";  // 硬约束（截止日期、设备、可访问性）

/** 把命中的句子归一化成**只含当前值**的短句。
 *  为什么不能整句照抄：用户原话常带「旧的3小时不要再用了」这类对照，
 *  整句塞进上下文等于把已作废的值又喂回模型（C02 的失败模式原样重现）。 */
function normalizeValue(slot: FactSlot, sentence: string): string | null {
  if (slot === "time") {
    /* 取**最后一个**时间量词：中文里更新说法通常是「…现在每周可以5小时，旧的3小时不要了」，
     * 新值出现在「改成/现在是」之后；取最后一个能覆盖绝大多数表述。
     * 数字段必须同时接受小数（「每周3.5小时」「每天1.5h」是常见表述）：只写整数类时
     * 「3.5」会在 3 之后遇到 '.' 匹配失败，整条事实静默丢失。 */
    const all = [...sentence.matchAll(/(每(?:周|天|日))\s*(?:只)?(?:能|可以|有|投入|花)?\s*(\d+(?:\.\d+)?|[0-9一二三四五六七八九十两半]+)\s*(?:个)?\s*(小时|h|H|分钟)/g)];
    if (all.length === 0) return null;
    const m = all[all.length - 1];
    const unit = m[1] === "每天" || m[1] === "每日" ? "每天" : "每周";
    return `${unit}可投入 ${m[2]} ${m[3] === "分钟" ? "分钟" : "小时"}`;
  }
  if (slot === "background") {
    const m = /我(?:会|已经会|学过|懂|用过)\s*([^，。；！？\n]{1,24})/.exec(sentence);
    if (m) return `已有基础：${m[1].trim()}`;
    const m2 = /我(?:是|有)([^，。；！？\n]{1,24}?)(?:基础|经验)/.exec(sentence);
    if (m2) return `已有基础：${m2[1].trim()}`;
    /* 「我是前端工程师/我是学生/我在做运营」这类身份型自述：RULES 会命中，但上面两条
     * 提取正则都不匹配（它们要求「基础/经验」或「会/学过」），此前落到无信息量的兜底，
     * 模型看到「已有基础（用户自述）」等于槽位为空。这里把身份短语本身提出来。 */
    const m3 = /我(?:是|现在做|在做|从事)\s*([^，。；！？\n]{1,24})/.exec(sentence);
    if (m3) return `已有基础：${m3[1].trim()}`;
    /* 三条都没命中说明这句里提不出可用的背景内容（RULES 的宽匹配可能只是「我有个想法」这类）。
     * 此时返回 null——宁可这条不记，也不产出「已有基础（用户自述）」这种把槽位标成已填、
     * 内容为空的假事实：模型会据此以为拿到了背景，既不追问也猜不准（正是本模块要消灭的失败模式）。 */
    return null;
  }
  if (slot === "purpose") {
    const m = /(?:为了|目的是|主要是想|因为想)\s*([^，。；！？\n]{1,40})/.exec(sentence);
    return m ? `目的：${m[1].trim()}` : null;
  }
  if (slot === "level") {
    const m = /(零基础|新手|小白|入门|中级|高级|有经验)/.exec(sentence);
    return m ? `水平自评：${m[1]}` : null;
  }
  if (slot === "preference") {
    const m = /(?:只要|不要|偏好|更喜欢|倾向于)\s*([^，。；！？\n]{1,24})/.exec(sentence);
    return m ? `偏好：${m[1].trim()}` : null;
  }
  if (slot === "constraint") {
    return `硬约束：${sentence.replace(/^[，,、\s]+/, "").slice(0, 40)}`;
  }
  return null;
}

/** 各类事实的识别规则：顺序有意义（先匹配更具体的 slot）。 */
const RULES: { slot: FactSlot; re: RegExp; label: string }[] = [
  /* 时间投入：每周/每天 N 小时/分钟。必须抓住「现在改成」这类更新语义由后面的
   * 覆盖逻辑处理（同 slot 新值覆盖旧值）。 */
  { slot: "time", re: /每(?:周|天|日)\s*(?:只)?(?:能|可以|有|投入|花)?\s*(?:\d+(?:\.\d+)?|[0-9一二三四五六七八九十两半]+)\s*(?:个)?\s*(?:小时|h|H|分钟)/, label: "时间投入" },
  { slot: "background", re: /我(?:会|已经会|学过|懂|用过|有.{0,6}基础|是.{0,8}(?:工程师|程序员|学生|老师|产品|运营|设计))/, label: "已有基础" },
  { slot: "purpose", re: /(?:为了|目的是|想用.{0,10}(?:来|去)|主要是想|因为想)/, label: "学习目的" },
  { slot: "level", re: /我(?:是|属于).{0,6}(?:零基础|新手|小白|入门|中级|高级|有经验)/, label: "水平自评" },
  { slot: "preference", re: /(?:只要|不要|偏好|更喜欢|倾向于).{0,12}(?:视频|文档|书|文字|音频|英文|中文|例子|理论)/, label: "学习偏好" },
  { slot: "constraint", re: /(?:截止|deadline|必须.{0,8}之前|只有.{0,6}(?:设备|电脑|手机)|大陆|翻墙|无法访问)/i, label: "硬约束" },
];

/** 明确的否定/撤回：命中则本句不作为正向事实（也不覆盖已有值）。 */
const NEGATION = /(?:不是|并不|并没有|不用|不想|不学|不需要|算了|放弃|别再|不要按)/;

/** 更正语义：命中说明这是对已有事实的更新，需要把旧的标 superseded。 */
const CORRECTION = /(?:改成|改为|更新一下|现在是|调整成|变成|不再|更正|纠正|说错|改为每周|改为每天)/;

const CJK = /[\u4e00-\u9fff]/;

/** 从一条用户消息里抽出候选事实（一句一条，避免长段误判）。 */
export function extractFactsFromMessage(msg: { id: string; role: "user" | "assistant"; content: string; at: string }): UserFact[] {
  /* 只认用户原话：assistant 的复述会把模型的猜测写成「用户事实」（PRD §7.2 明令禁止） */
  if (msg.role !== "user") return [];
  const text = (msg.content || "").trim();
  if (!text || text.length > 800) return []; // 超长粘贴内容不做事实提取（噪声太多）
  const sentences = text
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 160 && CJK.test(s));

  const out: UserFact[] = [];
  for (const s of sentences) {
    if (NEGATION.test(s) && !CORRECTION.test(s)) continue; // 否定句不当正向事实
    for (const rule of RULES) {
      if (!rule.re.test(s)) continue;
      const value = normalizeValue(rule.slot, s);
      if (!value) continue;
      out.push({
        slot: rule.slot,
        value,
        messageId: msg.id,
        at: msg.at,
        quote: s, // 原文只用于审计追溯，不进上下文
      });
      break; // 一句只归一个 slot，避免重复计入
    }
  }
  return out;
}

/** 合并进既有事实集：同 slot 新值覆盖旧值，旧值标 superseded。
 *  `corrected` 为 true 表示这是更正（用户明确说改成…），调用方据此在上下文里
 *  只给新值——无论是否显式更正，同 slot 都只保留最新一条作为「当前值」。 */
export function mergeFacts(existing: UserFact[], incoming: UserFact[]): UserFact[] {
  const next = existing.map((f) => ({ ...f }));
  for (const f of incoming) {
    /* 完全相同（同一句重复出现）不重复记 */
    if (next.some((x) => !x.superseded && x.slot === f.slot && x.quote === f.quote)) continue;
    for (const old of next) {
      if (!old.superseded && old.slot === f.slot && old.messageId !== f.messageId) old.superseded = true;
    }
    /* 同一条消息里同 slot 只留最后一句 */
    const dupIdx = next.findIndex((x) => !x.superseded && x.slot === f.slot && x.messageId === f.messageId);
    if (dupIdx >= 0) next[dupIdx].superseded = true;
    next.push(f);
  }
  return next;
}

/** 当前有效事实（供上下文装配）：每 slot 一条最新，按重要性排序。 */
export function activeFacts(facts: UserFact[]): UserFact[] {
  const order: FactSlot[] = ["purpose", "background", "level", "time", "constraint", "preference"];
  const latest = new Map<FactSlot, UserFact>();
  for (const f of facts) {
    if (f.superseded) continue;
    const cur = latest.get(f.slot);
    if (!cur || f.at >= cur.at) latest.set(f.slot, f);
  }
  return order.flatMap((slot) => {
    const f = latest.get(slot);
    return f ? [f] : [];
  });
}

/** 装配成给模型看的一段文本。明确标注「已更正」的旧值**不出现**，
 *  避免模型同时看到 3 小时和 5 小时（Q06/C02 的核心失败模式）。 */
export function factsToContext(facts: UserFact[]): string {
  const act = activeFacts(facts);
  if (act.length === 0) return "";
  const lines = act.map((f) => `- ${f.value}`);
  return `## 用户已明确说过的事实（按最新值；不要重复询问）\n${lines.join("\n")}`;
}

/** 是否存在被更正过的槽位（用于提示模型「旧值已作废」）。 */
export function correctedSlots(facts: UserFact[]): FactSlot[] {
  const superseded = new Set(facts.filter((f) => f.superseded).map((f) => f.slot));
  const active = new Set(facts.filter((f) => !f.superseded).map((f) => f.slot));
  return [...superseded].filter((s) => active.has(s));
}
