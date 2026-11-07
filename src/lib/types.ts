/* ========= 领域类型：不同领域不同学习方式 ========= */
export type DomainKind =
  | "coding" // 编程：完整项目例子驱动
  | "language" // 语言：输入/输出循环
  | "humanities" // 人文社科：大问题导读 + 费曼口述
  | "exam" // 考试：真题 + 间隔重复
  | "career" // 职业技能：作品集驱动
  | "other";

export const DOMAIN_LABELS: Record<DomainKind, string> = {
  coding: "编程开发",
  language: "语言学习",
  humanities: "人文社科",
  exam: "考试备考",
  career: "职业技能",
  other: "通识技能",
};

/* ========= 计划 ========= */
export interface Resource {
  title: string;
  url?: string;
  why: string;
  /** 发布/最近修订年份:用于时效排序 */
  year?: number;
  /** 资料类型:official/doc/course/tutorial/book/paper/classic/repo 等(容错,模型可自由标注) */
  kind?: string;
  /** 经典旧著(evergreen):排序降权,作"经典补充" */
  evergreen?: boolean;
  /** 单集视频已通过平台接口实测存在（YouTube oEmbed / B站 view API） */
  verified?: boolean;
  /** 平台返回的真实作者/UP主 */
  author?: string;
}

export interface KnowledgePoint {
  id: string;
  text: string;
  detail?: string;
  /** 知识类型（Learn Anything 路由）：决定教学策略与验收方式 */
  knowledgeType?: KnowledgeType;
  /** 掌握状态（六级，来自 Learn Anything mastery-rubric） */
  masteryStatus?: MasteryStatus;
  /** 历史最高掌握状态（降级时保留，不删除历史证据） */
  historicalHighest?: MasteryStatus;
  /** 最近一次完成任务使用的提示等级 0-5 */
  hintLevel?: number;
}

/** 验收条目：讲解测试 / 变体测试 / 口述 / 短文 / 实战（来自学习方法论） */
export interface AcceptanceItem {
  id: string;
  kind: "explain" | "apply" | "oral" | "essay" | "build";
  question: string;
  hint?: string;
}

export interface ExampleProject {
  title: string;
  description: string;
  code?: string;
}

/* ========= 掌握状态机（Learn Anything 六级） ========= */
export type MasteryStatus =
  | "unknown"    // 没有可靠证据
  | "exposed"    // 看过/听过，能识别但不能稳定提取
  | "guided"     // 在提示/脚手架帮助下能完成
  | "independent" // 无关键提示独立完成
  | "transferable" // 变化后的新情境中仍能完成
  | "durable";   // 延迟后仍能调用

export const MASTERY_ORDER: MasteryStatus[] = [
  "unknown", "exposed", "guided", "independent", "transferable", "durable",
];

export const MASTERY_LABELS: Record<MasteryStatus, string> = {
  unknown: "未测",
  exposed: "接触过",
  guided: "需要提示",
  independent: "能独立完成",
  transferable: "能迁移应用",
  durable: "长期保持",
};

/* ========= 知识类型（Learn Anything 领域路由） ========= */
export type KnowledgeType =
  | "fact"          // 事实/术语/定义
  | "concept"       // 概念/原理/因果关系
  | "procedure"     // 解题/编程/操作流程
  | "discrimination" // 类别与方法辨别
  | "judgment"      // 判断/策略/权衡
  | "creative";     // 写作/设计/开放创作

export const KNOWLEDGE_TYPE_LABELS: Record<KnowledgeType, string> = {
  fact: "事实记忆",
  concept: "概念理解",
  procedure: "操作技能",
  discrimination: "辨别分类",
  judgment: "判断权衡",
  creative: "创作产出",
};

/* ========= 提示阶梯（Learn Anything feedback-strategies） ========= */
export interface HintLevel {
  level: 0 | 1 | 2 | 3 | 4 | 5;
  /** L0 自检 / L1 位置 / L2 原则 / L3 结构 / L4 示范关键步 / L5 完整示范 */
  label: string;
  prompt: string;
}

