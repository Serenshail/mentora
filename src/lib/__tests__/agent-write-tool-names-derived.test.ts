import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { TOOLS, WRITE_TOOL_NAMES } from "../agent/protocol";

/* ============ 写入类工具名单必须从 protocol.TOOLS 派生（回归锁） ============
 * 背景：agent-home 手抄的 WRITE_TOOL_NAMES 与协议写语义漂移——漏掉 13 个协议登记
 * 的写入工具（update_book/remove_book/save_reading_deposit/edit_book_goal/
 * set_reading_progress/move_chapter/link_notes/record_book_assessment/
 * rebuild_reading_route/restore_book_route/manage_session/forge_persona/review_queue），
 * 用户批准执行成功后工作台「产物」栏对这批写入毫无痕迹。修复：名单改为
 * risk:"write" 整工具 + writeActions 混合工具的派生集合（protocol.ts 导出）。 */

const HOME = readFileSync(join(process.cwd(), "src/components/agent-home.tsx"), "utf8");

describe("WRITE_TOOL_NAMES 与协议写语义一致", () => {
  it("此前手抄漏掉的写入工具全部在名单里", () => {
    for (const name of [
      "update_book",
      "remove_book",
      "save_reading_deposit",
      "edit_book_goal",
      "set_reading_progress",
      "move_chapter",
      "link_notes",
      "record_book_assessment",
      "rebuild_reading_route",
      "restore_book_route",
      "manage_session",
      "forge_persona",
      "review_queue",
      /* 顺带补齐：同表登记的讨论/阵容写入 */
      "run_discussion",
      "set_participants",
    ]) {
      expect(WRITE_TOOL_NAMES.has(name), `${name} 应是写入类工具`).toBe(true);
    }
  });

  it("混合工具（writeActions）在名单里，纯只读工具不在", () => {
    expect(WRITE_TOOL_NAMES.has("memory")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("reminders")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("manage_workspace")).toBe(true);
    for (const name of ["search_brain", "get_note", "list_goals", "web_search", "read_url", "resume_workflow", "get_book", "get_session", "make_quiz"]) {
      expect(WRITE_TOOL_NAMES.has(name), `${name} 不应是写入类工具`).toBe(false);
    }
  });

  it("与 TOOLS 逐项对齐：has(name) === (risk==='write' || 有 writeActions)", () => {
    for (const spec of Object.values(TOOLS)) {
      const expected = spec.risk === "write" || (spec.writeActions?.length ?? 0) > 0;
      expect(WRITE_TOOL_NAMES.has(spec.name), `${spec.name} 的归属与协议写语义不一致`).toBe(expected);
    }
  });

  it("agent-home 不再手抄名单，产物过滤引用派生集合", () => {
    expect(HOME).not.toContain("const WRITE_TOOL_NAMES = new Set([");
    expect(HOME).toContain("WRITE_TOOL_NAMES.has(t.name)");
    expect(HOME).toMatch(/import \{ TOOLS, WRITE_TOOL_NAMES/);
  });
});
