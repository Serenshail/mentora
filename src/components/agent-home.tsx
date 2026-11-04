"use client";

/* 首页学习智能体入口（M2）
 * 与学习教练的区别：单点问题直接答、零引导、零建档；
 * 只有用户明确说"想系统学 X"时才在回答末尾建议立目标（不启动引导）。
 * 思考轨迹复用 AgentTrace（检索笔记 → 思考回答 → 折叠耗时）。 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Eraser, ImagePlus, Sparkles, X } from "lucide-react";
import { Card } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { AgentTrace, type TracePhase } from "@/components/agent-trace";
import { useAppStore } from "@/lib/store";
import { streamChat } from "@/lib/ai/client";
import { retrieveEnhanced } from "@/lib/rag-pipeline";
import { todayISO, uid } from "@/lib/utils";
import { toast } from "sonner";
import type { ChatMsg } from "@/lib/types";

const CHIPS = ["协程和线程到底差在哪？", "帮我看下今天该学什么", "用一句话解释闭包"];

/* 图片压缩：模型对超大图会拒绝且浪费 token；长边压到 1400、JPEG 0.82 足够读代码截图 */
async function compressImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持图片处理");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), w, h };
}

interface Attachment {
  dataUrl: string;
  name: string;
  w: number;
  h: number;
}

