"use client";

/* 左下角智能体：用户有问题随时问（产品用法、功能在哪、数据去哪了）。
 * 复用全局聊天管线（use-chat），演示模式有分流兜底。
 * 悬浮按钮可拖到任意位置（指针拖动），位置记住在 localStorage；轻点（未移动）才开合面板。 */

import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion, Send, X } from "lucide-react";
import { useChat } from "@/lib/use-chat";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { toast } from "sonner";

const POS_KEY = "mentora-assistant-pos";
const BTN = 44; // size-11
const PANEL_W = 384; // max-w-sm
const PANEL_H = 560; // max-h

const FEATURE_CTX = `- 第二大脑 = 内嵌 Obsidian：三栏（文件夹树/编辑器/功能面板），[[双链]] 自动补全、#标签、反向链接/出链/大纲面板、Ctrl+K 快速切换、右上「从 Obsidian 导入」可整库导入（大库用仅结构模式）。
- 学习教练：说目标 → 教练摸底 → 总纲要 + 每日讲义 → 验收通过才放行；知识点自动进第二大脑。
- 读书伙伴：粘贴原文/书名 → 深度解剖（定位/作者/谱系/争议）+ 阅读路线（可收起）→ 苏格拉底对话 → 单元「三重验收」（举例/迁移/贴合，≥60 分自动完成）→ 提炼洞见入第二大脑。
- 人生伙伴：12 位智者 + 自定义智能体锻造 + 圆桌模式。
- 账号与同步：注册登录后数据自动云端同步（2.5s 防抖）；换设备登录即恢复。
- 管理后台：/admin，独立密码进入（与账号登录无关）。
- 常见问题：页面空白先强刷（Ctrl+F5）；数据没同步点侧栏「退出」重登；Obsidian 导入后笔记不进复习队列是设计如此（参考类笔记）。`;

function defaultPos() {
  /* 右下角：左下是侧栏用户区/提示条，压住它们=挡信息；右下空旷，面板向上展开 */
  if (typeof window === "undefined") return { x: 600, y: 600 };
  return { x: window.innerWidth - BTN - 16, y: window.innerHeight - BTN - 16 };
}

function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { x: number; y: number };
      if (typeof p.x === "number" && typeof p.y === "number") return p;
    }
  } catch { /* 忽略 */ }
  return defaultPos();
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [pos, setPos] = useState(loadPos);
  const { messages, pending, streaming, send } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending, open]);

  useEffect(() => {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch { /* 忽略 */ }
  }, [pos]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 5) return; // 小于阈值视为点击，不拖
    d.moved = true;
    setPos({
      x: clamp(d.ox + dx, 8, window.innerWidth - BTN - 8),
      y: clamp(d.oy + dy, 8, window.innerHeight - BTN - 8),
    });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) setOpen((v) => !v); // 轻点 = 开合
  };

  /* 把助手的一条回答存进第二大脑（帮用户记笔记） */
  const saveAsNote = (content: string) => {
    const firstLine = content.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() || "助手笔记";
    const title = firstLine.slice(0, 30);
    useAppStore.getState().addKnowledge([{ title, body: content, domain: "笔记" }], "manual", "AI 助手");
    toast.success(`已存为笔记「${title}」`);
  };

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send({
      args: { ctx: FEATURE_CTX },
      userText: text,
      task: "app-assistant",
      onDone: () => {},
    });
  };

  /* 面板优先放在按钮上方，空间不够则放下方；水平方向夹在视口内 */
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const panelLeft = clamp(pos.x, 8, vw - PANEL_W - 8);
  const above = pos.y - PANEL_H - 12 >= 8;
  const panelTop = above ? pos.y - PANEL_H - 12 : clamp(pos.y + BTN + 12, 8, vh - PANEL_H - 8);

  return (
    <>
      {/* 悬浮按钮：可拖到任意位置 */}
      <button
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="问点啥（可拖动）"
        style={{ left: pos.x, top: pos.y, width: BTN, height: BTN, touchAction: "none" }}
        className={cn(
          "fixed z-40 flex items-center justify-center rounded-full shadow-lg transition-colors select-none",
          open ? "bg-ink text-white" : "bg-[#1d1d1f] text-white hover:bg-black/80 cursor-grab active:cursor-grabbing"
        )}
      >
        {open ? <X className="size-5" /> : <MessageCircleQuestion className="size-5" />}
      </button>

      {/* 对话面板 */}
      {open && (
        <div
          style={{ left: panelLeft, top: panelTop, width: `min(${PANEL_W}px, calc(100vw - 1rem))`, maxHeight: PANEL_H }}
          className="fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div>
              <p className="text-[13px] font-bold text-ink">Mentora 助手</p>
              <p className="text-[10.5px] text-ink-dim">功能在哪、怎么用，直接问</p>
            </div>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3" style={{ minHeight: 200 }}>
            {messages.length === 0 && !pending && (
              <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-dim">
                <p>我是这个产品的使用助手。</p>
                <p>比如问：「Obsidian 怎么导入」「三重验收是什么」「我的笔记去哪了」。</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#1d1d1f] px-3 py-2 text-[12.5px] text-white">
                    {m.content}
                  </div>
                ) : (
                  <div className="max-w-[92%]">
                    <div className="whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                      {m.content}
                    </div>
                    <button
                      onClick={() => saveAsNote(m.content)}
                      className="mt-1 cursor-pointer rounded-md px-1.5 py-0.5 text-[10.5px] text-ink-dim transition hover:bg-black/[0.05] hover:text-ink"
                      title="把这条回答存进第二大脑"
                    >
                      ＋ 存为笔记
                    </button>
                  </div>
                )}
              </div>
            ))}
            {pending && (
              <div aria-live="polite" className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                {pending}
                <span className="stream-cursor" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-border p-2.5">
            <div className="flex gap-1.5">
              <input
                className="w-full rounded-xl border border-border bg-white px-3 py-2 text-[12.5px] outline-none focus:border-accent/50"
                placeholder="问点什么…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSend()}
              />
              <button
                onClick={doSend}
                disabled={streaming || !input.trim()}
                className="shrink-0 rounded-xl bg-[#1d1d1f] px-3 text-white transition hover:bg-black/80 disabled:opacity-40 cursor-pointer"
              >
                <Send className="size-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
