import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import type { Goal, Book, CouncilSession, ChatMsg, Plan, DayPlan } from "../types";

/* ============ 消息数组必须有上限（与 quizLog 同一失效模型）============
 * 云端同步是全量快照 + 服务端 4.2/4.5MB 体积闸，载荷含 goals/books/sessions 全量。
 * day.qa / books.chat / sessions.messages 此前完全无上限：长期重度使用后快照超限会让
 * 「推不上」滑向「本机写盘也失败」，丢掉自上次落盘以来的全部编辑。
 * 修复：各留最近 N 条（保留最新、丢弃最旧）。 */

const msg = (c: string): ChatMsg => ({ id: c, role: "user", content: c, at: "2026-01-01T00:00:00.000Z" });

function seedGoalWithDay() {
  const day = {
    id: "d1", phaseId: "p1", title: "D1", knowledgePoints: [], resources: [],
    method: "", acceptance: [], status: "active", attempts: 0,
  } as unknown as DayPlan;
  const plan = {
    phases: [{ id: "p1", title: "P1", dayIds: ["d1"], status: "active" }],
    days: { d1: day },
  } as unknown as Plan;
  useAppStore.setState({ goals: [{ id: "g1", topic: "T", direction: "", plan } as unknown as Goal] });
}

beforeEach(() => {
  useAppStore.setState({ goals: [], books: [], sessions: [], knowledge: [] });
});

describe("消息数组封顶", () => {
  it("appendDayQa 封顶 100 条，保留最新", () => {
    seedGoalWithDay();
    for (let i = 0; i < 130; i++) useAppStore.getState().appendDayQa("g1", "d1", msg(`m${i}`));
    const qa = useAppStore.getState().goals[0].plan!.days["d1"].qa!;
    expect(qa.length).toBe(100);
    expect(qa[qa.length - 1].content).toBe("m129");
    expect(qa[0].content).toBe("m30");
  });

  it("addBookMsg 封顶 300 条", () => {
    useAppStore.setState({ books: [{ id: "b1", chapters: [], chat: [], insights: [] } as unknown as Book] });
    for (let i = 0; i < 330; i++) useAppStore.getState().addBookMsg("b1", msg(`c${i}`));
    const chat = useAppStore.getState().books[0].chat;
    expect(chat.length).toBe(300);
    expect(chat[chat.length - 1].content).toBe("c329");
  });

  it("addSessionMsg 封顶 300 条", () => {
    useAppStore.setState({ sessions: [{ id: "s1", messages: [] } as unknown as CouncilSession] });
    for (let i = 0; i < 330; i++) useAppStore.getState().addSessionMsg("s1", msg(`s${i}`));
    const msgs = useAppStore.getState().sessions[0].messages;
    expect(msgs.length).toBe(300);
    expect(msgs[msgs.length - 1].content).toBe("s329");
  });
});
