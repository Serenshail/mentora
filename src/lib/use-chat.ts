"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type WireMsg, type ChatTask } from "@/lib/ai/client";
import { uid } from "@/lib/utils";
import type { ChatMsg } from "@/lib/types";

export type ChatActivityState = "waiting" | "searching" | "thinking" | "writing" | null;

/**
 * 按字节预算从最新往回裁剪聊天历史（服务端 /api/chat 对请求体有 1MB 硬闸：
 * route.ts 的 readTextBodyWithLimit(req, 1_000_000)，超限直接 413「请求体过大」）。
 * store 侧 BOOK_CHAT_MAX=300 只限条数不限字节——读书教练的长回复（中文 3 字节/字，
 * 含 markdown）会让长聊书的 history 顶过闸，此后每一轮发送与「继续回答」重试都固定
 * 413，且历史只增不减、无清空入口，页面永久不可用。
 *
 * 裁剪只影响发给模型的上文，不改动本地消息列表；从最新往回保留保证最近上下文
 * 永远在场，放不下的最旧消息被跳过。预算 600KB：给 args（bookCtx 还带全部洞见文本）、
 * 系统提示词与 JSON 转义膨胀留出 ≥40% 余量。
 */
export function capChatHistoryByBytes(history: ChatMsg[], maxBytes = 600_000): ChatMsg[] {
  if (history.length === 0) return history;
  const enc = new TextEncoder();
  /* 64 字节 ≈ 单条消息 role/id/at 与 JSON 包装的固定开销（不随内容增长） */
  const cost = (m: ChatMsg) => enc.encode(m.content).length + 64;
  const kept: ChatMsg[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const c = cost(history[i]);
    /* 预算放不下就停：但最新一条必须保留（哪怕它自己超预算）——
     * 空历史会让服务端把空 messages 发给上游，被网关 400 拒绝。 */
    if (used + c > maxBytes && kept.length > 0) break;
    used += c;
    kept.unshift(history[i]);
  }
  return kept;
}

