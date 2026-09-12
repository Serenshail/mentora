/* Demo 模式：无 API Key 时的脚本化响应，保证全流程可体验、可验收。
 * 仅服务端使用。每个函数返回一段完整文本，由 route 切成流式增量。 */

type Msg = { role: "user" | "assistant"; content: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* chunked(text: string, size = 6, delay = 12) {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
    await sleep(delay);
  }
}

/* ---------- 苏格拉底引导（脚本化六问） ---------- */
const INTAKE_QUESTIONS = [
  (topic: string) => `（演示模式）好，我们开始。第一个问题：你学 ${topic} 是为了干什么？想用它做到什么具体的事？`,
  () => `明白了。那这个方向上，你现在的基础怎么样？已经会什么？之前在哪卡住过？`,
  () => `好。接下来是关键问题：你每周能稳定投入几个小时？别乐观，按最平常的一周算。`,
  () => `那你想在什么时候之前达到目标？给我一个日期。`,
  () => `如果三个月后有人说你「学会了」，你认为是因为你做出了什么、或者能回答什么问题？说说你的验收标准。`,
  () => `最后一个问题：你更偏向哪种学法——跟着一个完整项目边做边学，还是先把概念体系过一遍再动手？`,
];

export async function* demoIntake(messages: Msg[]) {
  const userTurns = messages.filter((m) => m.role === "user");
  const first = userTurns[0]?.content ?? "Python";
  const topicMatch = first.match(/(?:学|学习)\s*([^，。,.!？?]+)/);
  const topic = topicMatch?.[1]?.trim() || "Python";
  const qIndex = userTurns.length - 1;

  if (qIndex < INTAKE_QUESTIONS.length) {
    yield* chunked(INTAKE_QUESTIONS[qIndex](topic));
    return;
  }
  // 信息齐了 → 目标卡
  const hours = first.match(/(\d+)\s*小时/)?.[1] ?? "8";
  const card = {
    topic,
    direction: `能独立做出一个小的 ${topic} 实战项目并读懂相关开源代码`,
    domainKind: "coding",
    motivation: first.slice(0, 40),
    background: "零基础 / 有零散接触",
    deadline: null,
    weeklyHours: Number(hours) || 8,
    successCriteria: [
      `能独立完成一个 ${topic} 小项目`,
      "能读懂相关领域开源项目的核心代码",
      "能向别人讲清核心概念与取舍",
    ],
  };
  yield* chunked(
    `好，方向清楚了。我总结一下：学 ${topic}，目标是「${card.direction}」，每周 ${card.weeklyHours} 小时，用项目驱动的方式推进。\n\n<!--GOAL_READY-->\n\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\``
  );
}