export const HINT_LADDER: HintLevel[] = [
  { level: 0, label: "自检", prompt: "先检查一下题目真正问的对象，以及你的最后一步是否和它一致。" },
  { level: 1, label: "错误位置", prompt: "问题出在…（指出具体位置），前面的方向是对的。" },
  { level: 2, label: "原则提醒", prompt: "这里要用的是…（提醒相关规则或判据）。" },
  { level: 3, label: "部分结构", prompt: "先把问题拆成两个部分：第一部分处理…，第二部分处理…。" },
  { level: 4, label: "示范关键步", prompt: "第一步可以写成…。接下来请你只处理…。" },
  { level: 5, label: "完整示范", prompt: "展示完整答案，同时要求学习者标出偏离点并完成一道小变式。" },
];

/* ========= 判分结果（Learn Anything 四级，替代 pass/fail 二元） ========= */
export type GradingResult = "correct" | "partially_correct" | "incorrect" | "ungradable";

export type NodeStatus = "locked" | "active" | "passed" | "skipped";

export interface DayPlan {
  id: string;
  phaseId: string;
  title: string;
  /** 目录占位（true=只有标题与清单级知识点，资源/方法/验收还没展开）。
   *  阶段开始时全目录一次生成，用户学到哪天再展开哪天。旧数据无此字段=已展开。 */
  stub?: boolean;
  knowledgePoints: KnowledgePoint[];
  resources: Resource[];
  method: string; // 本日教学策略（随领域变化）
  example?: ExampleProject; // coding 领域：包含知识点的完整项目例子
  acceptance: AcceptanceItem[];
  status: NodeStatus;
  completedAt?: string;
  attempts: number; // 验收尝试次数
  lesson?: string; // 已生成的每日学习文档（缓存）
  qa?: ChatMsg[]; // 本日答疑对话（学习中随问随答）
  /** 迁移题真门（v17）：验收已判过但迁移题未答——本日已记录，下一天暂不解锁。
   *  旧数据无此字段 = 不受门控（历史已完成的天不会被新规则反锁）。 */
  pendingUnlock?: boolean;
  transferQuestion?: string; // 迁移题原文（刷新/换设备后仍能作答）
  transferAnswer?: string; // 迁移题作答（过门时落档）
}

/** 阶段天目录条目：阶段一开始就把全部学习日排出来（标题+清单级知识点），
 *  详情（资源/方法/示例/验收）在学到那天之前按需展开。 */
export interface DayOutline {
  id: string;
  title: string;
  knowledgePoints: string[];
}

export interface Phase {
  id: string;
  title: string;
  outcome: string; // 本阶段结束时你能做什么（目标能力）
  dayIds: string[]; // 已展开为 DayPlan 的天（与 catalog 同 id、同顺序）
  status: NodeStatus;
  outline?: string[]; // 总计划：本阶段要学什么的详尽清单
  boundary?: string; // 总计划：范围与不学说明
  estDays?: number; // 总计划：预估天数（灵活）
  planned?: boolean; // 全部天是否都已展开细节（catalog 存在但仍有 stub 时为 false）
  /** 全阶段天目录：目录一生成就完整可见，不依赖当天细节是否展开 */
  catalog?: DayOutline[];
}

export interface Plan {
  summary: string; // 整体路径与理由
  totalDays: number;
  weeklyHours: number;
  startDate: string;
  phases: Phase[];
  days: Record<string, DayPlan>;
  createdAt: string;
}

/* ========= 验收结果 ========= */
export interface QuizItemResult {
  itemId: string;
  question: string;
  userAnswer: string;
  verdict: GradingResult;
  feedback: string;
  hintLevel?: number;
}

export interface QuizResult {
  dayId: string;
  date: string;
  passed: boolean;
  forced: boolean; // 强制跳过
  items: QuizItemResult[];
}

/* ========= 学习目标 ========= */
export interface SocraticTurn {
  role: "assistant" | "user";
  content: string;
}

/** 阶段重排历史（V26.2-H5，PRD §6.4 版本留痕）：每次重排前快照该阶段旧目录 */
export interface PlanHistoryEntry {
  at: string; // ISO
  reason: string; // 用户的不满点/重排原因
  phaseId: string;
  phaseTitle: string;
  boundary: string;
  dayIds: string[];
  /** 旧目录的天的深拷贝（含当时的状态与内容；重排不删除任何旧数据） */
  days: DayPlan[];
}

