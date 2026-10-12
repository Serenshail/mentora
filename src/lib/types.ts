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

export interface Phase {
  id: string;
  title: string;
  outcome: string; // 本阶段结束时你能做什么（目标能力）
  dayIds: string[]; // 天级计划生成后才有值
  status: NodeStatus;
  outline?: string[]; // 总计划：本阶段要学什么的详尽清单
  boundary?: string; // 总计划：范围与不学说明
  estDays?: number; // 总计划：预估天数（灵活）
  planned?: boolean; // 天级计划是否已生成
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
  quizLog: QuizResult[];
  intakeTranscript: SocraticTurn[];
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
  nextReviewAt?: string; // ISO date，间隔重复 1/3/7/15
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
  status: "todo" | "done";
  /** 三重验收结果（通俗举例/知识迁移/贴合度，源自 CogniRead 的设计） */
  verification?: {
    scores: { example: number; transfer: number; similarity: number };
    total: number;
    level: "understood" | "partial" | "not";
    suggestion: string;
    at: string;
  };
}

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
  profile?: BookProfile; // 深度解剖档案
  pastedText?: string; // 用户粘贴的原文/笔记
  status: "want" | "reading" | "done";
  /** 读书对话模式（五模式引擎;socratic/feynman/collision/close-read/recall-check） */
  chatMode?: string;
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
  | "custom";

export interface Settings {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl: string; // custom 时使用
  userName: string;
  /** 教练严厉度（Learn Anything 反馈策略）：standard=不放水不吹毛求疵；gentle=先具体肯定再指缺口，判分标准不变 */
  coachTone?: "standard" | "gentle";
}
