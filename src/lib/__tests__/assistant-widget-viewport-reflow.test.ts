import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ============ AssistantWidget 悬浮球：视口变化后重新夹取的回归锁 ============
 * 背景（FIX heavy-f39）：pos 只在 pointermove 拖拽时按当时的 innerWidth/innerHeight
 * 夹取；全组件没有 resize/orientationchange 监听，而 AppShell 挂在根 layout、
 * 跨路由常驻不重挂，loadPos 的 clamp 也只在挂载时跑一次。
 * 复现：把球拖到视口右/下边缘 → 旋转手机或缩小窗口 → 球停在视口外，且越界坐标
 * 已被持久化 effect 写进 localStorage，本次会话再也点不回来（只能整页刷新）。
 *
 * 修复：新增 clampPosToViewport 纯函数统一「拖拽 / 挂载恢复 / 视口变化」三处边界，
 * 并在 resize + orientationchange 上重算位置（面板打开期间不监听，避免软键盘
 * 导致的 innerHeight 骤降把球永久挪走）。
 *
 * vitest 无 DOM 环境（无 jsdom/@testing-library），沿用本仓库既有做法：
 *  A) 行为锁：直接对导出的纯函数断言夹取结果与引用稳定性；
 *  B) 源码护栏：静态扫描监听注册/解绑与共用同一公式（同 app-shell-nav-partition.test.ts）。 */

vi.mock("lucide-react", () => ({
  MessageCircleQuestion: () => null,
  Send: () => null,
  Square: () => null,
  X: () => null,
}));
vi.mock("@/lib/use-chat", () => ({
  useChat: () => ({
    messages: [], pending: "", streaming: false, error: null,
    stop: () => {}, send: () => Promise.resolve(""),
  }),
}));
vi.mock("@/lib/utils", () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(" ") }));
vi.mock("@/lib/store", () => ({ useAppStore: { getState: () => ({ addKnowledge: () => {} }) } }));
vi.mock("sonner", () => ({ toast: { success: () => {} } }));

import { clampPosToViewport } from "@/components/assistant-widget";

const SRC = readFileSync(
  join(process.cwd(), "src/components/assistant-widget.tsx"),
  "utf8"
);

/* 与组件内 BTN = 44（size-11）一致 */
const BTN = 44;
const EDGE = 8;

describe("clampPosToViewport：视口变小后必须把球拉回可达区域（行为锁）", () => {
  it("横向缩窗：贴右边缘的球被拉回 vw - BTN - 8", () => {
    /* 桌面 1440 宽时拖到最右：x = 1440 - 44 - 8 = 1388 */
    const p = clampPosToViewport({ x: 1388, y: 300 }, 390, 844, 8);
    expect(p.x).toBe(390 - BTN - EDGE);
  });

  it("纵向缩窗：贴底边的球被拉回 vh - BTN - gap（不再落在视口外）", () => {
    /* 桌面 900 高、gap=8 时最下 y = 900 - 44 - 8 = 848；缩到 400 高后必须回 348 */
    const p = clampPosToViewport({ x: 100, y: 848 }, 1280, 400, 8);
    expect(p.y).toBe(400 - BTN - 8);
  });

  it("旋转后仍尊重移动端底栏+safe 避让：gap 参与下边界计算", () => {
    const mobileGap = 60 + 34 + 8; // --mobile-nav-h + --safe-bottom + 8
    const p = clampPosToViewport({ x: 10, y: 800 }, 390, 844, mobileGap);
    expect(p.y).toBe(844 - BTN - mobileGap);
    expect(p.y).toBeLessThan(844 - BTN);
  });

  it("左上越界（负坐标）同样夹到 8", () => {
    const p = clampPosToViewport({ x: -50, y: -20 }, 1280, 800, 8);
    expect(p).toEqual({ x: EDGE, y: EDGE });
  });

  it("本来就在视口内时返回同一引用（resize 高频触发不得制造多余渲染/写盘）", () => {
    const p = { x: 100, y: 120 };
    expect(clampPosToViewport(p, 1280, 800, 8)).toBe(p);
  });
});

describe("assistant-widget.tsx 源码护栏：视口变化必须有监听且与拖拽同一公式", () => {
  it("注册 resize 与 orientationchange 监听，并在卸载时解绑", () => {
    expect(SRC).toMatch(/addEventListener\("resize"/);
    expect(SRC).toMatch(/addEventListener\("orientationchange"/);
    expect(SRC).toMatch(/removeEventListener\("resize"/);
    expect(SRC).toMatch(/removeEventListener\("orientationchange"/);
  });

  it("键盘陷阱：面板打开期间的 resize 只记账、不就地夹取，关闭后延迟补夹", () => {
    const reflowEffect = SRC.match(
      /useEffect\(\(\) => \{[\s\S]*?addEventListener\("resize"[\s\S]*?\}, \[[^\]]*\]\)/
    );
    expect(reflowEffect, "找不到 resize 监听所在的 effect").not.toBeNull();
    const body = reflowEffect![0];
    /* 打开面板时 resize 必须先返回（软键盘压缩 layout viewport，不得永久挪球） */
    expect(body).toMatch(/if \(open\) \{[\s\S]*?return;/);
    expect(body).toMatch(/reflowPending\.current = true/);
    /* 关闭后延迟补夹，而不是在键盘还在收起时立刻夹 */
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/\}, \[ready, open\]\)/);
  });

  it("拖拽、挂载恢复、视口变化三处共用 clampPosToViewport（防边界公式再次漂移）", () => {
    const drag = SRC.match(/const onPointerMove = [\s\S]*?\n  \};/);
    expect(drag, "找不到 onPointerMove").not.toBeNull();
    expect(drag![0]).toMatch(/clampPosToViewport\(/);

    const load = SRC.match(/function loadPos\(\)[\s\S]*?\n\}/);
    expect(load, "找不到 loadPos").not.toBeNull();
    expect(load![0]).toMatch(/clampPosToViewport\(/);

    const reflowEffect = SRC.match(/useEffect\(\(\) => \{[\s\S]*?addEventListener\("resize"[\s\S]*?\}, \[[^\]]*\]\)/);
    expect(reflowEffect![0]).toMatch(/clampPosToViewport\(/);
  });

  it("仍保留既有 SSR 水合契约（首帧 ready 门控不得被本次修复破坏）", () => {
    expect(SRC).toMatch(/if \(!ready\) return null/);
    expect(SRC).toMatch(/const \[ready, setReady\] = useState\(false\)/);
  });
});
