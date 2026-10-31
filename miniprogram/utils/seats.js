/* ========= 席位元数据（与 Web 端 persona-meta.ts 同源移植） =========
 * 只含展示信息；完整人格 system 在服务端，小程序只发 personaId。 */
var SEATS = [
  { id: "naval", name: "Naval Ravikant", tag: "财富 · 自由哲学", bio: "AngelList 创始人，把财富与幸福写成公理的人", color: "#d97706" },
  { id: "jobs", name: "Steve Jobs", tag: "产品 · 聚焦", bio: "聚焦=对一百个好主意说 No", color: "#52525b" },
  { id: "munger", name: "Charlie Munger", tag: "投资 · 理性", bio: "多元思维模型 + 逆向思考", color: "#4338ca" },
  { id: "feynman", name: "Richard Feynman", tag: "物理 · 科学诚实", bio: "反自欺第一原则", color: "#0d9488" },
  { id: "taleb", name: "Nassim Taleb", tag: "风险 · 反脆弱", bio: "先看下行代价，再看期望值", color: "#57534e" },
  { id: "graham", name: "Paul Graham", tag: "创业 · 写作思考", bio: "Writing is thinking", color: "#dc2626" },
  { id: "karpathy", name: "Andrej Karpathy", tag: "AI 工程 · 教育", bio: "构建即理解，demo ≠ 部署", color: "#7c3aed" },
  { id: "musk", name: "Elon Musk", tag: "工程 · 第一性原理", bio: "物理定律是唯一硬约束", color: "#0891b2" },
  { id: "zhangxuefeng", name: "张雪峰", tag: "教育 · 职业规划", bio: "选择大于努力，就业倒推", color: "#ea580c" },
  { id: "zhangyiming", name: "张一鸣", tag: "产品 · 延迟满足", bio: "平庸有重力，需要逃逸速度", color: "#2563eb" },
  { id: "mrbeast", name: "MrBeast", tag: "增长 · 内容", bio: "成功 = CTR × AVD，其他都是噪音", color: "#db2777" },
  { id: "sutskever", name: "Ilya Sutskever", tag: "AI 研究 · 深度思考", bio: "压缩即理解", color: "#4f46e5" }
];

var CONCEPTS = [
  { id: "first-principles", name: "第一性原理", tag: "把问题拆到不可再拆的事实", bio: "不靠类比，回到事物最基本的事实从头推演。", color: "#475569" },
  { id: "incentives", name: "激励相容", tag: "看懂每个人的行为由什么激励驱动", bio: "一个安排好不好，看它是否让参与者的自利行为恰好推进整体目标。", color: "#b45309" },
  { id: "antifragile-filter", name: "反脆弱过滤", tag: "这个决定在波动里会更强还是更脆", bio: "偏好从波动中受益的选项，用小代价试错替代豪赌。", color: "#44403c" },
  { id: "attention-econ", name: "注意力经济学", tag: "你的时间被什么机制切走了", bio: "注意力残留、深度工作与心流研究的执行视角。", color: "#059669" }
];

var ALL = SEATS.concat(CONCEPTS);

function byId(id) {
  for (var i = 0; i < ALL.length; i++) {
    if (ALL[i].id === id) return ALL[i];
  }
  return null;
}

module.exports = { PEOPLE: SEATS, CONCEPTS: CONCEPTS, ALL: ALL, byId: byId };
