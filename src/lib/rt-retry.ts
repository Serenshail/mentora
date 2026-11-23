/* ============ 圆桌补答入口的历史重建 ============
 * rtRetry 是 CouncilPage 的组件内存态（useState）：路由切换/整页刷新即丢，且没有
 * 任何从会话消息重建它的逻辑。但失败席位/主持人纪要失败的消息会永久写进会话历史，
 * 并明确承诺补救——「（发言失败——本轮结束后可单独重试）」「可点『重试主持人纪要』」。
 * 结果：圆桌出现失败后用户切走再回来，历史里每条失败消息都说能重试，实际的
 * 重试横幅已消失，用户只能整题重问（还会在历史里留下重复的问题消息）。
 * 这里把「从会话历史重建 rtRetry」提为纯函数（脱离 React 可单测），由页面在
 * 切回圆桌会话时调用，让历史承诺的补救入口重新出现。 */

/** 与 council/page.tsx 的 rtRetry state 同形（seats 泛型化以便单测注入最小结构） */
export interface RtRetryEntry<P> {
  sessionId: string;
  question: string;
  seats: P[]; // 需要重跑发言的席位；空数组 = 只重试主持人
  goodTakes: Record<string, string>;
  note: string;
}

/** 席位失败消息的固定尾缀（roundtableSend 写入，重试重建按它识别失败席位） */
const SEAT_FAIL_MARK = "（发言失败——本轮结束后可单独重试）";
/** 主持人失败消息前缀（catch 分支写入） */
const HOST_FAIL_MARK = "> 主持人纪要生成失败";
/** 纪要消息前缀（成功落库的纪要，含「补答后重出」版本） */
const SUMMARY_MARK = "## 圆桌纪要";

/**
 * 从圆桌会话历史重建补答入口；无失败（或补救已完成）时返回 null。
 *
 * 取景口径：只看**最后一轮**——最后一条用户消息之后的部分。重试补答不追加用户
 * 消息，天然归入同一轮。不这样做的话，早前轮次的历史会把已补救/已过期的席位
 * 重新翻出来（例如上一轮的旧 take 会被误当成本轮已有发言）。
 *
 * @param sess            圆桌会话（CouncilSession 的最小结构）
 * @param resolvePersona  席位解析：内置席位/自建人物 → { id, name }；
 *                        已删除或失效的席位返回 null/undefined（跳过，不进 seats
 *                        也不进 goodTakes——与 live 流程「凑不够 2 席不开重试」同口径）
 */
export function rebuildRtRetry<P extends { id: string; name: string }>(
  sess: {
    id: string;
    participants?: string[];
    messages: { role: string; content: string }[];
  },
  resolvePersona: (personaId: string) => P | null | undefined
): RtRetryEntry<P> | null {
  /* 最后一轮 = 最后一条用户消息之后（倒序找，不依赖 ES2023 的 findLastIndex） */
  let lastUserIdx = -1;
  for (let i = sess.messages.length - 1; i >= 0; i--) {
    if (sess.messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return null;
  const question = sess.messages[lastUserIdx].content.trim();
  if (!question) return null;
  const round = sess.messages.slice(lastUserIdx + 1);

  /* 主持人结果只看本轮顺序：失败消息之后又落了纪要（补答重出成功）→ 视为已补救 */
  let hostFailed = false;
  let hostOk = false;
  for (const m of round) {
    if (m.content.startsWith(SUMMARY_MARK)) hostOk = true;
    else if (m.content.startsWith(HOST_FAIL_MARK)) hostFailed = true;
  }

  const goodTakes: Record<string, string> = {};
  const seats: P[] = [];
  for (const pid of sess.participants ?? []) {
    const p = resolvePersona(pid);
    if (!p) continue; // 席位已被删除/失效：无法重跑，也不算已有发言
    /* 每席位以本轮最后一次出现为准（补答会在历史里追加第二条同席位消息）；
     * 只扫本轮：被取消的席位本轮没有消息，早前轮次的旧 take 不得冒充本轮发言 */
    let last: { role: string; content: string } | undefined;
    for (let i = round.length - 1; i >= 0; i--) {
      if (round[i].content.startsWith(`**【${p.name}】**`)) {
        last = round[i];
        break;
      }
    }
    if (!last) continue;
    if (last.content.includes(SEAT_FAIL_MARK)) {
      seats.push(p);
      continue;
    }
    const take = last.content
      .slice(`**【${p.name}】**`.length)
      .replace(/^\n+/, "")
      .trim();
    if (take) goodTakes[pid] = take;
  }

  /* 无失败席位、且主持人没有「失败后未补救」→ 不需要补答入口 */
  if (seats.length === 0 && !(hostFailed && !hostOk)) return null;

  const note =
    seats.length > 0
      ? `${seats.length} 席发言失败${hostOk ? `（纪要已按 ${Object.keys(goodTakes).length} 席生成）` : ""}`
      : "主持人纪要失败";
  return { sessionId: sess.id, question, seats, goodTakes, note };
}
