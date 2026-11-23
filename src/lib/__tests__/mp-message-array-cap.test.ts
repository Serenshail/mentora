import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { join } from "path";

/* ============ 三个无界消息数组必须有上限（回归锁） ============
 * 事故链（store.js:838 addBookMsg / store.js:1159 addSessionMsg /
 * day.js:407-413 sendQa）：
 *  ① 圆桌一轮就写入全部席位发言 + 主持人纪要（council.js:503 是本数组最大的单次写入点）；
 *  ② 读书聊天 addBookMsg 无限 concat；
 *  ③ 每日答疑 plan.days[dayId].qa 无限追加。
 *  三个数组都是无界增长，而快照是全量同步的：服务端 4.2MB 硬拒
 *  （src/app/api/sync/route.ts MAX_BODY_BYTES）、微信 setStorageSync 单 key 1MB。
 *  撞穿后 saveLocal 抛错被吞 → 本机缓存静默停写，此后所有编辑只活在内存里
 *  （quizLog 已因同一原因修过，store.js QUIZ_LOG_MAX）。
 * 修法：util.capMessages 统一裁剪（条数上限 + 超长单条截断并留标记），三个写入点都走它。
 * 本测试真执行 store.js / day.js（注入 wx/Page），按行为断言。 */

const require_ = createRequire(import.meta.url);
const ROOT = process.cwd();

type Dict = Record<string, unknown>;

function loadStore() {
  const storage: Dict = {};
  const g = globalThis as unknown as Dict;
  g.wx = {
    getStorageSync: (k: string) => storage[k],
    setStorageSync: (k: string, v: unknown) => {
      storage[k] = v;
    },
    removeStorageSync: (k: string) => {
      delete storage[k];
    },
    showToast: () => {},
  };
  const utils = join(ROOT, "miniprogram/utils");
  for (const f of ["store.js", "util.js", "api.js", "mastery.js"]) {
    delete (require_.cache as unknown as Record<string, unknown>)[join(utils, f)];
  }
  return require_(join(utils, "store.js"));
}

