"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type WireMsg, type ChatTask } from "@/lib/ai/client";
import { uid } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import type { ChatMsg } from "@/lib/types";

/** 多页复用的流式聊天状态机：消息列表 + 正在流式输出的缓冲 */
export function useChat(initial: ChatMsg[] = []) {
  const [messages, setMessages] = useState<ChatMsg[]>(initial);
  const [pending, setPending] = useState(""); // 正在生成的 assistant 消息
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (opts: {
      /** 纯数据参数：提示词由服务端按 task 组装,前端不持有模板（IP 保护,核心任务用这个） */
      args?: Record<string, unknown>;
      /** 遗留通道：仅 council(persona/圆桌) 暂用,下一步迁移 */
      system?: string;
      userText?: string;
      history?: ChatMsg[];
      onDone?: (full: string) => void;
      temperature?: number;
      task?: ChatTask;
    }) => {
      const history = opts.history ?? messages;
      const next: ChatMsg[] = opts.userText
        ? [
            ...history,
            {
              id: uid("m"),
              role: "user" as const,
              content: opts.userText,
              at: new Date().toISOString(),
            },
          ]
        : history;
      if (opts.userText) setMessages(next);
      setStreaming(true);
      setError(null);
      setPending("");
      abortRef.current = new AbortController();
      try {
        const wire: WireMsg[] = next.map((m) => ({ role: m.role, content: m.content }));
        const full = await streamChat({
          args: opts.args,
          system: opts.system,
          messages: wire,
          temperature: opts.temperature,
          signal: abortRef.current.signal,
          task: opts.task,
          onDelta: (d) => setPending((p) => p + d),
        });
        if (full) {
          const assistant: ChatMsg = {
            id: uid("m"),
            role: "assistant",
            content: full,
            at: new Date().toISOString(),
          };
          setMessages([...next, assistant]);
        }
        setPending("");
        opts.onDone?.(full);
        return full;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return "";
        setError(e instanceof Error ? e.message : "出错了，请重试");
        setPending("");
        return "";
      } finally {
        setStreaming(false);
      }
    },
    [messages]
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { messages, setMessages, pending, streaming, error, setError, send, stop };
}

/** 等 zustand persist 完成再渲染 store 数据（防 SSR 水合不一致） */
export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => {
    if (useAppStore.persist.hasHydrated()) {
      setH(true);
      return;
    }
    const unsub = useAppStore.persist.onFinishHydration(() => setH(true));
    return unsub;
  }, []);
  return h;
}
