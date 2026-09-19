"use client";

/* 左下角智能体：用户有问题随时问（产品用法、功能在哪、数据去哪了）。
 * 复用全局聊天管线（use-chat），演示模式有分流兜底。 */

import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion, Send, X } from "lucide-react";
import { useChat } from "@/lib/use-chat";
import { APP_ASSISTANT } from "@/lib/ai/prompts";
import { cn } from "@/lib/utils";

const FEATURE_CTX = `- 第二大脑 = 内嵌 Obsidian：三栏（文件夹树/编辑器/功能面板），[[双链]] 自动补全、#标签、反向链接/出链/大纲面板、Ctrl+K 快速切换、右上「从 Obsidian 导入」可整库导入（大库用仅结构模式）。
- 学习教练：说目标 → 教练摸底 → 总纲要 + 每日讲义 → 验收通过才放行；知识点自动进第二大脑。
- 读书伙伴：粘贴原文/书名 → 深度解剖（定位/作者/谱系/争议）+ 阅读路线（可收起）→ 苏格拉底对话 → 单元「三重验收」（举例/迁移/贴合，≥60 分自动完成）→ 提炼洞见入第二大脑。
- 人生伙伴：12 位智者 + 自定义智能体锻造 + 圆桌模式。
- 账号与同步：注册登录后数据自动云端同步（2.5s 防抖）；换设备登录即恢复。
- 管理后台：/admin，独立密码进入（与账号登录无关）。
- 常见问题：页面空白先强刷（Ctrl+F5）；数据没同步点侧栏「退出」重登；Obsidian 导入后笔记不进复习队列是设计如此（参考类笔记）。`;

export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const { messages, pending, streaming, send } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const mountedOnce = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending, open]);

  const doSend = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send({
      system: APP_ASSISTANT(FEATURE_CTX),
      userText: text,
      task: "app-assistant",
      onDone: () => {},
    });
  };

  void mountedOnce;

  return (
    <>
      {/* 悬浮按钮：左下角 */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="问点啥"
        className={cn(
          "fixed bottom-20 left-4 z-40 flex size-11 items-center justify-center rounded-full shadow-lg transition md:bottom-5 md:left-5",
          open ? "bg-ink text-white" : "bg-[#1a1a1a] text-white hover:bg-black/80 cursor-pointer"
        )}
      >
        {open ? <X className="size-5" /> : <MessageCircleQuestion className="size-5" />}
      </button>

      {/* 对话面板 */}
      {open && (
        <div className="fixed bottom-[5.5rem] left-4 z-40 flex h-[70vh] max-h-[560px] w-[calc(100vw-2rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-2xl md:bottom-[5rem] md:left-[4.5rem]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div>
              <p className="text-[13px] font-bold text-ink">Mentora 助手</p>
              <p className="text-[10.5px] text-ink-dim">功能在哪、怎么用，直接问</p>
            </div>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
            {messages.length === 0 && !pending && (
              <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-dim">
                <p>我是这个产品的使用助手。</p>
                <p>比如问：「Obsidian 怎么导入」「三重验收是什么」「我的笔记去哪了」。</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#1a1a1a] px-3 py-2 text-[12.5px] text-white">
                    {m.content}
                  </div>
                ) : (
                  <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                    {m.content}
                  </div>
                )}
              </div>
            ))}
            {pending && (
              <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
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
                className="shrink-0 rounded-xl bg-[#1a1a1a] px-3 text-white transition hover:bg-black/80 disabled:opacity-40 cursor-pointer"
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
