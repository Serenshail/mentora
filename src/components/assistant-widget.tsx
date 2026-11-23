"use client";

/* 左下角智能体：用户有问题随时问（产品用法、功能在哪、数据去哪了）。
 * 复用全局聊天管线（use-chat），演示模式有分流兜底。
 * 悬浮按钮可拖到任意位置（指针拖动），位置记住在 localStorage；轻点（未移动）才开合面板。 */

import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion, Send, Square, X } from "lucide-react";
import { useChat } from "@/lib/use-chat";
import { ChatActivity } from "@/components/agent-trace";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/store";
import { toast } from "sonner";

const POS_KEY = "mentora-assistant-pos";
/* SSR / 水合首帧共用的固定占位：两端必须逐字一致，绝不读 window / localStorage。
 * 初值若用 loadPos 会在服务端 render 期执行并落到 defaultPos() 的 {x:600,y:600}，
 * 客户端水合读到真实位置 → React 19 对按钮 style left/top 报水合属性不匹配。
 * 真实位置改由挂载后的 init effect 注入（见下方）。 */
const SSR_POS = { x: 600, y: 600 };
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

/* 移动底栏+safe 的避让间距：defaultPos/loadPos/拖拽下边界三处共用一份（此前 12/8 各写各的已漂移）。
 * 桌面无底栏只留 desktop 间距；手机 = --mobile-nav-h + --safe-bottom + mobile 间距（PRD §5.10） */
function bottomGap(desktop: number, mobile: number): number {
  if (typeof window === "undefined" || window.innerWidth >= 768) return desktop;
  const rootStyle = getComputedStyle(document.documentElement);
  const navH = parseFloat(rootStyle.getPropertyValue("--mobile-nav-h")) || 60;
  const safeBottom = parseFloat(rootStyle.getPropertyValue("--safe-bottom")) || 0;
  return navH + safeBottom + mobile;
}

function defaultPos() {
  /* 右下角，但必须落在移动底栏+safe-area 之上（PRD §5.10） */
  if (typeof window === "undefined") return { x: 600, y: 600 };
  return { x: window.innerWidth - BTN - 16, y: window.innerHeight - BTN - bottomGap(16, 12) };
}

function loadPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { x: number; y: number };
      if (typeof p.x === "number" && typeof p.y === "number") {
        /* 旧版本存的位置可能压在移动底栏下（v22 前 defaultPos 没有底栏概念）：迁移一次 */
        return clampPosToViewport(p, window.innerWidth, window.innerHeight, bottomGap(8, 8));
      }
    }
  } catch { /* 忽略 */ }
  return defaultPos();
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/* 把位置夹进当前视口：拖拽、挂载恢复、resize/旋转三处共用同一公式，
 * 避免各处手抄 clamp 边界后漂移。纯函数（视口尺寸与底部避让由调用方传入），
 * 便于在没有 DOM 的 vitest 里直接做回归锁。未越界时返回原引用，省一次渲染。 */
export function clampPosToViewport(
  p: { x: number; y: number },
  vw: number,
  vh: number,
  gap: number
): { x: number; y: number } {
  const x = clamp(p.x, 8, vw - BTN - 8);
  const y = clamp(p.y, 8, vh - BTN - gap);
  return x === p.x && y === p.y ? p : { x, y };
}