/* ---------- 计划生成 ---------- */
export async function* demoPlan(system: string) {
  const topic = system.match(/"topic":\s*"([^"]+)"/)?.[1] ?? "Python";
  const hours = system.match(/"weeklyHours":\s*(\d+)/)?.[1] ?? "8";
  const plan = {
    summary: `（演示模式）围绕「${topic}」的项目驱动路线：先用两周建立最小核心，再进入实战项目，边做边补。节奏按每周 ${hours} 小时设计，宁可慢不可断。`,
    totalDays: 6,
    weeklyHours: Number(hours) || 8,
    phases: [
      {
        title: "阶段一：最小核心",
        outcome: `能用 ${topic} 写出一个小而完整的程序，并讲清每行为什么这么写`,
        days: [
          {
            title: "Day 1：核心数据结构",
            knowledgePoints: [
              "基础数据类型的选用场景",
              "容器的增删改查与推导式",
              "不可变与可变的区别",
            ],
            resources: [
              { title: "官方入门教程", url: "", why: "第一手资料，最准确" },
              { title: "交互式练习场", why: "边学边敲，即时反馈" },
            ],
            method: "通过一个完整示例程序讲解，先跑通再拆解每个知识点在其中的作用。",
            example: {
              title: "迷你任务清单",
              description: `一个用 ${topic} 写的命令行任务清单：增删改查任务、统计完成率。覆盖本日全部知识点。`,
              code: `tasks = []\n\ndef add(title):\n    tasks.append({"title": title, "done": False})\n\ndef finish(title):\n    for t in tasks:\n        if t["title"] == title:\n            t["done"] = True\n\ndef report():\n    done = sum(1 for t in tasks if t["done"])\n    print(f"完成 {done}/{len(tasks)}")\n\nadd("学基础")\nadd("写练习")\nfinish("学基础")\nreport()`,
            },
            acceptance: [
              { kind: "explain", question: "用你的话讲：什么时候用不可变容器，什么时候用可变容器？为什么？", hint: "考察选用场景的判断" },
              { kind: "apply", question: "变体题：现在要求任务不能重复添加，代码要怎么改？", hint: "考察容器的去重思路" },
            ],
          },
          {
            title: "Day 2：控制流与函数",
            knowledgePoints: ["条件分支的边界处理", "循环与提前退出", "函数的参数与返回值设计"],
            resources: [{ title: "官方教程·控制流", why: "对照官方讲法查漏" }],
            method: "把 Day 1 的例子重构成函数版，边重构边讲。",
            example: {
              title: "任务清单·函数版",
              description: "把 Day 1 的脚本重构成函数 + 主循环交互版。",
              code: `def report(tasks):\n    done = sum(1 for t in tasks if t["done"])\n    return f"完成 {done}/{len(tasks)}"\n\ndef main():\n    tasks = []\n    while True:\n        cmd = input("命令(add/finish/quit): ")\n        if cmd == "quit":\n            break\n        if cmd == "add":\n            tasks.append({"title": input("标题: "), "done": False})\n            print(report(tasks))\n\nmain()`,
            },
            acceptance: [
              { kind: "explain", question: "为什么主循环用 while True + break，而不是在循环条件里写所有判断？", hint: "考察边界处理" },
              { kind: "apply", question: "变体题：加一个『撤销最近一次完成』的命令，怎么设计？", hint: "考察状态管理" },
            ],
          },
        ],
      },
      {
        title: "阶段二：实战项目",
        outcome: `独立完成一个 ${topic} 小项目，能向别人讲清设计取舍`,
        days: [
          {
            title: "Day 3：项目起步",
            knowledgePoints: ["需求拆解", "最小可运行版本", "调试基本法"],
            resources: [{ title: "调试入门指南", why: "先学提问，再学解决" }],
            method: "从空文件开始搭项目骨架，演示从 0 到能跑的过程。",
            acceptance: [
              { kind: "build", question: "动手：搭出你自己的项目骨架并跑起来，贴出运行结果。", hint: "最小可运行" },
              { kind: "explain", question: "你的最小版本砍掉了哪些功能？为什么先砍它们？", hint: "范围控制意识" },
            ],
          },
          {
            title: "Day 4：核心功能与验收",
            knowledgePoints: ["核心逻辑实现", "用测试代替肉眼检查", "复盘与迭代"],
            resources: [{ title: "自动化测试入门", why: "写完就测，不再心虚" }],
            method: "完成核心功能后，现场给代码补测试，用测试驱动收尾。",
            acceptance: [
              { kind: "build", question: "完成项目核心功能，并附一张运行截图/输出。", hint: "能演示" },
              { kind: "oral", question: "3 分钟费曼讲解：你的项目解决什么问题？最大的设计取舍是什么？", hint: "讲给外行听" },
            ],
          },
        ],
      },
    ],
  };
  yield* chunked("```json\n" + JSON.stringify(plan, null, 2) + "\n```", 10, 6);
}

/* ---------- 每日教学文档 ---------- */
export async function* demoLesson() {
  yield* chunked(`## 今日掌握
- **核心数据结构**：程序=数据+操作，今天先把"数据怎么放"想清楚
- **容器的增删改查与推导式**：日常 80% 的代码都在干这个
- **不可变与可变**：决定了你什么时候能改、什么时候会翻车

## 讲解
看这个完整的例子（迷你任务清单）：

\`\`\`
tasks = []

def add(title):
    tasks.append({"title": title, "done": False})

def finish(title):
    for t in tasks:
        if t["title"] == title:
            t["done"] = True

def report():
    done = sum(1 for t in tasks if t["done"])
    print(f"完成 {done}/{len(tasks)}")
\`\`\`

**逐段拆**：
1. \`tasks = []\` —— 一个可变容器，整个程序的状态都挂在它上面。选它不选字符串列表，是因为每条任务是"标题+状态"两个信息，需要结构化的条目。
2. \`add\` —— 增。注意追加的是"字典"而非裸字符串，这就是数据建模：多一条信息（done），就多一个字段。
3. \`finish\` —— 改。遍历找到目标再改属性。注意这里没有 return，靠副作用工作——这是初学者最容易滥用的地方。
4. \`report\` —— 查。推导式一行统计，这是推导式的本职：**从容器到数字/容器的一步转换**。

## 常见的坑
- 在遍历容器的同时增删它的元素——大多数语言的经典翻车点，先收集再改。
- 把"打印"当成"返回"。report 里是 print，调用方拿不到值；要复用就改成 return。
- 可变对象当默认参数——它会跨调用共享，状态莫名串了就是它。

## 练习
1. 给任务清单加「按完成状态过滤」的函数，用推导式一行实现。
2. 把 report 改成返回字符串而不是打印，想想调用方因此能多做什么。`);
}

/* ---------- 验收评分（演示：通过） ---------- */
export async function* demoQuizGrade(system: string) {
  const ids = [...system.matchAll(/"itemId":\s*"([^"]+)"/g)].map((m) => m[1]);
  const items = ids.length
    ? ids
    : ["q1", "q2"];
  yield* chunked(
    "```json\n" +
      JSON.stringify({
        items: items.map((id) => ({
          itemId: id,
          verdict: "pass",
          feedback: "（演示）核心机制讲对了，细节表达可以再练。",
        })),
        overall: "pass",
        summary: "（演示）验收通过，知识点已经真正长在你脑子里。",
        reviewAdvice: "这些知识点已进入间隔复习队列（1/3/7/15 天），按提醒回来刷即可。",
      }) +
      "\n```"
  );
}

