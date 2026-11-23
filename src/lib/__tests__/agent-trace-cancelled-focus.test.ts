import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ AgentTrace 折叠/展开焦点保持 + 取消标红（回归锁） ============
 * 背景 1：折叠/展开是两个互斥 return 分支，切换时把获得焦点的按钮从 DOM 卸载，
 * 键盘焦点掉到 body。修复：外层容器恒为 div、切换按钮常驻同一元素位，展开面板
 * 挂在按钮之后（aria-controls 关联）。
 * 背景 2：文件头契约「失败/取消：明确标红，不伪装成功」——此前 cancelled 落进
 * PhaseIcon 默认分支与 pending 同灰色，展开视图里已取消和未开始无法区分。 */

const TRACE = readFileSync(join(process.cwd(), "src/components/agent-trace.tsx"), "utf8");

describe("AgentTrace：单一常驻切换按钮", () => {
  it("只有一个 toggle（不再有第二个「收起」按钮承接折叠），aria-expanded/aria-controls 齐全", () => {
    expect((TRACE.match(/setOpen\(/g) ?? []).length).toBe(1);
    expect(TRACE).toContain("aria-controls={panelId}");
    expect(TRACE).toContain("aria-expanded={expanded}");
    expect(TRACE).not.toMatch(/aria-expanded=\{false\}/);
  });

  it("面板挂在常驻按钮之后：切换前后按钮不卸载，焦点不丢", () => {
    const btnIdx = TRACE.indexOf("<button");
    const panelIdx = TRACE.indexOf('id={panelId}');
    expect(btnIdx).toBeGreaterThan(-1);
    expect(panelIdx).toBeGreaterThan(btnIdx);
    expect(TRACE).not.toContain("if (!expanded) {"); // 不再有两个互斥 return 分支
  });
});

describe("AgentTrace：取消态明确标红（文件头契约）", () => {
  it("PhaseIcon 的 cancelled 不再落进灰色默认分支", () => {
    expect(TRACE).toMatch(/state === "cancelled"\) return <X className="size-3\.5 shrink-0 text-bad\/70" \/>;/);
    expect(TRACE).toMatch(/p\.state === "cancelled"\s*\?\s*"text-bad\/80"/);
  });

  it("failed 保持全红、cancelled 略降透明度以区分", () => {
    expect(TRACE).toMatch(/if \(state === "failed"\) return <X className="size-3\.5 shrink-0 text-bad" \/>;/);
  });
});