export interface Goal {
  id: string;
  topic: string; // "Python"
  direction: string; // 苏格拉底引导后明确的方向（草稿期为空）
  domainKind: DomainKind;
  motivation: string;
  background: string;
  deadline?: string;
  weeklyHours: number;
  successCriteria: string[];
  assumptions?: string[]; // 教练替用户做的假设（无截止日期承诺）
  learnerProfile?: string[]; // 学习者画像：时段/风格/约束/性格/材料偏好
  status: "draft" | "active" | "paused" | "done"; // draft=引导中，可中断可回档
  createdAt: string;
  plan?: Plan;
  /** 阶段重排历史（V26.2-H5）：最多保留最近 5 次，只增不删 */
  planHistory?: PlanHistoryEntry[];
  quizLog: QuizResult[];
  intakeTranscript: SocraticTurn[];
  /** 结业回路（v21）：最后一个阶段过门后置 true，UI 生成结业笔记与下一步建议后清掉 */
  needsGraduation?: boolean;
  /** 结业完成时间（ISO）。有值表示结业笔记已生成，不再重复触发 */
  graduatedAt?: string;
  /** 结业笔记的知识条目 id（第二大脑里可点开） */
  graduationNoteId?: string;
  /** 下一步建议：模型基于已掌握知识点产出，仅建议、不自动创建目标 */
  nextSteps?: string[];
}

/* ========= 第二大脑（Obsidian 式双链笔记） ========= */
export type KnowledgeSource = "learn" | "read" | "council" | "manual" | "obsidian";

export interface KnowledgeItem {
  id: string;
  title: string; // 笔记标题（wikilink 目标）
  body: string; // Markdown 正文，可含 [[标题]] 双链
  domain: string;
  source: KnowledgeSource;
  sourceTitle: string; // 来自哪个目标 / 哪本书
  /** 知识类型（Learn Anything 路由）：验收入库时记录，驱动后续复习/讲解策略 */
  knowledgeType?: KnowledgeType;
  /** 掌握状态（六级）：验收入库时按本次判分证据记录 */
  masteryStatus?: MasteryStatus;
  masteredAt: string;
  reviewStage: number; // 0=未开始复习，1..4=已过第n轮
  nextReviewAt?: string; // ISO date，由 FSRS 按个体表现排期（旧数据可能是 1/3/7/15 固定档）
  lastReviewOk?: boolean;
  links: string[]; // 出链：指向其他笔记的 id（用户/AI 建立）
  tags?: string[]; // 标签（frontmatter/正文 #标签/手动添加）— Obsidian 式
  version?: number; // 内容版本：同一知识点修订时递增；检索冲突时高版本优先（旧版不混入）
  updatedAt?: string; // 最近修订时间（ISO）；同版本时越新越优先
  unresolved?: boolean; // Obsidian 式「未解析链接」占位笔记：[[目标]] 尚无实体，图谱显示灰色虚影
  /** FSRS 自适应调度状态（ts-fsrs；缺省时按 reviewStage 兼容旧数据） */
  fsrs?: FsrsState;
}

export interface FsrsState {
  st: number; // State: 0=New 1=Learning 2=Review 3=Relearning
  dif: number; // difficulty 1-10
  stb: number; // stability（天数）
  elapsed: number;
  scheduled: number;
  reps: number;
  lapses: number;
  due: string; // ISO
  last: string | null; // ISO
}

/* ========= 读书伙伴 ========= */
export interface BookChapter {
  id: string;
  title: string;
  /** 本章主知识类型：决定对话模式（苏格拉底 vs 思维碰撞 vs 操作验证） */
  knowledgeType?: KnowledgeType;
  coreIdea?: string; // 本单元核心论点
  focusQuestion: string; // 本章带着什么问题读
  perspectives?: string[]; // 其他思想家/作者对该观点的看法（人名+一句话）
  capture?: string[]; // 值得随手记进第二大脑的笔记标题建议
  /** 节点状态机（PRD 4.3）：todo 未开始 / reading 阅读中 / done 已完成 / skipped 用户跳过 */
  status: "todo" | "reading" | "done" | "skipped";
  keyConcepts?: string[]; // 关键概念（PRD 4.3 节点必备字段）
  prerequisites?: string[]; // 前置知识（节点标题或概念名，UI 标注依赖）
  expectedOutcome?: string; // 预期学习成果
  assessFocus?: string; // 验收要求（生成验收题时的锚点）
  /** 通过验收的时间。与 status="done" 区分：done 可来自手动"标记已读完"，masteredAt 只能来自验收通过 */
  masteredAt?: string;
  /** 三重验收结果（通俗举例/知识迁移/贴合度，源自 CogniRead 的设计；v25 起新验收写 book.assessments，此字段仅旧数据兼容） */
  verification?: {
    scores: { example: number; transfer: number; similarity: number };
    total: number;
    level: "understood" | "partial" | "not";
    suggestion: string;
    at: string;
  };
}

