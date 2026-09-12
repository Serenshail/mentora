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
}

export interface KnowledgePoint {
  id: string;
  text: string;
  detail?: string;
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
}

export interface Phase {
  id: string;
  title: string;
  outcome: string; // 本阶段结束时你能做什么
  dayIds: string[];
  status: NodeStatus;
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
  verdict: "pass" | "fail";
  feedback: string;
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
export type KnowledgeSource = "learn" | "read" | "council" | "manual";

export interface KnowledgeItem {
  id: string;
  title: string; // 笔记标题（wikilink 目标）
  body: string; // Markdown 正文，可含 [[标题]] 双链
  domain: string;
  source: KnowledgeSource;
  sourceTitle: string; // 来自哪个目标 / 哪本书
  masteredAt: string;
  reviewStage: number; // 0=未开始复习，1..4=已过第n轮
  nextReviewAt?: string; // ISO date，间隔重复 1/3/7/15
  lastReviewOk?: boolean;
  links: string[]; // 出链：指向其他笔记的 id（用户/AI 建立）
}

/* ========= 读书伙伴 ========= */
export interface BookChapter {
  id: string;
  title: string;
  coreIdea?: string; // 本单元核心论点
  focusQuestion: string; // 本章带着什么问题读
  perspectives?: string[]; // 其他思想家/作者对该观点的看法（人名+一句话）
  capture?: string[]; // 值得随手记进第二大脑的笔记标题建议
  status: "todo" | "done";
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
}