/* ---------- 人生伙伴（演示） ---------- */
export async function* demoCouncil(messages: Msg[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const snippet = lastUser.slice(0, 30);
  yield* chunked(`**我的判断：你这个担心本身问错了问题。**

你说「${snippet}……」，你真正的风险不是事情本身，而是**你在用焦虑代替决策**——担心了这么久，你为最坏情况做过任何一件具体准备吗？

**理由**：焦虑的强度和风险的大小几乎不相关，它只和你重复想它的次数相关。而反脆弱的做法不是预测，是让自己错得起：留出缓冲、留出退路，然后继续推进。

**最强的反方观点**：也有人会说，适度的危机感才能推动行动——如果你现在确实什么都没准备，那这份焦虑是信号，不是噪音。区分标准只有一个：它有没有转化成动作。

**下一步**：今晚花 20 分钟，把「最坏情况发生了我要怎么办」写成三行字。写不出来，说明你逃避的不是焦虑，是计算。

**你没问但应该问的问题**：这件事里，什么是你能控制的，什么不是——你上次为"能控制的部分"花时间，是什么时候？`);
}

/* ---------- 读书伙伴（演示） ---------- */
export async function* demoReadingPlan(system: string) {
  const title =
    system.match(/书名：《([^《》\n]+)》/)?.[1] ?? "这本书";
  yield* chunked(
    "```json\n" +
      JSON.stringify({
        planSummary: `（演示）《${title}》的核心是一场思维方式的迁移。路线：先抓全书主论点，再分主题深读，每章带一个问题读，读一章聊一章。`,
        chapters: [
          { title: "全书在回答什么问题", focusQuestion: "作者反对的那个主流观点是什么？你原本站在哪边？" },
          { title: "核心概念的第一性", focusQuestion: "这个概念在解释什么现象？找一个你自己的例子。" },
          { title: "关键论证链", focusQuestion: "从论点到结论，最弱的一环在哪？" },
          { title: "反方怎么说", focusQuestion: "最强的批评是什么？作者回应了吗？" },
          { title: "与你生活的碰撞", focusQuestion: "这本书会让你改变哪一个具体决定？" },
          { title: "合上书之后", focusQuestion: "用 3 分钟向朋友讲清这本书，你会怎么讲？" },
        ],
      }) +
      "\n```"
  );
}

export async function* demoReadingChat(messages: Msg[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  yield* chunked(`有意思，你抓到的这个点值得再往下挖一层。（演示模式）

你说「${lastUser.slice(0, 24)}……」——那我反问你两个问题：

1. 作者的这个说法，和你自己的哪段真实经历对得上？或者，推翻了它？
2. 如果你只能记住这本书的**一句话**并照做，会是哪句？为什么是它？`);
}

/* ---------- 复习（演示） ---------- */
export async function* demoReview(system: string) {
  const kp =
    system.match(/"title":\s*"([^"]{2,40})"/)?.[1] ?? "这个知识点";
  yield* chunked(
    `（演示）回忆检验：用 30 秒讲清「${kp}」——它是什么、在什么场景用它、最容易犯的错是什么。不要看笔记。`
  );
}

export async function* demoReviewGrade() {
  yield* chunked(
    "```json\n" +
      JSON.stringify({
        verdict: "pass",
        feedback: "（演示）核心机制说对了，记忆稳固，下轮复习顺延。",
      }) +
      "\n```"
  );
}

/* ---------- AI 建联（演示） ---------- */
export async function* demoAutolink() {
  yield* chunked(
    "```json\n" +
      JSON.stringify({
        links: [],
      }) +
      "\n```"
  );
}

/* ---------- 自定义智能体蒸馏（演示：给一个通用智者） ---------- */
export async function* demoPersona() {
  yield* chunked(
    "```json\n" +
      JSON.stringify({
        identityNote: "（演示模式）真实模型下会先确认这个人是谁并写出身份依据；当前为通用学者演示档案。",
        name: "自定义智者",
        tag: "通识 · 思想实验",
        bio: "一位由你命名的思想伙伴（演示档案，接真实模型后按其真实思想蒸馏）",
        coreIdeas: ["先给判断再给理由", "主动呈现最强反方", "把情绪翻译成问题"],
        signatureQuestions: ["这个判断在什么条件下是错的？", "你愿意为这个观点下注吗？"],
        style: "直接、具体、有立场",
        quotes: ["判断先于安慰。"],
        color: "violet",
        system:
          "你是 Mentora 人生伙伴中的一个自定义智能体（演示档案）。第一句必须是明确判断；挑战坏问题的框架；主动给出最强反方；诚实标注无知；不给情绪安慰，给可执行判断；每次回答附下一步动作与一个用户没问但应该问的问题。",
      }) +
      "\n```"
  );
}
