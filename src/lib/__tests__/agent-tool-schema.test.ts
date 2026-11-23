import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/* ============ 工具参数 schema 必须给模型真实结构（ACT-01/02 落地前提） ============
 * 2026-11-12 真实模型实测抓到的根因：原生 tool_calls 通道的 parameters 是
 * `{type:"object", properties:{}}` —— 空 properties。模型看不到嵌套结构，
 * 只能按散文猜 edit_phase 的 changes，猜错就报「没有可应用的修改内容」，
 * 于是「调整计划」永远只检索不落地。
 *
 * 这里锁的是「关键工具的 schema 有真实 properties」这一结构事实。 */

const SRC = "src/lib/server/agent-tools.ts";

/* agent-tools.ts 带 `server-only`：vitest 里要 mock 掉才能在 Node 环境导入 */
vi.mock("server-only", () => ({}));

describe("agent tools schema", () => {
  it("edit_phase / get_goal / save_note 有真实参数 schema", async () => {
    const mod = await import("../server/agent-tools");
    const tools = mod.agentToolsSchema();
    const byName = new Map(tools.map((t) => [t.function.name, t.function]));

    const edit = byName.get("edit_phase")!;
    expect(edit).toBeTruthy();
    const props = (edit.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).length).toBeGreaterThan(0);
    expect(props).toHaveProperty("changes");
    expect(props).toHaveProperty("id");
    /* changes 里必须能看到 phaseMeta（模型据此才知道怎么改标题） */
    const changes = props.changes as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(changes.properties)).toContain("phaseMeta");
    expect(changes.required ?? []).not.toContain("phaseMeta");
    expect(changes.properties).toHaveProperty("phaseOrder");
    expect(changes.properties).toHaveProperty("phaseCatalogs");

    const getGoal = byName.get("get_goal")!;
    expect(Object.keys((getGoal.parameters as { properties: Record<string, unknown> }).properties).length).toBeGreaterThan(0);

    const saveNote = byName.get("save_note")!;
    const snProps = (saveNote.parameters as { properties: Record<string, unknown>; required?: string[] }).properties;
    expect(Object.keys(snProps)).toEqual(expect.arrayContaining(["title", "body"]));
  });

  it("每个工具的 description 都非空（模型靠它决定要不要调）", async () => {
    const mod = await import("../server/agent-tools");
    for (const t of mod.agentToolsSchema()) {
      expect(t.function.description.length).toBeGreaterThan(10);
      expect(t.function.name).toBeTruthy();
    }
  });

  it("源码里不再出现「关键工具仍用空 properties」的回落", () => {
    /* 结构断言：PARAM_SCHEMAS 覆盖了 edit_phase */
    const src = readFileSync(SRC, "utf8");
    expect(src).toMatch(/edit_phase: EDIT_PHASE_PARAMS/);
    expect(src).toMatch(/PARAM_SCHEMAS\[t\.name\] \?\? schemaOf\(t\.params\)/);
  });
});