/* ========= 阅读系统 V1.0（Reading System，PRD 2026-11-05）========= */

/** 四种阅读成果（PRD 4.1）：理解/思考/应用/沉淀。四类可组合，设一个主要目标。 */
export type ReadingGoalType = "understand" | "think" | "apply" | "retain";

export const READING_GOAL_LABELS: Record<ReadingGoalType, { label: string; desc: string }> = {
  understand: { label: "理解", desc: "真正读懂：能用自己的话独立解释" },
  think: { label: "思考", desc: "建立自己的观点：分析、批判、判断" },
  apply: { label: "应用", desc: "把知识用到现实：情境迁移、解决问题" },
  retain: { label: "沉淀", desc: "建立知识体系：关联、积累、长期记忆" },
};

export interface ReadingGoal {
  primary: ReadingGoalType;
  secondary: ReadingGoalType[];
  /** 用户一句话说明为什么读这本书（可选） */
  intent?: string;
  /** 用户当前基础/已有知识（升级 PRD 2.1：影响路线深度与教学策略，零基础≠有基础） */
  background?: string;
  /** true = 用户未显式选择，由 AI/默认规则推断（用户随时可改） */
  inferred?: boolean;
  setAt: string;
}

/** 书籍认知地图（PRD 4.2）：四大核心区域。AI 生成，重要观点须回原文核对。 */
export interface BookMap {
  coreProblem: string; // 这本书在解决什么问题（问题背景 + 作者想解决的困境）
  authorStance: string; // 作者核心主张（观点 + 主要论证 + 结论）
  lineage: string; // 思想谱系（继承谁 / 回应谁 / 被谁继承）
  controversies: string; // 争议与局限（学术争议 + 适用边界 + 尚未解决的问题）
  generatedAt: string;
}

/** 三重验收维度（PRD 4.5）：理解 Explain / 结构 Connect / 迁移 Apply */
export type AssessKind = "explain" | "connect" | "apply";

export const ASSESS_KIND_LABELS: Record<AssessKind, string> = {
  explain: "理解验收",
  connect: "结构验收",
  apply: "迁移验收",
};

/** 单题验收记录（PRD：评分必须附带具体表现证据，判而不解释=无效判）。
 *  level 四级口径（升级 PRD 3.5）：mastered/partial/not + ungradable——
 *  问题歧义或回答离题到无法判定时判 ungradable，不许当 partial 放水。 */
export interface ChapterAssessment {
  id: string;
  chapterId: string;
  kind: AssessKind;
  question: string;
  answer: string;
  level: "mastered" | "partial" | "not" | "ungradable";
  evidence: string; // 判分依据：引用用户原话 / 指出具体缺什么
  feedback: string; // 具体优点与不足
  suggestion?: string; // 未过时的针对性补充教学建议
  at: string;
}

/** 知识迁移记录（升级 PRD 2.5）：区分「会用」与「只会说」。
 *  任务由 AI 按 reading goal 生成（真实场景，非选择题）；verdict 三级。 */
export interface BookTransfer {
  id: string;
  chapterIds: string[]; // 本次迁移涉及的知识节点
  task: string; // 迁移任务描述（用户真实场景）
  answer: string; // 用户的独立作答/行动方案
  verdict: "used_correct" | "used_wrong" | "naming_only";
  evidence: string; // 判定依据：引用用户原话，指出用对/用错哪一步
  feedback: string;
  /** v26.1 G3：作答模式与过程（独立/辅助、是否用提示、是否修改过答案） */
  mode?: "independent" | "assisted";
  hintUsed?: boolean;
  answerRevised?: boolean;
  /** 独立迁移检验：同概念、不同场景、不同表述的换述题（第三层评估） */
  recheck?: {
    task: string;
    answer: string;
    verdict: "independent_success" | "assisted_success" | "partial_success" | "incorrect" | "incomplete" | "ungradable";
    evidence: string;
    at: string;
  };
  at: string;
}

