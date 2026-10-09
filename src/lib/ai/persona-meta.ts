/* ============================================================
 * 席位展示元数据（客户端安全）
 * - 这里只有圆桌 UI 渲染需要的公开信息：id/名字/标签/简介/配色。
 * - 完整的 system 提示词（核心配方）只存在于 prompts.ts（server-only），
 *   客户端一律按 personaId 由服务端解析，防止 JS 包/抓包拿走。
 * - 与 prompts.ts 的元数据一致性由 src/lib/__tests__/seats.test.ts 守护。
 * ============================================================ */

export interface SeatMeta {
  id: string;
  name: string;
  tag: string;
  bio: string;
  color: string; // tailwind gradient class
}

export const PERSONA_SEATS: SeatMeta[] = [
  {
    id: "naval",
    name: "Naval Ravikant",
    tag: "财富 · 自由哲学",
    bio: "AngelList 创始人，把财富与幸福写成公理的人",
    color: "from-amber-500 to-orange-600",
  },
  {
    id: "jobs",
    name: "Steve Jobs",
    tag: "产品 · 聚焦",
    bio: "聚焦=对一百个好主意说 No",
    color: "from-zinc-600 to-zinc-800",
  },
  {
    id: "munger",
    name: "Charlie Munger",
    tag: "投资 · 理性",
    bio: "多元思维模型 + 逆向思考",
    color: "from-sky-700 to-indigo-800",
  },
  {
    id: "feynman",
    name: "Richard Feynman",
    tag: "物理 · 科学诚实",
    bio: "反自欺第一原则",
    color: "from-emerald-500 to-teal-600",
  },
  {
    id: "taleb",
    name: "Nassim Taleb",
    tag: "风险 · 反脆弱",
    bio: "先看下行代价，再看期望值",
    color: "from-stone-700 to-neutral-900",
  },
  {
    id: "graham",
    name: "Paul Graham",
    tag: "创业 · 写作思考",
    bio: "Writing is thinking",
    color: "from-rose-500 to-red-600",
  },
  {
    id: "karpathy",
    name: "Andrej Karpathy",
    tag: "AI 工程 · 教育",
    bio: "构建即理解，demo ≠ 部署",
    color: "from-violet-600 to-purple-700",
  },
  {
    id: "musk",
    name: "Elon Musk",
    tag: "工程 · 第一性原理",
    bio: "物理定律是唯一硬约束",
    color: "from-blue-600 to-cyan-600",
  },
  {
    id: "zhangxuefeng",
    name: "张雪峰",
    tag: "教育 · 职业规划",
    bio: "选择大于努力，就业倒推",
    color: "from-red-500 to-orange-500",
  },
  {
    id: "zhangyiming",
    name: "张一鸣",
    tag: "产品 · 延迟满足",
    bio: "平庸有重力，需要逃逸速度",
    color: "from-cyan-600 to-blue-700",
  },
  {
    id: "mrbeast",
    name: "MrBeast",
    tag: "增长 · 内容",
    bio: "成功 = CTR × AVD，其他都是噪音",
    color: "from-fuchsia-600 to-pink-600",
  },
  {
    id: "sutskever",
    name: "Ilya Sutskever",
    tag: "AI 研究 · 深度思考",
    bio: "压缩即理解",
    color: "from-indigo-500 to-blue-700",
  },
];

export const CONCEPT_SEATS: SeatMeta[] = [
  {
    id: "first-principles",
    name: "第一性原理",
    tag: "把问题拆到不可再拆的事实",
    bio: "亚里士多德提出、马斯克带火的思维工具：不靠类比,回到事物最基本的事实从头推演。",
    color: "from-slate-500 to-slate-700",
  },
  {
    id: "incentives",
    name: "激励相容",
    tag: "看懂每个人的行为由什么激励驱动",
    bio: "2007 年诺贝尔经济学奖（机制设计,Hurwicz/Maskin/Myerson）的核心：一个安排好不好,看它是否让参与者的自利行为恰好推进整体目标。",
    color: "from-amber-600 to-orange-700",
  },
  {
    id: "antifragile-filter",
    name: "反脆弱过滤",
    tag: "这个决定在波动里会更强还是更脆",
    bio: "塔勒布《反脆弱》的决策过滤器：偏好从波动中受益的选项,消除单点脆弱,用小代价试错替代豪赌。",
    color: "from-stone-600 to-stone-800",
  },
  {
    id: "attention-econ",
    name: "注意力经济学",
    tag: "你的时间被什么机制切走了",
    bio: "综合注意力残留（Sophie Leroy）、深度工作（Cal Newport）与心流（Csikszentmihalyi）研究的执行视角。",
    color: "from-emerald-600 to-teal-700",
  },
];

/** 全部席位 = 人物席 + 认知工具席 */
export const ALL_SEAT_METAS: SeatMeta[] = [...PERSONA_SEATS, ...CONCEPT_SEATS];

export const seatById = (id: string): SeatMeta | undefined =>
  ALL_SEAT_METAS.find((p) => p.id === id);