export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  /* 初值只能用 SSR 安全固定值：useState(loadPos) 会在服务端 render 期执行，
   * localStorage 失败被吞后落到 defaultPos() 固定 {600,600}，水合时客户端读到
   * 真实位置/真实视口 → style left/top 不匹配。首帧（含水合）不渲染，挂载后注入真实值。 */
  const [pos, setPos] = useState(SSR_POS);
  /* error 要渲染（失败不可见=白烧一次调用用户却不知道）、stop 给流式取消入口。
   * activity 要消费：send 起始到首 token 之间（弱网/推理模型可达数秒）若无任何
   * 进行中提示，用户会以为没发出去而关面板或反复重试（重试被 busyRef 静默吞掉）。
   * 与 council/learn 等其他 useChat 消费方一致，等待期渲染 <ChatActivity>。 */
  const { messages, pending, streaming, activity, error, stop, send } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  /* gap 在 onPointerDown 算一次随 drag 携带：一次拖拽内 bottomGap 不会变，
   * 而 pointermove 高频触发（60-125Hz），每次都 getComputedStyle 读 CSS 变量
   * 会与 setPos 引发的渲染强制样式重算互相争抢主帧，低端移动设备拖拽易掉帧。 */
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean; gap: number } | null>(null);
  /* 拖拽期间的最新位置：pointerup 时用它补写一次 localStorage（拖拽中不逐帧写盘） */
  const dragPos = useRef<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  /* 拖拽/轻点后的 click 只服务键盘开合（Enter/Space 不触发 pointer 事件），指针路径要压掉它防二次切换 */
  const skipClick = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, pending, open, error]);

  /* 三种关闭方式：右上 ✕、Esc、点面板外部（面板曾盖住悬浮球，只靠再点一次关不掉）。
   * 层叠协商：Modal（z-50）与 ⌘K（z-[80]）的 Esc 监听都未 stopPropagation，
   * 而它们的容器都声明了 role="dialog" + aria-modal="true"；此时一次 Esc/一次
   * Modal 内的点击不该顺手把助手面板也关掉——只关最上层。 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      const el = t instanceof Element ? t : t.parentElement;
      if (el?.closest('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  /* 挂载后（仅客户端）再读 localStorage / 真实视口，注入真实位置并放行渲染。
   * 这一步发生在水合完成之后，不参与首帧，故不会触发水合属性不匹配，
   * 也不会出现悬浮球从 (600,600) 闪跳到真实位置。 */
  useEffect(() => {
    /* 一次性的挂载后注入：初值必须是 SSR 安全常量（否则水合不匹配），真实位置
     * 只能在挂载后从 localStorage/视口读，这里是唯一合法时机，不存在级联渲染。 */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后一次性注入真实位置（SSR 初值不能用 loadPos）
    setPos(loadPos());
    setReady(true);
  }, []);

  /* 视口变化（窗口缩放 / 手机旋转）后把球重新夹回当前视口。
   * 拖拽路径的 clamp 只发生在 pointermove，而 AppShell 跨路由常驻不重挂，
   * loadPos 的 clamp 也只在挂载时跑一次：球被拖到右/下边缘后旋转或缩小窗口，
   * 就会停在视口外且这个越界位置已写进 localStorage，本次会话再也点不回来。
   * 用函数式更新读取最新 pos；越界才换新对象，未越界返回原引用，
   * 避免 resize 高频触发多余渲染与写盘。
   *
   * 键盘陷阱：Android 弹出软键盘会压缩 layout viewport 并触发 resize。面板开着时
   * 正是用户在输入的时候，若就地夹取，球（以及锚定在球上的面板）会被永久挪到
   * 键盘顶边并写进 localStorage。故面板打开期间只信 orientationchange（键盘不会
   * 触发它），resize 只记一个待补标记；等面板关闭、键盘收起动画走完再补夹一次。 */
  const reflowPending = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const reflow = () => {
      const gap = bottomGap(8, 8);
      setPos((p) => clampPosToViewport(p, window.innerWidth, window.innerHeight, gap));
    };
    const onResize = () => {
      if (open) {
        reflowPending.current = true; // 可能是软键盘：先记账，关面板后再补
        return;
      }
      reflow();
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", reflow);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!open && reflowPending.current) {
      /* 关闭瞬间键盘还在收起，innerHeight 尚未恢复：等它落定再夹。
       * 标记在真正夹取后才清，避免这期间重开面板把待补事件丢掉。 */
      timer = setTimeout(() => {
        reflowPending.current = false;
        reflow();
      }, 350);
    }
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", reflow);
    };
  }, [ready, open]);

  useEffect(() => {
    /* 占位帧（ready=false）不持久化：否则会用 SSR_POS 覆盖用户已存位置。
     * 拖拽期间也跳过：pointermove 每次都 setPos，[pos] 会让本 effect 每帧同步写一次
     * localStorage（iOS Safari 为同步磁盘 IO），一次拖拽几十上百次冗余盘写与
     * 整组件重渲染；语义上只需落定后存一次最终位置，由 onPointerUp 负责。 */
    if (!ready) return;
    if (drag.current) return;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch { /* 忽略 */ }
  }, [pos, ready]);

  const onPointerDown = (e: React.PointerEvent) => {
    skipClick.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y, moved: false, gap: bottomGap(8, 8) };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved && Math.hypot(dx, dy) < 5) return; // 小于阈值视为点击，不拖
    d.moved = true;
    const next = clampPosToViewport(
      { x: d.ox + dx, y: d.oy + dy },
      window.innerWidth,
      window.innerHeight,
      d.gap
    );
    dragPos.current = next;
    setPos(next);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    skipClick.current = true; // 指针路径在 pointerup 开合，随后的 click 压掉（防二次切换）
    if (d?.moved) {
      /* 拖拽落定才写盘：拖拽期间持久化 effect 已跳过，这里补一次最终位置 */
      const last = dragPos.current;
      if (last) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(last));
        } catch { /* 忽略 */ }
      }
    }
    dragPos.current = null;
    if (d && !d.moved) setOpen((v) => !v); // 轻点 = 开合
  };
  const onToggleClick = () => {
    if (skipClick.current) {
      skipClick.current = false;
      return;
    }
    setOpen((v) => !v); // 键盘 Enter/Space 走这里（pointer 事件不触发，只能靠 click）
  };
  /* 系统手势/来电等打断拖拽时会走 pointercancel 而不是 pointerup：
   * 不复位 drag 的话，之后鼠标从球上划过（超过 5px）就会被陈旧偏移拖着走。 */
  const onPointerCancel = () => {
    drag.current = null;
  };

  /* 把助手的一条回答存进第二大脑（帮用户记笔记） */
  const saveAsNote = (content: string) => {
    const firstLine = content.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() || "助手笔记";
    const title = firstLine.slice(0, 30);
    /* addKnowledge 按 title 全库去重、同名整条丢弃并返回**实际新增**条数
     * （store.ts 的接口注释点名要求调用方据此给真实反馈）。不接返回值的话，
     * 对同一条回答点两次「存为笔记」（或不同回答首行撞名）时第二条根本没入库，
     * 用户却看到成功提示——正是 store 注释里点名要消灭的旧反模式。 */
    const added = useAppStore.getState().addKnowledge([{ title, body: content, domain: "笔记" }], "manual", "AI 助手");
    if (added > 0) toast.success(`已存为笔记「${title}」`);
    else toast.error(`已有同名笔记「${title}」，这次没有重复保存`);
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

  /* 面板优先放在按钮上方，空间不够则放下方；水平方向夹在视口内。
   * 高度自适应：矮视口（vh < ~576）时固定 560px 会把底部输入行推出屏幕。 */
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const panelH = Math.min(PANEL_H, vh - 16);
  const panelLeft = clamp(pos.x, 8, vw - PANEL_W - 8);
  const above = pos.y - panelH - 12 >= 8;
  const panelTop = above ? pos.y - panelH - 12 : clamp(pos.y + BTN + 12, 8, vh - panelH - 8);

  /* SSR 与客户端水合首帧都返回 null：两端标记一致，React 19 不会因按钮 style
   * left/top 报水合不匹配；挂载后 ready=true 才带真实位置渲染，无 (600,600) 闪跳。 */
  if (!ready) return null;

  return (
    <>
      {/* 悬浮按钮：可拖到任意位置 */}
      <button
        ref={btnRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={onToggleClick}
        aria-label={open ? "关闭助手" : "打开助手"}
        title="问点啥（可拖动）"
        style={{ left: pos.x, top: pos.y, width: BTN, height: BTN, touchAction: "none" }}
        className={cn(
          "fixed z-[45] flex items-center justify-center rounded-full shadow-lg transition-colors select-none",
          open ? "bg-ink text-white" : "bg-ink text-white hover:bg-black/80 cursor-grab active:cursor-grabbing"
        )}
      >
        {open ? <X className="size-5" /> : <MessageCircleQuestion className="size-5" />}
      </button>

      {/* 对话面板 */}
      {open && (
        <div
          ref={panelRef}
          style={{
            left: panelLeft,
            top: `clamp(calc(var(--visual-viewport-top, 0px) + 8px), ${panelTop}px, calc(var(--visual-viewport-top, 0px) + var(--visual-viewport-height, 100dvh) - min(${panelH}px, calc(var(--visual-viewport-height, 100dvh) - 16px)) - 8px))`,
            width: `min(${PANEL_W}px, calc(100vw - 1rem))`,
            maxHeight: `min(${panelH}px, calc(var(--visual-viewport-height, 100dvh) - 16px))`,
          }}
          className="fixed z-[45] flex flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-2xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div>
              <p className="text-[13px] font-bold text-ink">Mentora 助手</p>
              <p className="text-[10.5px] text-ink-dim">功能在哪、怎么用，直接问</p>
            </div>
            <button
              onClick={() => setOpen(false)}
              title="关闭（Esc）"
              aria-label="关闭助手"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-dim transition hover:bg-black/[0.06] hover:text-ink"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3.5 py-3">
            {messages.length === 0 && !pending && (
              <div className="space-y-2 rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-dim">
                <p>我是这个产品的使用助手。</p>
                <p>比如问：「Obsidian 怎么导入」「三重验收是什么」「我的笔记去哪了」。</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-3 py-2 text-[12.5px] text-white">
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
            {/* 首 token 前的等待提示：activity 为 null 时组件自身返回 null */}
            {streaming && (
              <ChatActivity activity={activity} waitingLabel="正在思考你的问题" />
            )}
            {pending && (
              <div aria-live="polite" className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
                {pending}
                <span className="stream-cursor" />
              </div>
            )}
            {/* 失败要可见：use-chat 的人话错误文案在此渲染，用户消息不再悬空无回应 */}
            {error && (
              <div role="alert" className="rounded-xl border border-bad/25 bg-bad/[0.05] px-3 py-2 text-[12px] leading-relaxed text-bad">
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-border p-2.5">
            <div className="flex gap-1.5">
              <input
                className="min-w-0 w-full rounded-xl border border-border bg-white px-3 py-2 text-[16px] sm:text-[12.5px] outline-none focus:border-accent/50"
                placeholder="问点什么…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // isComposing：中文输入法选词回车不算发送
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) doSend();
                }}
              />
              {streaming ? (
                <button
                  onClick={stop}
                  aria-label="停止生成"
                  title="停止生成"
                  className="shrink-0 rounded-xl border border-border bg-white px-3 text-ink-dim transition hover:text-ink cursor-pointer"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  onClick={doSend}
                  disabled={!input.trim()}
                  aria-label="发送"
                  className="shrink-0 rounded-xl bg-ink px-3 text-white transition hover:bg-black/80 disabled:opacity-40 cursor-pointer"
                >
                  <Send className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