export function AgentHome() {
  const agentChat = useAppStore((s) => s.agentChat);
  const appendAgentMsg = useAppStore((s) => s.appendAgentMsg);
  const clearAgentChat = useAppStore((s) => s.clearAgentChat);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState(false);
  const [phases, setPhases] = useState<TracePhase[]>([]);
  const [attach, setAttach] = useState<Attachment | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* 粘贴截图：全局监听 paste，有图片就收进附件（不打断输入框正常粘贴文字） */
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      try {
        const img = await compressImage(file);
        setAttach({ ...img, name: "粘贴的截图" });
        toast.success("已读取截图，可以写你的问题");
      } catch {
        toast.error("图片读取失败");
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const pickFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("目前支持图片；文档请用「第二大脑 → 上传文档」");
      return;
    }
    if (f.size > 12 * 1024 * 1024) {
      toast.error("图片太大了（>12MB），请压缩后再传");
      return;
    }
    try {
      const img = await compressImage(f);
      setAttach({ ...img, name: f.name });
    } catch {
      toast.error("图片读取失败");
    }
  };

  const buildCtx = () => {
    const s = useAppStore.getState();
    const goal = s.goals.find((g) => g.status === "active");
    const activeDay = goal?.plan
      ? Object.values(goal.plan.days).find((d) => d.status === "active")
      : null;
    const today = todayISO();
    const due = s.knowledge.filter((k) => k.nextReviewAt && k.nextReviewAt <= today).length;
    return JSON.stringify({
      activeGoal: goal
        ? { topic: goal.topic, direction: goal.direction, currentDay: activeDay?.title ?? null }
        : null,
      dueReviews: due,
      knowledgeCount: s.knowledge.length,
    });
  };

  /* eslint-disable react-hooks/purity -- send 只在事件/effect 回调里执行，
   * 其中的 Date.now() 用于阶段耗时统计，不会在渲染期调用（编译器静态误判） */
  const send = async (text?: string) => {
    const q = (text ?? input).trim();
    /* 只有图片没有文字也允许（"讲讲这段代码"由图片内容本身承载） */
    if ((!q && !attach) || busy) return;
    setInput("");
    setBusy(true);
    setPending("");
    const t0 = Date.now();
    setPhases([{ label: "看看你的笔记", state: "running" }]);
    const shownText = attach ? `${q || "请看这张图"}（附图片）` : q;
    const userMsg: ChatMsg = { id: uid("m"), role: "user", content: shownText, at: new Date().toISOString() };
    appendAgentMsg(userMsg);
    const imgForModel = attach?.dataUrl ?? null;
    setAttach(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      /* 检索增强只在有笔记时才值得跑；失败静默降级（对话不阻塞） */
      let ragCtx = "";
      let ragNote = "没有相关笔记";
      try {
        const notes = useAppStore
          .getState()
          .knowledge.filter((k) => !(k.tags ?? []).includes("MOC"))
          .map((k) => ({
            id: k.id, title: k.title, body: k.body, domain: k.domain,
            links: k.links, version: k.version, updatedAt: k.updatedAt, tags: k.tags,
          }));
        if (notes.length > 0) {
          const r = await retrieveEnhanced(q, notes, 3, { rewrite: false });
          ragCtx = r.context;
          ragNote = ragCtx ? "已带上你的相关笔记" : "没有相关笔记";
        }
      } catch {
        ragNote = "检索失败，改用通识回答";
      }
      const t1 = Date.now();
      const history = [...useAppStore.getState().agentChat].slice(-8).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      setPhases([
        { label: "看看你的笔记", state: "done", durationMs: t1 - t0, detail: ragNote },
        { label: "思考回答", state: "running" },
      ]);
      /* 深度讲解：带图片或用户明确要求讲解时启用教学协议（不受字数限制） */
      const { wantsDeepExplanation } = await import("@/lib/ai/prompts-lite");
      const deep = wantsDeepExplanation(q, !!imgForModel);
      const wire = imgForModel
        ? [
            ...history.slice(0, -1),
            {
              role: "user" as const,
              content: [
                { type: "text" as const, text: q || "请讲讲这张图里的内容。" },
                { type: "image_url" as const, image_url: { url: imgForModel } },
              ],
            },
          ]
        : history;
      const full = await streamChat({
        task: "agent",
        args: { ctx: buildCtx(), ragCtx, deep, hasImage: !!imgForModel },
        messages: wire,
        temperature: deep ? 0.5 : 0.6,
        signal: ac.signal,
        onDelta: (d) => setPending((p) => p + d),
      });
      const t2 = Date.now();
      setPhases((prev) =>
        prev.map((p) => (p.state === "running" ? { ...p, state: "done", durationMs: t2 - t1 } : p))
      );
      if (full.trim()) {
        appendAgentMsg({
          id: uid("m"),
          role: "assistant",
          content: full,
          at: new Date().toISOString(),
        });
      }
      setPending("");
    } catch (e) {
      setPhases((prev) => prev.map((p) => (p.state === "running" ? { ...p, state: "failed" } : p)));
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        toast.error(e instanceof Error ? e.message : "回答失败，请重试");
      }
      setPending("");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };
  /* eslint-enable react-hooks/purity */

  const shown = agentChat.slice(-10);

  return (
    <Card className="border-accent/20 bg-accent/[0.025]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-bold text-ink">
            <Sparkles className="size-4 text-accent" /> 问 Mentora
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-dim">
            单点问题直接答，不用先建目标。想系统学一门东西，再去「学习」排计划。
          </p>
        </div>
        {agentChat.length > 0 && (
          <button
            onClick={clearAgentChat}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-ink-dim transition hover:bg-black/[0.04] hover:text-ink"
            title="清空这段对话"
          >
            <Eraser className="size-3" /> 清空
          </button>
        )}
      </div>

      {shown.length > 0 && (
        <div className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-1">
          {shown.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[#1d1d1f] px-3.5 py-2 text-[12.5px] text-white">
                  {m.content}
                </div>
              ) : (
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-border bg-white px-3.5 py-2.5">
                  <Markdown text={m.content} className="text-[12.5px]" />
                </div>
              )}
            </div>
          ))}
          {pending && (
            <div
              aria-live="polite"
              className="max-w-[92%] rounded-2xl rounded-bl-md border border-border bg-white px-3.5 py-2.5"
            >
              <Markdown text={pending} className="text-[12.5px]" />
              <span className="stream-cursor" />
            </div>
          )}
          <AgentTrace phases={phases} />
        </div>
      )}

      {shown.length === 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {CHIPS.map((c) => (
            <button
              key={c}
              onClick={() => void send(c)}
              className="cursor-pointer rounded-full border border-border bg-white px-3 py-1.5 text-[11.5px] text-ink-dim transition hover:border-accent/40 hover:text-ink"
            >
              {c}
            </button>
          ))}
          <button
            onClick={() => fileRef.current?.click()}
            className="cursor-pointer rounded-full border border-accent/30 bg-accent/[0.06] px-3 py-1.5 text-[11.5px] text-accent transition hover:bg-accent/[0.12]"
          >
            📎 传张截图 / 代码图，让它逐行讲
          </button>
        </div>
      )}

      {attach && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-accent/25 bg-white p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={attach.dataUrl} alt={attach.name} className="size-14 rounded-lg border border-border object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11.5px] font-medium text-ink">{attach.name}</p>
            <p className="text-[10.5px] text-ink-dim">
              {attach.w}×{attach.h} · 会先读图再讲解
            </p>
          </div>
          <button
            onClick={() => setAttach(null)}
            aria-label="移除图片"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-ink-dim transition hover:bg-black/[0.05] hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void pickFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="上传图片（也可以直接 Ctrl+V 粘贴截图）"
          aria-label="上传图片"
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl border border-border bg-white text-ink-dim transition hover:border-accent/40 hover:text-ink"
        >
          <ImagePlus className="size-4" />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && void send()}
          placeholder="问一个具体问题，或贴截图让我逐行讲解（Ctrl+V 可粘贴）"
          disabled={busy}
          className="h-10 w-full rounded-xl border border-border bg-white px-3.5 text-sm outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12] disabled:opacity-60"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          aria-label="发送"
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl bg-[#1d1d1f] text-white transition hover:bg-black/80 disabled:opacity-40"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
      {busy && (
        <button
          onClick={() => abortRef.current?.abort()}
          className="mt-2 cursor-pointer text-[11px] text-ink-dim hover:text-ink"
        >
          停止
        </button>
      )}
    </Card>
  );
}
