import { describe, expect, it } from "vitest";
import {
  businessFingerprint,
  decideSyncAction,
  hasSubstantialData,
  hasFilesMissingFromCloud,
  type SyncDecisionInput,
} from "../sync-decision";

/* ============ 同步决策的行为测试（复核 REVIEW-TENCENT §2） ============
 * 复核原话：「现有 agent-autopush-firstsync-gate.test.ts 是源码正则，
 * 测试名声称『失败不放行』，断言实际上只检查 markReady 存在，不能证明失败不放行。」
 *
 * 所以这里测的是**纯函数的行为**：给输入、看输出动作。每个断言都对应复核点名的一条路径。 */

const base = (over: Partial<SyncDecisionInput> = {}): SyncDecisionInput => ({
  cloud: { status: "ok", data: { goals: [{ id: "g1" }] }, updatedAt: "2026-11-13T00:00:00.000Z" },
  localHas: false,
  localTs: 0,
  cloudTs: Date.parse("2026-11-13T00:00:00.000Z"),
  toleranceMs: 3000,
  editedDuringPull: false,
  ...over,
});

describe("① 拉取失败时绝不写云端（错误 ≠ 云端为空）", () => {
  it("status=error + 本地有数据 → none（不推送）", () => {
    const d = decideSyncAction(base({ cloud: { status: "error" }, localHas: true }));
    expect(d.kind).toBe("none");
    expect(d.reason).toMatch(/拉取失败/);
  });

  it("status=error + 本地空 → 也不推送", () => {
    expect(decideSyncAction(base({ cloud: { status: "error" }, localHas: false })).kind).toBe("none");
  });

  it("status=error 时即使「云端看起来空」也不许当空处理", () => {
    /* 关键区分：error 的 data 可能是 undefined，但语义是「不知道」，不是「空」 */
    const d = decideSyncAction(base({ cloud: { status: "error", data: null }, localHas: true }));
    expect(d.kind).toBe("none");
  });
});

describe("② 拉取期间用户真的编辑过 → 不得静默覆盖", () => {
  it("云端有数据 + 用户编辑过 + 本地有数据 → conflict", () => {
    const d = decideSyncAction(base({ localHas: true, editedDuringPull: true }));
    expect(d.kind).toBe("conflict");
    expect(d.reason).toMatch(/不得静默覆盖/);
  });

  it("云端有数据 + 用户编辑过 + 本地无实质数据 → 仍采用云端", () => {
    const d = decideSyncAction(base({ localHas: false, editedDuringPull: true }));
    expect(d.kind).toBe("pull");
  });

  it("云端为空 + 用户编辑过 → 推送本地（不会覆盖任何真实数据）", () => {
    const d = decideSyncAction(
      base({ cloud: { status: "empty", data: null }, localHas: true, editedDuringPull: true })
    );
    expect(d.kind).toBe("push");
  });
});

describe("③ 各类初始状态识别正确", () => {
  it("首次无数据（双方都空）→ none", () => {
    expect(
      decideSyncAction(base({ cloud: { status: "empty", data: null }, localHas: false })).kind
    ).toBe("none");
  });

  it("只有空壳会话不算实质数据", () => {
    expect(hasSubstantialData({ agentSessions: [{ messages: [] }] })).toBe(false);
    expect(hasSubstantialData({ agentSessions: [{ messages: [{ id: "m1" }] }] })).toBe(true);
  });

  it("只有设置/提醒 → 不算实质数据（不该挡住云端拉取）", () => {
    expect(hasSubstantialData({ settings: { userName: "x" }, reminders: [{ id: "r1" }] })).toBe(false);
  });

  it("只有对话（有消息）→ 算实质数据", () => {
    expect(hasSubstantialData({ agentSessions: [{ messages: [{ id: "m1" }, { id: "m2" }] }] })).toBe(true);
  });

  it("已有学习目标/笔记 → 算实质数据", () => {
    expect(hasSubstantialData({ goals: [{ id: "g1" }] })).toBe(true);
    expect(hasSubstantialData({ knowledge: [{ id: "k1" }] })).toBe(true);
  });

  it("云端有数据 + 本地空 → pull（新设备/慢网首次打开必须能拉到）", () => {
    expect(decideSyncAction(base({ localHas: false })).kind).toBe("pull");
  });

  it("云端有数据 + 本地有数据 + 云端更新 → pull", () => {
    const d = decideSyncAction(base({ localHas: true, localTs: 1000, cloudTs: 1000 + 5000 }));
    expect(d.kind).toBe("pull");
  });

  it("云端有数据 + 本地更新（在漂移容忍内）→ none", () => {
    const d = decideSyncAction(base({ localHas: true, localTs: 10000, cloudTs: 10000 }));
    expect(d.kind).toBe("none");
  });
});

