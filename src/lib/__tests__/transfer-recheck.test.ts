import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

/* Node 环境没有 localStorage：zustand persist 的 setItem 会炸（同 reading-v25.test.ts 先例） */
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => Array.from(mem.keys())[i] ?? null,
      get length() {
        return mem.size;
      },
    },
    configurable: true,
  });
}

import { readingTransferRecheckGradeSchema, readingTransferRecheckSchema } from "../ai/client";
import { transferOutcome, TRANSFER_OUTCOME_LABELS, type BookTransfer } from "../types";
import { useAppStore } from "../store";

/* ============ 回归锁：v26.1 G3 独立迁移复检必须有作答 UI（FIX 2026-11-09）============
 * 修复前：page.tsx 里 genRecheck 生成复检题后 setRecheck 存 state，
 * 但 JSX 无任何分支渲染 recheck，submitRecheck 无调用点——
 * 用户点「开始独立检验」后题目凭空消失，按钮反复可点反复烧 token，
 * transferOutcome 的 independent_success 对用户永远不可达。
 * 此锁用源码结构断言钉住：recheck state 必须有 JSX 消费点，
 * submitRecheck 必须被调用，且调用点带空答案守卫。 */

const pageSource = readFileSync(
  new URL("../../app/read/[id]/page.tsx", import.meta.url),
  "utf8"
);

describe("独立迁移复检：recheck 作答 UI 必须存在（回归锁）", () => {
  it("recheck state 有 JSX 消费点：recheck ? ( 作答分支存在", () => {
    expect(pageSource).toMatch(/\brecheck\s*\?\s*\(/);
  });
  it("submitRecheck 定义之后必须被 JSX 调用（onClick 绑定），不允许再退化为不可达代码", () => {
    const defIdx = pageSource.indexOf("const submitRecheck = async () => {");
    const callIdx = pageSource.indexOf("void submitRecheck()");
    expect(defIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(defIdx);
  });
  it("genRecheck 定义之后必须被 JSX 调用（「开始独立检验」按钮）", () => {
    const defIdx = pageSource.indexOf("const genRecheck = async (transferId: string) => {");
    const callIdx = pageSource.indexOf("void genRecheck(lastTransferId)");
    expect(defIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(defIdx);
  });
  it("submitRecheck 有空答案守卫（与 submitTransfer 同级防呆），且守卫在 busy 置位之前", () => {
    const def = pageSource.slice(pageSource.indexOf("const submitRecheck = async () => {"));
    expect(def).toMatch(/if\s*\(!recheck\.answer\.trim\(\)\)\s*\{[\s\S]*?toast\.error/);
    const guardIdx = def.indexOf("!recheck.answer.trim()");
    const busyIdx = def.indexOf("setRecheckBusy(true)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(busyIdx).toBeGreaterThan(guardIdx);
  });
  it("提交按钮绑定的就是 submitRecheck（loading=recheckBusy 防重复烧 token）", () => {
    expect(pageSource).toMatch(/onClick=\{\(\) => void submitRecheck\(\)\}\s*loading=\{recheckBusy\}/);
  });
});

/* ============ schema 容错锁（与数据链一致）============ */

describe("readingTransferRecheckSchema（复检出题）", () => {
  it("任务文本必须非空（min 10）", () => {
    expect(readingTransferRecheckSchema.parse({ task: "换个场景：向不熟悉这个概念的朋友解释什么时候用它" }).task).toBeTruthy();
    expect(() => readingTransferRecheckSchema.parse({ task: "太短" })).toThrow();
  });
});

describe("readingTransferRecheckGradeSchema（复检判分）", () => {
  it("六分类合法值直通", () => {
    expect(readingTransferRecheckGradeSchema.parse({ verdict: "independent_success" }).verdict).toBe("independent_success");
    expect(readingTransferRecheckGradeSchema.parse({ verdict: "partial_success" }).verdict).toBe("partial_success");
  });
  it("脏值回落 ungradable（不放水）", () => {
    expect(readingTransferRecheckGradeSchema.parse({ verdict: "答对了" }).verdict).toBe("ungradable");
  });
  it("evidence/feedback 允许 null（诚实留白不炸）", () => {
    const r = readingTransferRecheckGradeSchema.parse({ verdict: "assisted_success", evidence: null, feedback: null });
    expect(r.verdict).toBe("assisted_success");
  });
});

/* ============ store 动作语义锁：attachTransferRecheck 真正写回 recheck 字段 ============ */

const seedBook = () => {
  const id = "b-recheck";
  useAppStore.setState({
    books: [
      {
        id,
        title: "测试之书",
        status: "reading",
        readStatus: "reading",
        chapters: [{ id: "c1", title: "节点一", focusQuestion: "f1", status: "todo" as const }],
        insights: [],
        chat: [],
        createdAt: new Date().toISOString(),
      },
    ],
    knowledge: [],
  });
  return id;
};

describe("attachTransferRecheck + transferOutcome 联动（独立成功可达性）", () => {
  beforeEach(() => {
    useAppStore.setState({ books: [], knowledge: [] });
  });

  it("独立作答过复检：recheck 写回 transfer，used_correct 不可达态从此可达", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    const tid = s.addBookTransfer(id, {
      chapterIds: ["c1"],
      task: "用互惠设计一次说服",
      answer: "我先给对方一个有用的东西再提请求",
      verdict: "used_correct",
      evidence: "你说：我先给再提",
      feedback: "机制用对了",
      mode: "independent",
    });
    // 修复前的用户困境：没有 UI 能把 recheck 挂上去 → outcome 卡死在 partial_success
    expect(transferOutcome(useAppStore.getState().books[0].transfers![0])).toBe("partial_success");

    useAppStore.getState().attachTransferRecheck(id, tid, {
      task: "换场景：帮同事争取预算",
      answer: "我先做了他想要的报表再谈预算",
      verdict: "independent_success",
      evidence: "你说：先做报表",
      at: new Date().toISOString(),
    });
    const t = useAppStore.getState().books[0].transfers![0];
    expect(t.recheck).toBeDefined();
    expect(t.recheck!.verdict).toBe("independent_success");
    expect(transferOutcome(t)).toBe("independent_success");
    expect(TRANSFER_OUTCOME_LABELS[transferOutcome(t)]).toBe("独立迁移成功");
  });

  it("复检作答为空时聚合不受影响（transferOutcome 的 rechecked 守卫）", () => {
    const id = seedBook();
    const s = useAppStore.getState();
    const tid = s.addBookTransfer(id, {
      chapterIds: ["c1"],
      task: "任务",
      answer: "一个有内容的作答",
      verdict: "used_correct",
      evidence: "e",
      feedback: "f",
      mode: "independent",
    });
    useAppStore.getState().attachTransferRecheck(id, tid, {
      task: "换场景",
      answer: "   ",
      verdict: "independent_success",
      evidence: "e",
      at: new Date().toISOString(),
    });
    // 空白复检作答不计入聚合：仍然只是 partial_success（防脏数据放水）
    expect(transferOutcome(useAppStore.getState().books[0].transfers![0])).toBe("partial_success");
  });
});
