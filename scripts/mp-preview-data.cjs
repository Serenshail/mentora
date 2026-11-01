/* 预览用的页面数据（结构与各页 data 一致，只为目检排版） */

const MD_BLOCKS = [
      {
            "t": "h",
            "nodes": [
                  {
                        "name": "span",
                        "attrs": {
                              "style": "font-weight:600;color:#000000;"
                        },
                        "children": [
                              {
                                    "type": "text",
                                    "text": "今天先搞清一件事"
                              }
                        ]
                  }
            ],
            "level": 2,
            "_i": 0
      },
      {
            "t": "p",
            "nodes": [
                  {
                        "name": "span",
                        "attrs": {
                              "style": ""
                        },
                        "children": [
                              {
                                    "type": "text",
                                    "text": "上下文窗口不是内存，它是模型这一次调用能看见的全部东西。你写进 "
                              }
                        ]
                  },
                  {
                        "name": "span",
                        "attrs": {
                              "style": "font-family:ui-monospace,Menlo,monospace;font-size:0.94em;background:#f2f2f7;border-radius:4px;padding:1px 4px;"
                        },
                        "children": [
                              {
                                    "type": "text",
                                    "text": "system"
                              }
                        ]
                  },
                  {
                        "name": "span",
                        "attrs": {
                              "style": ""
                        },
                        "children": [
                              {
                                    "type": "text",
                                    "text": " 的每一个字，都在花这次调用的钱。"
                              }
                        ]
                  }
            ],
            "_i": 1
      },
      {
            "t": "hr",
            "_i": 2
      },
      {
            "t": "h",
            "nodes": [
                  {
                        "name": "span",
                        "attrs": {
                              "style": "font-weight:600;color:#000000;"
                        },
                        "children": [
                              {
                                    "type": "text",
                                    "text": "关键概念"
                              }
                        ]
                  }
            ],
            "level": 3,
            "_i": 3
      },
      {
            "t": "list",
            "ordered": false,
            "items": [
                  {
                        "nodes": [
                              {
                                    "name": "span",
                                    "attrs": {
                                          "style": "font-weight:600;"
                                    },
                                    "children": [
                                          {
                                                "type": "text",
                                                "text": "窗口"
                                          }
                                    ]
                              },
                              {
                                    "name": "span",
                                    "attrs": {
                                          "style": ""
                                    },
                                    "children": [
                                          {
                                                "type": "text",
                                                "text": "：单次调用能塞进去的 token 上限"
                                          }
                                    ]
                              }
                        ],
                        "_i": 0
                  },
                  {
                        "nodes": [
                              {
                                    "name": "span",
                                    "attrs": {
                                          "style": "font-weight:600;"
                                    },
                                    "children": [
                                          {
                                                "type": "text",
                                                "text": "注意力预算"
                                          }
                                    ]
                              },
                              {
                                    "name": "span",
                                    "attrs": {
                                          "style": ""
                                    },
                                    "children": [
                                          {
                                                "type": "text",
                                                "text": "：窗口越长，中间部分越容易被忽略"
                                          }
                                    ]
                              }
                        ],
                        "_i": 1
                  }
            ],
            "_i": 4
      },
      {
            "t": "quote",
            "nodes": [
                  {
                        "name": "span",
                        "attrs": {
                              "style": "color:#3c3c4399;"
                        },
                        "children": [
                              {
                                    "type": "text",
                                    "text": "把最重要的指令放在开头或结尾，中间的会被稀释。"
                              }
                        ]
                  }
            ],
            "_i": 5
      },
      {
            "t": "code",
            "lang": "ts",
            "text": "const ctx = build({\n  system: rules,\n  notes: retrieve(q, 3),\n});",
            "_i": 6
      }
];

const mdBlocks = () => ({ blocks: MD_BLOCKS });