describe("消息数组上限：会话 / 读书聊天 / 每日答疑", () => {
  it("addSessionMsg 超过上限只保留最近 N 条（最新一条一定在）", () => {
    const store = loadStore();
    store.addSession({
      id: "s1",
      personaId: "roundtable",
      participants: ["naval", "jobs"],
      messages: [],
      createdAt: new Date().toISOString(),
    });
    for (let i = 0; i < 160; i++) {
      store.addSessionMsg("s1", {
        id: "m" + i,
        role: "assistant",
        content: "第" + i + "条",
        at: new Date().toISOString(),
      });
    }
    const msgs = store.sessionById("s1").messages as Dict[];
    expect(msgs.length).toBeLessThanOrEqual(100);
    expect(msgs[msgs.length - 1]!.content).toBe("第159条");
    // 首条已被裁掉：不是无界增长
    expect(msgs[0]!.content).not.toBe("第0条");
  });

  it("addBookMsg 同样受限，且超长单条被截断并留标记", () => {
    const store = loadStore();
    const id = store.createBookFromPlan("书", "作者", "", { chapters: [] }, "verified");
    for (let i = 0; i < 130; i++) {
      store.addBookMsg(id, {
        id: "m" + i,
        role: "assistant",
        content: "第" + i + "条",
        at: new Date().toISOString(),
      });
    }
    const chat = store.bookById(id).chat as Dict[];
    expect(chat.length).toBeLessThanOrEqual(100);
    expect(chat[chat.length - 1]!.content).toBe("第129条");

    store.addBookMsg(id, {
      id: "huge",
      role: "assistant",
      content: "x".repeat(20000),
      at: new Date().toISOString(),
    });
    const last = (store.bookById(id).chat as Dict[]).slice(-1)[0]!;
    expect(String(last.content).length).toBeLessThan(20000);
    expect(String(last.content)).toContain("已截断保存");
  });

  it("day.js sendQa 写入的 qa 数组也受上限约束", async () => {
    const storage: Dict = {};
    const g = globalThis as unknown as Dict;
    g.wx = {
      getStorageSync: (k: string) => storage[k],
      setStorageSync: (k: string, v: unknown) => {
        storage[k] = v;
      },
      removeStorageSync: (k: string) => {
        delete storage[k];
      },
      showToast: () => {},
      setNavigationBarTitle: () => {},
      navigateBack: () => {},
      redirectTo: () => {},
    };
    g.getApp = () => ({ globalData: { user: { userId: "u1" } } });

    const utils = join(ROOT, "miniprogram/utils");
    const cache = require_.cache as unknown as Record<string, unknown>;
    const storePath = join(utils, "store.js");
    for (const f of ["store.js", "util.js", "api.js", "mastery.js"]) delete cache[join(utils, f)];
    const store = require_(storePath);

    // 造一个已有 150 条答疑的学习日
    const goal = {
      id: "g1",
      topic: "t",
      status: "active",
      quizLog: [],
      plan: {
        startDate: "2026-01-01",
        phases: [{ id: "p1", title: "P", status: "active", dayIds: ["d1"] }],
        days: {
          d1: {
            id: "d1",
            phaseId: "p1",
            title: "D1",
            status: "active",
            knowledgePoints: [],
            acceptance: [],
            qa: Array.from({ length: 150 }, (_, i) => ({
              id: "q" + i,
              role: "user",
              content: "问题" + i,
              at: new Date().toISOString(),
            })),
          },
        },
      },
    };
    store.state.goals = [goal];

    cache[join(utils, "chat.js")] = {
      id: "chat",
      filename: "chat",
      loaded: true,
      exports: {
        streamChat: () => Promise.resolve("回答"),
        extractJson: () => ({}),
      },
    } as unknown;
    cache[join(utils, "md.js")] = {
      id: "md",
      filename: "md",
      loaded: true,
      exports: { parse: (s: string) => ({ blocks: [{ t: "p", text: s }], links: [] }) },
    } as unknown;
    cache[join(utils, "stream-view.js")] = {
      id: "sv",
      filename: "sv",
      loaded: true,
      exports: {
        createStreamRenderer: () => ({ push: () => {}, flush: () => {}, cancel: () => {} }),
      },
    } as unknown;
    cache[join(utils, "grade.js")] = {
      id: "grade",
      filename: "grade",
      loaded: true,
      exports: { normalizeQuizGrade: () => ({}) },
    } as unknown;
    cache[join(utils, "mastery.js")] = {
      id: "mastery",
      filename: "mastery",
      loaded: true,
      exports: { masteryFromQuiz: () => "guided", ORDER: [] },
    } as unknown;
    cache[join(utils, "schema.js")] = {
      id: "schema",
      filename: "schema",
      loaded: true,
      exports: { buildPhaseCtx: () => ({ ctx: "" }), phaseDraftToDay: () => ({}) },
    } as unknown;

    let captured: unknown = null;
    g.Page = (cfg: unknown) => {
      captured = cfg;
    };
    const pagePath = join(ROOT, "miniprogram/pages/day/day.js");
    delete cache[pagePath];
    require_(pagePath);

    const cfg = captured as { data: Dict } & Dict;
    const page: any = Object.assign({}, cfg);
    page.data = JSON.parse(JSON.stringify(cfg.data));
    page.setData = (patch: Dict) => {
      for (const k of Object.keys(patch)) page.data[k] = patch[k];
    };
    page.onLoad({ goalId: "g1", dayId: "d1" });
    page.setData({ qaInput: "新问题" });
    page.sendQa();
    await new Promise((r) => setTimeout(r, 30));

    const qa = (store.state.goals[0].plan.days.d1.qa as Dict[]);
    expect(qa.length).toBeLessThanOrEqual(100);
    expect(qa[qa.length - 1]!.content).toBe("回答");
  });
});
