import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ AssistantWidget：拖拽写盘节流 + 关闭方式的层叠协商（回归锁） ============
 *  1) 拖拽写盘：onPointerMove 每次 setPos（无 rAF 节流），[pos] 持久化 effect 随之
 *     同步 localStorage.setItem——一次拖拽几十上百次同步盘写（iOS Safari 为同步
 *     磁盘 IO）。语义上只需落定后存最终位置：拖拽期间跳过，pointerup 补写一次。
 *  2) 层叠协商：Esc 监听挂 window、pointerdown 挂 document，都不判断事件是否已被
 *     更上层消费。Modal（ui.tsx:325 aria-modal）与 ⌘K（cmdk.tsx:159）都没
 *     stopPropagation——面板开着时按一次 Esc（或点一下 Modal 内部）会同时关掉
 *     Modal/⌘K 与助手面板。修复：存在 [role=dialog][aria-modal=true] 时不抢关。
 *
 * vitest 无 DOM 环境，沿用本仓库既有静态扫描做法
 * （assistant-widget-viewport-reflow.test.ts / assistant-widget-ssr-pos.test.ts）。 */

const SRC = readFileSync(join(process.cwd(), "src/components/assistant-widget.tsx"), "utf8")
  .replace(/\r\n/g, "\n");

describe("assistant-widget：拖拽期间不逐帧写 localStorage", () => {
  it("持久化 effect 在拖拽中直接跳过", () => {
    const persist = SRC.match(/useEffect\(\(\) => \{[\s\S]*?localStorage\.setItem\(POS_KEY[\s\S]*?\}, \[pos, ready\]\)/);
    expect(persist, "找不到持久化 effect").not.toBeNull();
    expect(persist![0]).toMatch(/if \(drag\.current\) return;/);
  });

  it("pointerup 落定时补写一次最终位置", () => {
    const up = SRC.match(/const onPointerUp = [\s\S]*?\n  \};/);
    expect(up, "找不到 onPointerUp").not.toBeNull();
    expect(up![0]).toMatch(/localStorage\.setItem\(POS_KEY/);
    expect(up![0]).toMatch(/d\?\.moved/);
  });

  it("拖拽位置记录在 ref 里（render 闭包里的 pos 可能落后一帧）", () => {
    expect(SRC).toMatch(/const dragPos = useRef</);
    const move = SRC.match(/const onPointerMove = [\s\S]*?\n  \};/);
    expect(move![0]).toMatch(/dragPos\.current = next/);
  });

  it("轻点开合与拖拽落定仍互斥（点选语义未被本次修复破坏）", () => {
    const up = SRC.match(/const onPointerUp = [\s\S]*?\n  \};/);
    expect(up![0]).toMatch(/if \(d && !d\.moved\) setOpen/);
  });
});

describe("assistant-widget：Esc / 点外部关闭要与更上层对话框协商", () => {
  const closeEffect = SRC.match(/useEffect\(\(\) => \{\n    if \(!open\) return;[\s\S]*?\}, \[open\]\)/);
  it("抽到了关闭效果的函数体", () => {
    expect(closeEffect).not.toBeNull();
  });
  it("Esc 在存在 aria-modal 对话框时不抢关", () => {
    expect(closeEffect![0]).toMatch(/document\.querySelector\('\[role="dialog"\]\[aria-modal="true"\]'\)/);
  });
  it("点外部时不关闭：若点击落在上层对话框内，助手面板保持不动", () => {
    expect(closeEffect![0]).toMatch(/closest\('\[role="dialog"\]\[aria-modal="true"\]'\)/);
  });
});