module.exports = {
  overview: () => ({
    loading: false,
    logged: true,
    name: "林一",
    sync: "已同步",
    streakDays: 6,
    dueCount: 4,
    goal: {
      id: "g1",
      topic: "把 Transformer 吃透",
      direction: "四周内能从零手写一个可训练的小型注意力模型，并讲清每个矩阵在干什么",
      progress: 38,
      phaseTitle: "阶段2 · 多头注意力",
      dayId: "d5",
      dayTitle: "Day 5：从单头到多头，为什么需要多组 QKV",
      gated: false,
    },
    counts: { goals: 1, notes: 23, books: 2 },
    goalCount: 1,
    // 12 列 × 7 天，level 随机但稳定（模拟真实热力墙）
    heatCols: Array.from({ length: 12 }, (_, c) =>
      Array.from({ length: 7 }, (_, r) => ({
        date: `d-${c}-${r}`,
        level: (c * 7 + r) % 11 === 0 ? 0 : ((c + r) % 4),
        future: c === 11 && r > 3,
      }))
    ),
  }),

  learn: () => ({
    loading: false,
    syncHint: "已同步",
    goals: [
      {
        id: "g1",
        topic: "把 Transformer 吃透",
        direction: "四周内能从零手写一个可训练的小型注意力模型，并讲清每个矩阵在干什么",
        progress: 38,
        passed: 5,
        total: 14,
        statusLabel: "进行中",
        statusTone: "accent",
        active: true,
      },
      {
        id: "g2",
        topic: "线性代数补课",
        direction: "把矩阵分解、特征值、SVD 的几何意义讲清楚",
        progress: 100,
        passed: 8,
        total: 8,
        statusLabel: "已完成",
        statusTone: "ok",
        active: false,
      },
    ],
  }),

  goal: () => ({
    goal: {
      id: "g1",
      topic: "把 Transformer 吃透",
      direction: "四周内能从零手写一个可训练的小型注意力模型，并讲清每个矩阵在干什么",
      summary: "先建立直觉，再从单头推到多头，最后实现一个小模型并做消融实验。",
      status: "active",
      graduated: false,
    },
    phases: [
      {
        id: "p1",
        title: "阶段1 · 注意力直觉",
        outcome: "能用手算一个 3×3 的注意力输出",
        statusLabel: "已通过",
        tone: "ok",
        open: false,
        days: [],
      },
      {
        id: "p2",
        title: "阶段2 · 多头注意力",
        outcome: "能解释多头的分工，并写出可训练实现",
        statusLabel: "进行中",
        tone: "accent",
        open: true,
        days: [
          { id: "d4", title: "Day 4：缩放点积的 1/√d 到底在干啥", status: "passed", tone: "ok", stub: false, gated: false, index: 1 },
          { id: "d5", title: "Day 5：从单头到多头，为什么需要多组 QKV", status: "active", tone: "accent", stub: false, gated: false, index: 2 },
          { id: "d6", title: "Day 6：位置编码的三种做法与取舍", status: "locked", tone: "dim", stub: true, gated: false, index: 3 },
        ],
      },
    ],
  }),

  day: () => ({
    goalId: "g1",
    dayId: "d5",
    goalTopic: "把 Transformer 吃透",
    readOnly: false,
    tab: "lesson",
    day: {
      title: "Day 5：从单头到多头，为什么需要多组 QKV",
      method: "先手推一遍单头，再拆成 4 组并行，最后对着论文图核对自己哪里想岔了",
      status: "active",
      attempts: 0,
      stub: false,
      pendingUnlock: false,
      kps: ["多头的信息分工", "QKV 三组投影的作用", "head 之间的独立性", "拼接与输出投影"],
    },
    lessonBlocks: mdBlocks().blocks,
    lessonBusy: false,
    lessonFull: "",
    lessonThink: "",
    links: [{ text: "Attention Is All You Need", url: "https://arxiv.org/abs/1706.03762" }],
    resources: [
      { _i: 0, title: "Attention Is All You Need（原论文）", url: "https://arxiv.org/abs/1706.03762", why: "第 3.2.2 节讲多头，必读原文", kindLabel: "论文" },
      { _i: 1, title: "The Annotated Transformer", url: "https://nlp.seas.harvard.edu/annotated-transformer/", why: "带代码逐行对照，跑一遍就懂", kindLabel: "教程" },
    ],
    qaView: [],
    qaInput: "",
    qaBusy: false,
    qaStreamBlocks: [],
    quizMode: "learn",
    acceptance: [
      { id: "a1", kind: "explain", kindLabel: "讲解", question: "为什么单个注意力头不够用？用一句话说清多头的必要性。", hint: "" },
      { id: "a2", kind: "apply", kindLabel: "实操", question: "写出多头注意力的 forward，并说明 8 个头是怎么并行的。", hint: "" },
    ],
    answers: {},
    canSubmitQuiz: false,
    grading: false,
    grade: null,
    gateQuestion: "",
    gateAnswer: "",
    skipText: "",
  }),

  brain: () => ({
    loading: false,
    total: 23,
    linkCount: 41,
    dueCount: 4,
    query: "",
    folders: ["Transformer", "线性代数", "读书笔记", "未解析链接"],
    activeFolder: "",
    notes: [
      { id: "k1", title: "缩放的 1/√d 是为了压住方差", domain: "Transformer/笔记", excerpt: "点积的方差随维度线性增长，除根号 d 之后方差回到 1，softmax 才不会饱和。", due: true, unresolved: false },
      { id: "k2", title: "多头不是集成，是子空间分工", domain: "Transformer/笔记", excerpt: "不同头学到的注意力模式确实不同，但它们在同一层共享输入，更像分工而不是投票。", due: false, unresolved: false },
      { id: "k3", title: "位置编码：正弦 vs 可学习", domain: "Transformer/笔记", excerpt: "正弦编码能外推到更长序列，可学习编码在训练长度内通常更好，取舍看任务。", due: false, unresolved: false },
      { id: "k4", title: "SVD 的几何意义", domain: "线性代数/笔记", excerpt: "任何矩阵都可以分解成旋转、缩放、旋转三步。", due: true, unresolved: false },
    ],
  }),

  note: () => ({
    note: {
      id: "k1",
      title: "缩放的 1/√d 是为了压住方差",
      domain: "Transformer/笔记",
      tags: ["attention", "数学"],
      nextReviewAt: "2026-11-02",
      body: "",
    },
    blocks: mdBlocks().blocks,
    links: [],
    masteryLabel: "能独立完成",
    outLinks: [
      { id: "k2", title: "多头不是集成，是子空间分工" },
      { id: "k3", title: "位置编码：正弦 vs 可学习" },
    ],
    backLinks: [{ id: "k4", title: "SVD 的几何意义" }],
  }),

  review: () => ({
    phase: "idle",
    queueCount: 4,
    total: 4,
    correct: 0,
    noteTitle: "",
    noteDomain: "",
    noteExcerpt: "",
    question: "",
    questionBusy: false,
    answer: "",
    gradeBusy: false,
    verdict: null,
    minutes: 0,
    nextDate: "",
  }),

  read: () => ({
    loading: false,
    adding: false,
    title: "",
    author: "",
    pasted: "",
    creating: false,
    books: [
      { id: "b1", title: "思考，快与慢", author: "丹尼尔·卡尼曼", status: "reading", statusLabel: "在读", progress: 40, chapters: "5/12 章" },
      { id: "b2", title: "反脆弱", author: "纳西姆·塔勒布", status: "reading", statusLabel: "在读", progress: 0, chapters: "0/9 章" },
    ],
  }),

  book: () => ({
    book: { id: "b1", title: "思考，快与慢", author: "丹尼尔·卡尼曼", planSummary: "", modeJustSwitched: false },
    chapter: {
      id: "c2",
      title: "第 2 章 · 注意力与努力",
      focusQuestion: "为什么专心做一件事会让人疲惫，而走神不会？",
      coreIdea: "认知努力是一种有限资源，系统 2 的运作需要刻意分配注意力。",
      knowledgeType: "concept",
      status: "todo",
    },
    mode: { id: "socratic", label: "苏格拉底", hint: "只提问不讲解：定义→依据→反例→边界，追到你自己讲通" },
    modes: [
      { id: "socratic", label: "苏格拉底", hint: "只提问不讲解：定义→依据→反例→边界" },
      { id: "feynman", label: "费曼讲桌", hint: "你讲，它当聪明外行只听" },
      { id: "collision", label: "思想碰撞", hint: "站对立面逼你辩护" },
      { id: "close-read", label: "精读带读", hint: "一次一段：主张→论证→理解性问题" },
      { id: "recall-check", label: "复盘检验", hint: "先合书回忆再迁移" },
    ],
    chatView: [
      { role: "assistant", blocks: mdBlocks().blocks },
      { role: "user", content: "我理解是：系统 2 需要调用注意力，所以累。" },
    ],
    input: "",
    busy: false,
    streamBlocks: [],
    showModes: false,
    showChapters: false,
    chapters: [
      { id: "c1", title: "第 1 章 · 两张系统", status: "done", index: 1 },
      { id: "c2", title: "第 2 章 · 注意力与努力", status: "todo", index: 2 },
    ],
  }),

  council: () => ({
    view: "pick",
    sessions: [
      { id: "s1", title: "要不要放弃读博去做产品 · 3人 · 11/1", count: 8, when: "11/01", roundtable: true },
      { id: "s2", title: "Naval Ravikant", count: 14, when: "10/30", roundtable: false },
    ],
    pickMode: "roundtable",
    allSeats: [
      { id: "naval", name: "Naval Ravikant", tag: "财富 · 自由哲学", concept: false, hasPhoto: true },
      { id: "jobs", name: "Steve Jobs", tag: "产品 · 聚焦", concept: false, hasPhoto: true },
      { id: "munger", name: "Charlie Munger", tag: "投资 · 理性", concept: false, hasPhoto: true },
      { id: "feynman", name: "Richard Feynman", tag: "物理 · 科学诚实", concept: false, hasPhoto: true },
      { id: "taleb", name: "Nassim Taleb", tag: "风险 · 反脆弱", concept: false, hasPhoto: true },
      { id: "graham", name: "Paul Graham", tag: "创业 · 写作思考", concept: false, hasPhoto: true },
      { id: "karpathy", name: "Andrej Karpathy", tag: "AI 工程 · 教育", concept: false, hasPhoto: true },
      { id: "musk", name: "Elon Musk", tag: "工程 · 第一性原理", concept: false, hasPhoto: true },
      { id: "first-principles", name: "第一性原理", tag: "把问题拆到不可再拆的事实", concept: true, hasPhoto: false },
      { id: "incentives", name: "激励相容", tag: "看懂每个人由什么激励驱动", concept: true, hasPhoto: false },
    ],
    picked: { naval: true, jobs: true, taleb: true },
    pickedCount: 3,
    session: null,
    chatView: [],
    input: "",
    busy: false,
    streamBlocks: [],
    rtSeats: [],
    rtPhase: "",
    rtHostBlocks: [],
  }),

  login: () => ({
    mode: "login",
    email: "",
    password: "",
    name: "",
    inviteCode: "",
    busy: false,
    error: "",
  }),

  profile: () => ({
    user: { name: "林一", email: "linyi@example.com" },
    sync: "已同步",
    counts: { goals: 1, notes: 23, books: 2, sessions: 6 },
    baseId: "prod",
    baseLabel: "官方部署（Vercel）",
    switching: false,
    busy: false,
  }),
};