/** 迁移结果六分类（v26.1 G3）：由 verdict+mode+recheck 聚合，独立与辅助分列统计 */
export type TransferOutcome =
  | "independent_success"
  | "assisted_success"
  | "partial_success"
  | "incorrect"
  | "incomplete"
  | "ungradable";

export const TRANSFER_OUTCOME_LABELS: Record<TransferOutcome, string> = {
  independent_success: "独立迁移成功",
  assisted_success: "辅助后成功",
  partial_success: "部分完成",
  incorrect: "错误应用",
  incomplete: "未完成",
  ungradable: "无法判定",
};

/** 聚合规则（唯一真源，store/后台/统计共用）：
 *  独立复检通过（independent_success）只可能来自 mode=independent 的复检通过——
 *  assisted 模式下即使复检通过也只能计 assisted_success（v26.1 G3 硬禁令）。 */
export function transferOutcome(t: BookTransfer): TransferOutcome {
  if (!t.answer.trim()) return "incomplete";
  const rechecked = t.recheck && t.recheck.answer.trim();
  if (rechecked) {
    const rc = t.recheck!.verdict;
    if (rc === "independent_success") return t.mode === "assisted" ? "assisted_success" : "independent_success";
    if (rc === "assisted_success") return "assisted_success";
    if (rc === "partial_success") return "partial_success";
    if (rc === "incorrect") return "incorrect";
    if (rc === "incomplete") return "partial_success";
    return "ungradable";
  }
  if (t.verdict === "used_correct") return t.mode === "assisted" || t.hintUsed ? "assisted_success" : "partial_success"; // 未过独立复检的 used_correct 只算部分完成
  if (t.verdict === "used_wrong") return "incorrect";
  return t.mode === "assisted" ? "assisted_success" : "partial_success";
}

export const TRANSFER_VERDICT_LABELS: Record<BookTransfer["verdict"], string> = {
  used_correct: "正确应用",
  used_wrong: "应用有误",
  naming_only: "只会复述",
};

/** 节点级沉淀（PRD 4.6）：优先保留用户自己的话，AI 反馈只作辅助 */
export type DepositType =
  | "explanation" // 我自己的解释
  | "point" // 核心知识点
  | "question" // 重要问题
  | "view" // 个人观点
  | "practice" // 实践案例
  | "unresolved" // 未解决的问题
  | "aiFeedback"; // AI 反馈

export const DEPOSIT_TYPE_LABELS: Record<DepositType, string> = {
  explanation: "我的解释",
  point: "核心点",
  question: "问题",
  view: "我的观点",
  practice: "实践案例",
  unresolved: "待解决",
  aiFeedback: "AI 反馈",
};

export interface BookDeposit {
  id: string;
  chapterId?: string; // 不带 = 整本书级沉淀
  type: DepositType;
  text: string;
  at: string;
}

/** 学习状态追踪（PRD 5.3 learningState）：记录证据，不给用户贴标签。
 *  misconceptions 带 clarified 语义（升级 PRD 2.4）：识别→澄清 两态，重考通过即澄清。 */
export interface BookLearning {
  knownConcepts: string[];
  misconceptions: { concept: string; note: string; at: string; clarified?: boolean }[];
  unresolvedQuestions: string[];
  evidence: { chapterId?: string; text: string; at: string }[];
}

/** 整本书的阅读状态（PRD 4.5）：未开始/阅读中/已读完/验收中/已掌握。已读完 ≠ 已掌握。 */
export type BookReadStatus = "unread" | "reading" | "finished" | "assessing" | "mastered";

export interface BookInsight {
  id: string;
  text: string;
  addedAt: string;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  /** 智能体消息的过程产物（v2）：计划/工具调用/引用来源，刷新后仍可见 */
  meta?: MsgMeta;
}

