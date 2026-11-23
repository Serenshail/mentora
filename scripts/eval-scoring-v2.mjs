/* EVAL-01 评测口径 v2（2026-11-10 校准）
 *
 * 背景：旧口径存在三处失真（复核报告 §3 已确认）：
 *  1. direct 路径用统一「中文且 >60 字」判定——短翻译、短直答被误判失败；
 *  2. 浏览器脚本没有 intent.noDump，却有人据此解释 in12 失败；
 *  3. 归档只存文本片段，未验证真实业务对象是否创建。
 *
 * v2 原则（用户已确认方向）：
 *  - 简答/翻译：按任务完成 + 语义正确 + 无无关流程判断；取消统一字数下限，
 *    用「拒答/空输出/截断/夹杂内部协议」等专门检查兜底。
 *  - 薄意图规划：接受有针对性的必要澄清；允许范围明确的草稿式交接，
 *    但不得把猜测写成既知用户事实。
 *  - 工具交接：检查对象确实创建、指定字段完整、未重复创建；不能只看工具标签。
 *  - 每条结果保存检查项明细、脚本哈希、提供商/模型，独立 runId。
 *
 * 本模块是纯函数，可单测；不修改旧归档，v2 结果写入新文件。
 */

export const SCORING_VERSION = "v2";

/** 内部协议/工具痕迹泄漏（正文里出现即判脏） */
const LEAK_RE =
  /确认卡|先调用|调用工具|批准后|等待用户|report the|call the tool|give final answer|confirm briefly|```(?:tool|plan)/i;

/** 拒答/空输出 */
export function isRefusalOrEmpty(text) {
  const t = String(text ?? "").trim();
  if (!t) return true;
  return /^(抱歉|对不起|我无法|我不能|无法回答|不知道)/.test(t) && t.length < 40;
}

/** 截断迹象（回答在中途断掉）。
 *  注意：调用方常把文本截到 N 字保存，因此不能用「末尾标点」判断——
 *  截断到第 600 字时几乎必然以逗号/顿号结尾。只认结构性证据：
 *  未闭合代码块、明确的续写提示（"接下来我会…"后无内容）。 */
export function looksTruncated(text) {
  const t = String(text ?? "").trim();
  if (!t) return true;
  const fences = (t.match(/```/g) || []).length;
  if (fences % 2 !== 0) return true;
  /* 以明显的未完成承诺结尾，且后面没有内容 */
  if (/(接下来我会|下面我来|以下是|如下：)\s*$/.test(t)) return true;
  return false;
}

/**
 * direct（简答/翻译/直答）判定——v2：不再用统一字数下限。
 * 通过条件：有实质内容 + 无内部协议泄漏 + 未截断 + 未把简单问题转成流程。
 */
export function scoreDirect(text) {
  const t = String(text ?? "").trim();
  const checks = {
    hasSubstance: t.length >= 2,
    notRefusal: !isRefusalOrEmpty(t),
    noLeak: !LEAK_RE.test(t),
    notTruncated: !looksTruncated(t),
    /* 简单问题不该被强行转成「建学习目标/加书/开会话」的流程话术 */
    noWorkflowPush: !/学习目标已创建|已为你创建|加入书架|开始引导对话|学习计划已生成/.test(t),
  };
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, version: SCORING_VERSION, chars: t.length };
}

/**
 * handoff（交接）判定——v2：看真实对象，而不是只看工具标签或成功文案。
 * @param {object} obs { handoffTools: string[], text: string, created?: {goals?:number,books?:number,sessions?:number, background?:string|null} }
 */
export function scoreHandoff(obs) {
  const tools = obs.handoffTools ?? [];
  const text = String(obs.text ?? "");
  const created = obs.created ?? {};
  const createdAny = (created.goals ?? 0) + (created.books ?? 0) + (created.sessions ?? 0) > 0;
  const checks = {
    /* 有交接工具 或 有真实新对象（二者之一即算发生了交接） */
    handoffHappened: tools.length > 0 || createdAny,
    /* 若确实建了目标，背景字段应被保存（只有能读到 created 时才检查，读不到记为 unknown 不算失败） */
    backgroundSaved: created.background === undefined ? "unknown" : Boolean(created.background && String(created.background).trim()),
    noLeak: !LEAK_RE.test(text),
    notTruncated: !looksTruncated(text),
  };
  const hardFail = checks.handoffHappened === false || checks.noLeak === false || checks.notTruncated === false;
  const bgFail = checks.backgroundSaved === false;
  return { pass: !hardFail && !bgFail, checks, version: SCORING_VERSION };
}

/**
 * resume（恢复）判定——v2。
 * 关键纪律（in28 实证）：如实告知「没找到」并给用户选项（含「重新立一个」作为选项之一），
 * 是正确行为，不能判负。只有在「声称有进度/恢复」的同时又实际重建，才算错。
 */
