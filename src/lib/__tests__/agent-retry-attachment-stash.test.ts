import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { useRuntimeStore } from "../agent/session-runtime";

/* ============ 「继续回答」重试不丢原图（回归锁） ============
 * 背景：三个「继续回答」入口都以 reuseQuestion=true 调 send()；send 在 reuseQuestion
 * 时强制 att=null，而附件在首次发送受理后已被清空，ChatMsg 只存文本不存图片——
 * 带图提问失败/中断后重发只有文本、没有原图，模型对「帮我看这张图哪里错了」给出
 * 无图回答。修复：发送时把原图暂存进运行管理器按会话的 stashedAttachments（内存，
 * 不落盘），重试时取回；纯图片问题在暂存已丢失（刷新）时如实提示，不再渲染点了
 * 没反应的空按钮。暂存走 zustand 而非模块级 Map：渲染路径（unanswered/重试按钮）
 * 要读它，必须是渲染安全的订阅源。 */

const HOME = readFileSync(join(process.cwd(), "src/components/agent-home.tsx"), "utf8");
const RUNTIME = readFileSync(join(process.cwd(), "src/lib/agent/session-runtime.ts"), "utf8");

describe("运行管理器：按会话的重试原图暂存", () => {
  beforeEach(() => {
    useRuntimeStore.setState({ stashedAttachments: {} });
  });

  it("暂存字段与 setter 存在；dropSession/dropAllForUser 一并清理防泄漏", () => {
    expect(RUNTIME).toContain("stashedAttachments: Record<string, Attachment | null>;");
    expect(RUNTIME).toContain("setStashedAttachment: (sessionId, a) =>");
    expect(RUNTIME).toContain("delete stashedAttachments[sessionId];");
    expect(RUNTIME).toContain("stashedAttachments: {},");
  });

  it("暂存只存内存：运行管理器没有 persist（刷新后丢失由 UI 如实提示）", () => {
    expect(RUNTIME).not.toContain("persist(");
  });

  it("行为：set 后按会话取回；置 null 即清掉", () => {
    const att = { dataUrl: "data:image/jpeg;base64,x", name: "截图", w: 10, h: 10 };
    useRuntimeStore.getState().setStashedAttachment("sR", att);
    expect(useRuntimeStore.getState().stashedAttachments["sR"]).toBe(att);
    useRuntimeStore.getState().setStashedAttachment("sR", null);
    expect(useRuntimeStore.getState().stashedAttachments["sR"]).toBeNull();
    useRuntimeStore.getState().dropSession("sR");
    expect(useRuntimeStore.getState().stashedAttachments["sR"]).toBeUndefined();
  });
});

describe("agent-home：重试路径的接线（静态扫描）", () => {
  it("send：reuseQuestion 时从暂存取回原图；新发送留下一份（无图置 null）", () => {
    expect(HOME).toContain("const att = reuseQuestion ? st0.stashedAttachments[sid] ?? null : st0.attachments[sid] ?? null;");
    expect(HOME).toContain("st0.setStashedAttachment(sid, att);");
  });

  it("纯图片重试时走「请讲讲这张图里的内容」兜底提问，不再把占位符当问题发出", () => {
    expect(HOME).toContain('question: !q || (q === "（图片）" && !!att) ? "请讲讲这张图里的内容。" : q');
  });

  it("unanswered 与失败消息上的重试入口同口径：暂存还在才允许纯图片重试", () => {
    expect(HOME).toMatch(/lastMessage\.content !== "（图片）" \|\| !!stashedAttach/);
    expect(HOME).toMatch(/const stashedAttach = useRuntimeStore\(\(s\) => \(activeId \? s\.stashedAttachments\[activeId\] \?\? null : null\)\);/);
    /* 重试判定在渲染体里做纯读取（failedRetry），JSX 只做条件渲染：
     * 渲染期执行的 IIFE 里引用 send 会被 react-hooks/refs 误判为渲染期访问 ref */
    expect(HOME).toMatch(/if \(last\.content === "（图片）"\) return stashedAttach \? \{ kind: "retry" as const, content: last\.content \} : \{ kind: "image-lost" as const \};/);
    expect(HOME).toContain("failedRetry.kind === \"image-lost\"");
    /* 暂存丢失时给提示文案而不是可点无反应的按钮 */
    expect(HOME).toContain("原图没有随会话保存");
  });

  it("重试按钮恢复 cursor-pointer；删除会话时清掉暂存", () => {
    expect(HOME).toMatch(/className="mt-2 cursor-pointer text-xs font-semibold text-accent hover:underline"/);
    expect(HOME).toContain("onClick={() => void send(failedRetry.content, activeSession?.id, true)}");
    expect(HOME).toContain("setStashedAttachment(sess.id, null)");
  });
});
