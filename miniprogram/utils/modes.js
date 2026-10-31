/* ========= 读书五模式（与 Web 端 reading-modes.ts 同源移植） ========= */
var MODES = [
  { id: "socratic", label: "苏格拉底", hint: "只提问不讲解：定义→依据→反例→边界，追到你自己讲通", forType: "概念/原理" },
  { id: "feynman", label: "费曼讲桌", hint: "你讲，它当聪明外行只听：黑话/断裂/跳跃打回，绝不代讲", forType: "检验真懂" },
  { id: "collision", label: "思想碰撞", hint: "它站本书观点的对立面逼你辩护，每 3 轮可反转立场", forType: "判断/争议" },
  { id: "close-read", label: "精读带读", hint: "一次一段：原文主张→论证位置→一个理解性问题", forType: "原文细读" },
  { id: "recall-check", label: "复盘检验", hint: "先合书回忆再迁移，四级判定并记掌握状态", forType: "读完验收" }
];

function defaultMode(knowledgeType) {
  switch (knowledgeType) {
    case "procedure":
      return "recall-check";
    case "judgment":
      return "collision";
    case "creative":
      return "close-read";
    default:
      return "socratic";
  }
}

function byId(id) {
  for (var i = 0; i < MODES.length; i++) {
    if (MODES[i].id === id) return MODES[i];
  }
  return MODES[0];
}

module.exports = { MODES: MODES, defaultMode: defaultMode, byId: byId };
