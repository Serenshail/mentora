import { describe, expect, it } from "vitest";

/* 回归锁：session-runtime 的 TOOL_LABELS 必须覆盖 protocol.TOOLS 的全部工具名。
 * 背景：TOOL_LABELS 自称「与 protocol.TOOLS 的 label 同源」，实际漏了 manage_workspace /
 * manage_goal 两项——describeHeadline 缺表时回退 `?? name`，运行卡状态行会显示
 * 「正在manage_workspace…」这种原始英文 id，而同屏芯片用的是协议表中文标签。 */

import { TOOLS } from "../agent/protocol";
import { TOOL_LABELS } from "../agent/session-runtime";

describe("TOOL_LABELS 与 protocol.TOOLS 不漂移", () => {
  it("每个协议工具名都有中文短标签", () => {
    const missing = Object.keys(TOOLS).filter((name) => !(name in TOOL_LABELS));
    expect(missing).toEqual([]);
  });

  it("没有多余的标签项（表里不该有协议里不存在的工具）", () => {
    const extra = Object.keys(TOOL_LABELS).filter((name) => !(name in TOOLS));
    expect(extra).toEqual([]);
  });

  it("复合工具 manage_workspace / manage_goal 使用协议表的中文标签", () => {
    expect(TOOL_LABELS.manage_workspace).toBe(TOOLS.manage_workspace.label);
    expect(TOOL_LABELS.manage_goal).toBe(TOOLS.manage_goal.label);
  });
});