describe("④ 业务指纹：能区分「水合换引用」与「用户真编辑」", () => {
  it("内容相同但对象是新的 → 指纹相同（水合不算编辑）", () => {
    const a = { goals: [{ id: "g1" }], knowledge: [{ id: "k1" }], agentSessions: [{ messages: [{ id: "m1" }] }] };
    const b = { goals: [{ id: "g1" }], knowledge: [{ id: "k1" }], agentSessions: [{ messages: [{ id: "m1" }] }] };
    expect(businessFingerprint(a)).toBe(businessFingerprint(b));
  });

  it("新增一条笔记 → 指纹变化（真编辑）", () => {
    const a = { knowledge: [{ id: "k1" }] };
    const b = { knowledge: [{ id: "k1" }, { id: "k2" }] };
    expect(businessFingerprint(a)).not.toBe(businessFingerprint(b));
  });

  it("同数不同 id（内容替换）→ 指纹变化", () => {
    const a = { knowledge: [{ id: "k1" }] };
    const b = { knowledge: [{ id: "k9" }] };
    expect(businessFingerprint(a)).not.toBe(businessFingerprint(b));
  });

  it("新增一条对话消息 → 指纹变化", () => {
    const a = { agentSessions: [{ messages: [{ id: "m1" }] }] };
    const b = { agentSessions: [{ messages: [{ id: "m1" }, { id: "m2" }] }] };
    expect(businessFingerprint(a)).not.toBe(businessFingerprint(b));
  });
});

describe("未同步的本地编辑保护", () => {
  it("refresh can finish uploading a later edit after the same tab lost the previous receipt", () => {
    const editing = { localHas: true, localTs: 1000, cloudTs: 9000, hasUnsyncedEdits: true };
    expect(decideSyncAction(base(editing)).kind).toBe("conflict");
    expect(decideSyncAction(base({ ...editing, cloudAcknowledgedLocalUpload: true })).kind).toBe("push");
  });
  it("云版本时间更晚但缺一本本地刚生成的书时保留两边", () => {
    const local = { books: [{ id: "before" }, { id: "just-created" }] };
    const cloud = { books: [{ id: "before" }] };
    expect(hasFilesMissingFromCloud(local, cloud)).toBe(true);
    expect(decideSyncAction(base({ localHas: true, localTs: 1000, cloudTs: 2000, hasLocalOnlyEntries: true })).kind).toBe("conflict");
    expect(decideSyncAction(base({ localHas: true, localTs: 1000, cloudTs: 1000, hasLocalOnlyEntries: true })).kind).toBe("push");
  });

  it("即使笔记条数和 ID 一样，未同步正文也不会被新的云版本覆盖", () => {
    expect(decideSyncAction(base({ localHas: true, localTs: 1000, cloudTs: 9000, hasUnsyncedEdits: true })).kind).toBe("conflict");
  });

  it("云端版本未变化时补传刷新前的本地编辑", () => {
    expect(decideSyncAction(base({ localHas: true, localTs: 1000, cloudTs: 1000, hasUnsyncedEdits: true })).kind).toBe("push");
  });

  it("独立创建的空文件夹也属于要同步的内容，空白对话壳不算本机独有记录", () => {
    expect(hasSubstantialData({ folders: ["备考"] })).toBe(true);
    expect(hasFilesMissingFromCloud({ folders: ["备考"] }, {})).toBe(true);
    expect(hasFilesMissingFromCloud({ agentSessions: [{ id: "shell", messages: [] }] }, {})).toBe(false);
  });
});