/** 多页复用的流式聊天状态机：消息列表 + 正在流式输出的缓冲 */
export function useChat(initial: ChatMsg[] = []) {
  const [messages, setMessages] = useState<ChatMsg[]>(initial);
  const [pending, setPending] = useState(""); // 正在生成的 assistant 消息
  const [thinking, setThinking] = useState(""); // 推理模型思考期的骨架摘要（不进正文）
  const [streaming, setStreaming] = useState(false);
  const [activity, setActivity] = useState<ChatActivityState>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /* 并发守卫：旧实现只覆盖 abortRef，第二个 send 不会中止第一个——
   * 两条流交错 onDelta 灌 pending，各自用陈旧基线 setMessages 互相覆盖，
   * 还会双倍计费。手动路径有 streaming 判断，挂载效应路径没有。 */
  const busyRef = useRef(false);
  /* 代际：cancel() 换代后，旧流的一切后续写入（delta / 收尾 / 解锁）一律作废。
   * 只 abort 不够——旧 send 的 finally 会在新 send 已开跑之后把 streaming 置回 false、
   * busyRef 置回 false：UI 假装空闲，第三条流还能并发灌同一份 pending。 */
  const genRef = useRef(0);

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
      if (busyRef.current) return "";
      busyRef.current = true;
      const gen = genRef.current;
      const alive = () => genRef.current === gen;
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
      setActivity("waiting");
      setError(null);
      setPending("");
      setThinking("");
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const wire: WireMsg[] = next.map((m) => ({ role: m.role, content: m.content }));
        const full = await streamChat({
          args: opts.args,
          system: opts.system,
          messages: wire,
          temperature: opts.temperature,
          signal: controller.signal,
          task: opts.task,
          onActivity: (stage) => {
            if (alive()) setActivity(stage);
          },
          onDelta: (d) => {
            if (!alive()) return;
            setActivity("writing");
            setPending((p) => p + d);
          },
          onThink: (t) => {
            if (!alive()) return;
            setActivity((prev) => prev === "writing" ? prev : "thinking");
            setThinking((prev) => (prev + t).slice(-80));
          },
        });
        /* 已 cancel：结果不许落进视图（用户已在新会话）。但若这一代恰好在 abort 生效前
         * 已完整到达，回答仍属于发起它的会话——onDone 的 sessionId 闭包是对的，照常落库，
         * 切回来能看到完整回答（addSessionMsg 对已删会话是 no-op）。这就是修复前
         * 「落库正确、只有视图串台」的语义，保持不变。 */
        if (!alive()) {
          opts.onDone?.(full);
          return full;
        }
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (full) {
          const assistant: ChatMsg = {
            id: uid("m"),
            role: "assistant",
            content: full,
            at: new Date().toISOString(),
          };
          setMessages([...next, assistant]);
        } else {
          // 模型 200 但正文为空（BYOK 自定义端点的现实场景）：旧实现既不追加也不报错，
          // 用户对着转圈结束后一片空白。消息不落库（与 council 的 if(full) 守卫同口径），但必须显式报错。
          setError("模型返回了空回复，请重试");
        }
        setPending("");
        setThinking("");
        opts.onDone?.(full);
        return full;
      } catch (e) {
        /* 用户点「停止」/组件卸载：abort 属于本轮自己，代际未变，必须在这里清掉
         * pending/thinking——否则半截回复带着 stream-cursor 留在页面上，看起来仍在
         * 生成（四个消费方都无条件渲染 pending），而输入框其实已解锁。
         * cancel() 路径代际已变（alive() 为 false）：视图由 cancel 清过，且新流可能
         * 已在灌 pending，这里绝不能再写。 */
        if (e instanceof DOMException && e.name === "AbortError") {
          if (alive()) {
            setPending("");
            setThinking("");
          }
          return "";
        }
        // 已 cancel：错误属于用户已经离开的那一轮，不许把它显示到新会话上
        if (!alive()) return "";
        // 弱网/隧道掐断长连接时浏览器抛 TypeError("Failed to fetch"/"network error")——
        // 直译给用户看是懵的，翻译成可行动的话（内容不会丢：长任务重试即可）。
        const isNet =
          e instanceof TypeError ||
          /failed to fetch|networkerror|network error|load failed/i.test(
            e instanceof Error ? e.message : String(e)
          );
        setError(
          isNet
            ? "网络不稳定，连接中断了——内容没丢，点重试即可"
            : e instanceof Error
              ? e.message
              : "出错了，请重试"
        );
        setPending("");
        setThinking("");
        return "";
      } finally {
        /* 旧代的收尾不许动新代的状态：否则新流刚开的 streaming/busy 被旧代一并清掉，
         * 输入框解锁、下一次 send 又放行 → 两条流同时往一份 pending 里灌。 */
        if (alive()) {
          busyRef.current = false;
          setStreaming(false);
          setActivity(null);
        }
      }
    },
    [messages]
  );

  /* 切换/新建会话专用：同步换代 + abort + 立刻清空本代所有视图态。
   * 与 stop()（只掐连接，结果照常落回原会话）的区别：cancel 表示"这一轮已经不属于
   * 用户当前看的会话了"，视图态一律作废；若结果在 abort 生效前已完整到达，仍由
   * onDone 落回发起它的会话（见 send 内 !alive() 分支）。
   * busyRef 同步释放，新会话的开场白才能在同一个 tick 里发出去（旧实现被 busy 守卫静默吞掉）。 */
  const cancel = useCallback(() => {
    genRef.current += 1;
    busyRef.current = false;
    abortRef.current?.abort();
    abortRef.current = null;
    setPending("");
    setThinking("");
    setStreaming(false);
    setActivity(null);
    setError(null);
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // 组件卸载（含路由切换、Suspense 重挂）时中止在途请求：
  // 否则旧组件的请求继续跑到上游，token 白烧，且新组件会再发一次 → 同一轮重复计费。
  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, setMessages, pending, thinking, streaming, activity, error, setError, send, stop, cancel, isBusy: () => busyRef.current };
}

/** 等 store 数据就绪再渲染（防 SSR 水合不一致）。
 *  persist 已 skipHydration,水合由 useAuth 首次 /api/auth/me 后 setStoreUser 同步完成;
 *  故以"认证检查结束"为准——checking=false 即内存已是正确用户仓。 */
export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => {
    // useAuth 的 checking 存在 useAuthStore;checking=false 即切仓已完成。
    // cleanup 不能写进 .then() 的返回值（React 看不见）——用 disposed 旗标在外层收口
    let disposed = false;
    let un1: (() => void) | undefined;
    let t: ReturnType<typeof setTimeout> | undefined;
    import("@/lib/auth-client").then(({ useAuthStore }) => {
      if (disposed) return;
      un1 = useAuthStore.subscribe((s) => {
        if (!s.checking) setH(true);
      });
      if (!useAuthStore.getState().checking) setH(true);
      /* 兜底只防"/api/auth/me 挂起把页面永久锁死"。
       * 不能取 800ms：那时认证还没回来，store 仍停在匿名仓，
       * 放行后写入的新数据会被随后的 setStoreUser(用户仓) 整体覆盖——
       * 这正是"刚建的目标/对话刷新就没了"的根因。6s 覆盖慢网，且 auth 请求本身有 5s 超时。 */
      t = setTimeout(() => setH(true), 6000);
    }).catch(() => {
      /* 部署后旧页面去加载已不存在的 chunk 时，动态 import 会 reject——
       * 旧实现既没有 .catch 也没创建 6s 兜底（计时器写在 .then 里），
       * 该 hook 门控的页面就永远停在骨架，只能手动刷新。放行即可，数据由各页兜底。 */
      if (!disposed) setH(true);
    });
    return () => {
      disposed = true;
      un1?.();
      if (t) clearTimeout(t);
    };
  }, []);
  return h;
}