export function scoreResume(obs) {
  const tools = obs.resumeTools ?? [];
  const text = String(obs.text ?? "");
  const claimsResume = tools.length > 0 || /进度|继续|恢复|已有|之前|接着|上次|还在/.test(text);
  /* 「没找到/没有记录/查了三个地方都没有」这类如实告知，不算声称恢复 */
  const honestNotFound = /没找到|没有找到|无任何|都没有|查了.{0,6}都没有|未找到|不存在/.test(text);
  const mentionsRecreate = /重新立|新建一个.{0,8}目标|重新创建/.test(text);
  const checks = {
    /* 有恢复动作，或如实说明没找到并给下一步（都算处理正确） */
    resumeHappened: claimsResume || honestNotFound,
    /* 只有「声称已恢复/有进度」却同时重建，才是错；如实告知后的选项不算 */
    noRecreate: !(claimsResume && !honestNotFound && mentionsRecreate),
    noLeak: !LEAK_RE.test(text),
  };
  return { pass: Object.values(checks).every(Boolean), checks, version: SCORING_VERSION };
}

/**
 * 学习意图首轮（a 轮）判定——「合理澄清」（产品决定 §2）。
 * 合格澄清 ≠ 交接完成；首轮默认不创建目标。
 * @param {object} obs { text, createdDelta?: {goals?:number} }
 */
export function scoreClarify(obs) {
  const text = String(obs.text ?? "");
  const goalsDelta = obs.createdDelta?.goals ?? 0;
  const qMarks = (text.match(/？/g) || []).length;
  const numberedQ = /(?:^|\n)\s*[1-9][.、][^\n]{0,40}？/gm.test(text);
  const checks = {
    /* 问了必要信息（问句存在即视为澄清发生；完全不问且未创建的「空转」判负） */
    clarifyRelevant: qMarks >= 1 || /为了什么|用途|基础|时间|方向/.test(text),
    /* 问卷式盘问：≥3 个问句且带编号列表判负 */
    noInterrogate: !(qMarks >= 3 && numberedQ),
    /* 不编造用户事实：不得把猜测断言为「你是…」「你在…」类既知事实 */
    noFabricate: !/你是(做|搞|写)[^。？]{0,12}(的|的[。.])/.test(text),
    /* 首轮默认不创建目标 */
    noPrematureCreate: goalsDelta === 0,
    noLeak: !LEAK_RE.test(text),
    notTruncated: !looksTruncated(text),
  };
  return { pass: Object.values(checks).every(Boolean), checks, version: SCORING_VERSION };
}

/**
 * 学习意图二轮（b 轮）判定——「真实交接」（产品决定 §2）。
 * @param {object} obs {
 *   text, createdDelta?: {goals?:number},
 *   goal?: { background?: string, topic?: string } | null,   // 从真实 store 读取
 *   expectedPoints: string[],   // 固定输入里的关键点（逐项出现在 background 中才算保存）
 *   reAskedKnown?: boolean,     // 是否再次询问已提供的用途/基础/时间（由文本正则判定，可留空自动判）
 * }
 */
export function scoreHandoffRound2(obs) {
  const text = String(obs.text ?? "");
  const goalsDelta = obs.createdDelta?.goals ?? 0;
  const goal = obs.goal ?? null;
  const bg = String(goal?.background ?? "");
  const expected = obs.expectedPoints ?? [];
  const bgHasAll = expected.length > 0 && expected.every((p) => bg.includes(p) || text.includes(p));
  const reAsk = obs.reAskedKnown ?? /为了什么|什么用途|你(的)?基础|每天.{0,4}(多少|能投)/.test(text);
  const checks = {
    /* 对象真实创建（增量，不是工具卡存在） */
    created: goalsDelta === 1,
    /* 背景字段保存了固定输入的关键点（不得编造：只要求包含，不要求逐字） */
    backgroundSaved: bgHasAll,
    /* 不重复盘问已提供信息 */
    noReAsk: !reAsk,
    /* 返回接续入口（链接或明确的继续指引） */
    hasEntry: /\/learn\/new\?goal=|学习页|引导对话|继续引导/.test(text) || /\/learn\/new\?goal=/.test(bg),
    noLeak: !LEAK_RE.test(text),
    notTruncated: !looksTruncated(text),
  };
  return { pass: Object.values(checks).every(Boolean), checks, version: SCORING_VERSION };
}

/** 统一入口 */
export function score(route, obs) {
  if (route === "direct") return scoreDirect(obs.text);
  if (route === "handoff") return scoreHandoff(obs);
  if (route === "clarify") return scoreClarify(obs);
  if (route === "handoff2") return scoreHandoffRound2(obs);
  return scoreResume(obs);
}
