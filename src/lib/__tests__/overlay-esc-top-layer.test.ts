import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 叠层弹窗的 Esc 只关最上层（回归锁） ============
 * 背景：两个对话框叠开（read-workspace 的核实弹窗叠在添加书籍弹窗上、⌘K z-[80]
 * 叠在 Modal z-50 上）时，两层都在 document 上监听 keydown 且互不隔离，一次 Esc
 * 把两层同时关掉——核实弹窗自己写着「① 换个书名再试：关掉这个弹窗，回到表单」，
 * 点「换个书名」只关核实层，按 Esc 却连底层表单一起关，行为自相矛盾。
 * 修复：ui.tsx 建立模块级叠层登记（registerOverlay/isTopOverlay，登记序=叠放序），
 * ModalDialog 与 CmdKDialog 的 Esc 都只在自身是最高层时才关闭；CmdKDialog 同时补上
 * 与 Modal 同标准的 Tab 环回焦点陷阱（aria-modal 承诺背景不可达）。
 * 沿用仓库既有的源码扫描护栏风格（无 jsdom）。 */

const UI = readFileSync(
  fileURLToPath(new URL("../../components/ui.tsx", import.meta.url)),
  "utf8"
);
const CMDK = readFileSync(
  fileURLToPath(new URL("../../components/cmdk.tsx", import.meta.url)),
  "utf8"
);

describe("叠层弹窗的 Esc 归属：只关最上层", () => {
  it("ui.tsx 提供叠层登记：registerOverlay 返回注销函数，isTopOverlay 判定栈顶", () => {
    expect(UI).toMatch(/const overlayStack: HTMLElement\[\] = \[\];/);
    expect(UI).toMatch(/export function registerOverlay\(el: HTMLElement\): \(\) => void \{/);
    expect(UI).toMatch(/export function isTopOverlay\(el: HTMLElement \| null\): boolean \{/);
  });

  it("ModalDialog：挂载登记、卸载注销，Esc 仅在自身为栈顶时关闭", () => {
    // effect 内登记 + cleanup 注销
    expect(UI).toMatch(/const unregister = box \? registerOverlay\(box\) : \(\) => \{\};/);
    expect(UI).toMatch(/unregister\(\);/);
    // Esc 处理先过 isTopOverlay 闸门
    const escGate = UI.match(/if \(e\.key === "Escape"\) \{\s*\n\s*if \(!isTopOverlay\(boxRef\.current\)\) return;/);
    expect(escGate, "ModalDialog 的 Esc 缺少栈顶闸门").not.toBeNull();
  });

  it("CmdKDialog：同样登记/注销，Esc 过栈顶闸门，并带 Modal 同款 Tab 环回陷阱", () => {
    expect(CMDK).toMatch(/import \{ FOCUSABLE, isTopOverlay, registerOverlay \} from "@\/components\/ui";/);
    expect(CMDK).toMatch(/const unregister = box \? registerOverlay\(box\) : \(\) => \{\};/);
    const escGate = CMDK.match(/if \(e\.key === "Escape"\) \{\s*\n\s*if \(!isTopOverlay\(boxRef\.current\)\) return;/);
    expect(escGate, "CmdKDialog 的 Esc 缺少栈顶闸门").not.toBeNull();
    // Tab 环回（与 ui.tsx Modal 同构）：末位 Tab 回首、首位 Shift+Tab 到末位
    expect(CMDK).toMatch(/if \(e\.shiftKey && document\.activeElement === firstEl\) \{/);
    expect(CMDK).toMatch(/!e\.shiftKey && document\.activeElement === lastEl\)/);
    // 输入框不再拦截 Tab（陷阱接管后自然移动焦点；旧的单框 preventDefault 已删）
    expect(CMDK).not.toMatch(/e\.key === "Tab"\) \{\s*\n\s*e\.preventDefault\(\); \/\/ 单输入面板/);
  });
});