/** 智能体过程产物（随消息持久化；结构轻量，只存展示所需字段） */
export interface MsgMeta {
  plan?: { id: string; text: string; status: "pending" | "in_progress" | "completed" | "skipped" }[];
  tools?: { id: string; name: string; status: string; summary?: string; durationMs?: number }[];
  citations?: { title: string; url: string }[];
}

/** 主对话框会话（v23.2 多会话）：标题=首问截断；本地记忆，不参与云同步 */
export interface AgentSession {
  id: string;
  title: string;
  messages: ChatMsg[];
  createdAt: string;
  updatedAt: string;
}

export interface BookProfile {
  positioning: string;
  author: string;
  lineage: string;
  controversies: string;
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  profile?: BookProfile; // 深度解剖档案（v25 前的旧地图，保留兼容；新书用 map）
  map?: BookMap; // 书籍认知地图（PRD 4.2 四区域）
  pastedText?: string; // 用户粘贴的原文/笔记
  status: "want" | "reading" | "done";
  /** 阅读系统状态机（PRD 4.5）：undefined 时按 status 推导（want→unread / reading→reading / done→finished） */
  readStatus?: BookReadStatus;
  finishedAt?: string;
  masteredAt?: string;
  /** 阅读目标（PRD 4.1）：主目标 + 次目标组合 */
  goal?: ReadingGoal;
  /** 路线类型（PRD 4.3）：full 完整 / core 核心 / goal 目标导向。undefined = full */
  routeType?: "full" | "core" | "goal";
  /** 节点验收档案（PRD 4.5）：book 级存储，换路线/重规划不丢历史 */
  assessments?: ChapterAssessment[];
  /** 知识迁移记录（升级 PRD 2.5）：按目标生成的真实场景应用任务与判定 */
  transfers?: BookTransfer[];
  /** 节点沉淀（PRD 4.6） */
  deposits?: BookDeposit[];
  /** 学习状态（PRD 5.3） */
  learning?: BookLearning;
  /** AI 推荐的教学策略（PRD 4.4 调度）：进入节点时更新一次；带 chapterId 防跨节点串显 */
  recommendedMode?: { mode: string; reason: string; chapterId: string; at: string };
  /** 读书对话模式（五模式引擎;socratic/feynman/collision/close-read/recall-check） */
  chatMode?: string;
  /** 刚切换过模式：下一次发送时置位传给服务端（让模型执行该模式的开场协议），发送后清除 */
  modeJustSwitched?: boolean;
  /** 书籍真实性核查状态（V26.2-H2，PRD §5）：verified=搜索核实；user_material=基于用户粘贴材料；
   *  unverified=未经核实（历史遗留/绕过路径创建）。undefined=V26.2 之前的旧数据，不展示标记 */
  verification?: "verified" | "user_material" | "unverified";
  planSummary?: string;
  chapters: BookChapter[];
  insights: BookInsight[];
  chat: ChatMsg[];
  createdAt: string;
}

/* ========= 人生伙伴 ========= */
export interface CouncilSession {
  id: string;
  personaId: string; // 内置 persona id / "roundtable" / "custom:xxx"
  participants?: string[]; // 圆桌与会者（personaId 列表，含 custom）
  title: string;
  messages: ChatMsg[];
  createdAt: string;
}

/** 用户自定义智能体（输入名字，AI 蒸馏其思想而成） */
export interface CustomPersona {
  id: string; // "custom:xxx"
  name: string;
  tag: string;
  bio: string;
  color: string;
  identityNote: string; // AI 确认的身份（是谁、哪个时代/领域，供用户核对）
  system: string; // 蒸馏后的完整系统提示词
  createdAt: string;
}

/* ========= 设置 ========= */
export type ProviderId =
  | "demo"
  | "zai"
  | "deepseek"
  | "moonshot"
  | "openai"
  | "maas"
  | "custom";

export interface Settings {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string; // custom 时使用
  userName: string;
  /** 教练严厉度（Learn Anything 反馈策略）：standard=不放水不吹毛求疵；gentle=先具体肯定再指缺口，判分标准不变 */
  coachTone?: "standard" | "gentle";
  /** 每周复习召回邮件（opt-in）：周一上午发送到期复习与上周完成情况；随数据快照加密同步 */
  digestWeekly?: boolean;
}
