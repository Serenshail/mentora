import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* E2 验收 6：键盘流程完整——弹窗打开/关闭/焦点返回 + 核心按钮可键盘操作。
 * 仓库无 DOM 环境（同 read-book-card-keyboard.test.ts 先例），按语义锚点锁源码。 */

const ui = readFileSync(fileURLToPath(new URL("../../components/ui.tsx", import.meta.url)), "utf8");
const council = readFileSync(fileURLToPath(new URL("../../app/council/page.tsx", import.meta.url)), "utf8");
const home = readFileSync(fileURLToPath(new URL("../../components/agent-home.tsx", import.meta.url)), "utf8");

describe("Modal 焦点管理（弹窗打开/关闭/返回）", () => {
  it("打开时把焦点移入对话框首个可聚焦元素", () => {
    expect(ui).toMatch(/const items = focusables\(\);\s*\n\s*\(items\[0\] \?\? boxRef\.current\)\?\.focus\(\)/);
  });

  it("Esc 关闭，Tab/Shift+Tab 在对话框内循环（不逃出）", () => {
    expect(ui).toMatch(/if \(e\.key === "Escape"\)/);
    expect(ui).toMatch(/e\.shiftKey && document\.activeElement === firstEl/);
    expect(ui).toMatch(/!e\.shiftKey && document\.activeElement === lastEl/);
  });

  it("关闭后焦点返回原触发元素（prev?.focus()）", () => {
    expect(ui).toMatch(/const prev = document\.activeElement/);
    expect(ui).toMatch(/prev\?\.focus\(\)/);
  });

  it("有 role=dialog / aria-modal（读屏可识别）", () => {
    expect(ui).toMatch(/role="dialog"/);
    expect(ui).toMatch(/aria-modal/);
  });

  it("焦点陷阱只挂载一次（依赖 []），避免每渲染抢焦点", () => {
    expect(ui).toMatch(/\}, \[\]\);/);
  });
});

describe("核心按钮可键盘操作（原生 button / 不吞键盘事件）", () => {
  it("首页停止/批准/拒绝都是原生 button（Enter/Space 可用）", () => {
    /* 审批卡：批准/拒绝（v3 起卡片渲染在 LiveRun 里，回调仍是 decide） */
    expect(home).toMatch(/onClick=\{\(\) => onDecide\(a\.id, true\)\}/);
    expect(home).toMatch(/onClick=\{\(\) => onDecide\(a\.id, false\)\}/);
    /* 停止：与发送同一个原生 <button>（busy 时切方形停止），不是 div+onClick、
       也不再是输入框下方的小字；有可读 aria-label，键盘 Enter/Space 可激活 */
    expect(home).toMatch(/onClick=\{\(\) => \(busy \? stop\(\) : void send\(\)\)\}/);
    expect(home).toMatch(/aria-label=\{busy \? "停止当前回答" : "发送消息"\}/);
  });

  it("圆桌重试/停止/忽略都是原生 button", () => {
    expect(council).toMatch(/onClick=\{\(\) => void roundtableSend\("", rtRetry\)\}/);
    expect(council).toMatch(/onClick=\{cancelRoundtable\}/);
    expect(council).toMatch(/onClick=\{\(\) => setRtRetry\(null\)\}/);
  });

  it("任务块折叠按钮有 aria-expanded（读屏可播报状态）", () => {
    expect(home).toMatch(/aria-expanded=\{open\}/);
  });
});

describe("状态不只靠颜色（E2 验收 6）", () => {
  it("席位失败同时有图标与文字", () => {
    const idx = council.indexOf("发言失败（本轮结束后可单独重试）");
    expect(idx).toBeGreaterThan(-1);
    const block = council.slice(idx - 260, idx + 60);
    expect(block).toContain("<X");
    expect(block).toContain("text-bad");
  });

  it("重试横幅说明谁失败、保留了什么", () => {
    expect(council).toMatch(/发言失败；\$\{Object\.keys\(rtRetry\.goodTakes\)\.length\} 席发言已保留/);
  });

  it("深链指向不存在会话时有明确提示（不静默回退）", () => {
    expect(council).toMatch(/链接指向的会话不存在/);
    expect(council).toMatch(/deepLinkMissing/);
  });
});
