"use client";

import { useEffect, useState } from "react";
import { Button, Card, Modal, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MessageSquarePlus } from "lucide-react";

const TYPES = ["建议", "问题", "其他"] as const;
const QUEUE_KEY = "mentora-feedback-queue";
const QUEUE_LIMIT = 20; // 本地队列上限：防止无限堆积
const MAX_TRIES = 5; // 单条重试上限：到了就止损移出（临时故障连续 5 次没好，多半不会自己好）

interface PendingFeedback {
  type: string;
  content: string;
  contact: string;
  page: string;
  tries?: number; // 已重试次数
}

/** 侧栏底部入口 + 提交模态框。失败自动排队，下次打开重试。 */
export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number]>("建议");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState(0);

  /* 入队失败（配额满/存储异常）返回 false：调用方要给"没存下"的专属文案，不能谎报已存 */
  const enqueue = (fb: PendingFeedback): boolean => {
    try {
      const q: PendingFeedback[] = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
      if (q.length >= QUEUE_LIMIT) return false;
      q.push(fb);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
      setQueued(q.length);
      return true;
    } catch {
      return false;
    }
  };

  /* 三态：ok / 永久失败（4xx，重发也没用）/ 临时失败（网络、5xx、限流） */
  const send = async (fb: PendingFeedback): Promise<"ok" | "fatal" | "retry"> => {
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fb),
      });
      if (res.ok) return "ok";
      /* 超长内容（400）与"服务端未配 GITHUB_TOKEN"（503 里其实是配置问题）这类
       * 确定性失败重发一万次也不会成功：留在队列里只会每次开页重发、耗光限流额度，
       * 还让角标永久显示"待同步"。 */
      if (res.status === 400 || res.status === 503) return "fatal";
      return "retry";
    } catch {
      return "retry";
    }
  };

  // 打开应用时重试排队中的反馈
  useEffect(() => {
    const readQ = (): PendingFeedback[] => {
      try {
        return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
      } catch {
        return [];
      }
    };
    const sameItem = (a: PendingFeedback, b: PendingFeedback) =>
      a.content === b.content && a.type === b.type && a.page === b.page && a.contact === b.contact;
    /* 按条删除，不整表覆盖：重试窗口内用户新入队的条目才不会被旧快照抹掉 */
    const removeOne = (fb: PendingFeedback) => {
      const cur = readQ();
      const i = cur.findIndex((x) => sameItem(x, fb));
      if (i < 0) return;
      cur.splice(i, 1);
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(cur));
        setQueued(cur.length);
      } catch { /* ignore */ }
    };
    const bumpTries = (fb: PendingFeedback) => {
      const cur = readQ();
      const i = cur.findIndex((x) => sameItem(x, fb));
      if (i < 0) return;
      cur[i] = { ...cur[i], tries: (cur[i].tries ?? 0) + 1 };
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(cur));
      } catch { /* ignore */ }
    };
    const retry = async () => {
      try {
        const q = readQ();
        if (q.length === 0) return;
        let dropped = 0;
        let sent = 0;
        for (const fb of q) {
          const r = await send(fb);
          if (r === "ok") {
            sent++;
            removeOne(fb);
          } else if (r === "fatal") {
            dropped++;
            removeOne(fb);
          } else if ((fb.tries ?? 0) + 1 >= MAX_TRIES) {
            // 重试多次仍失败：止损移出，不让角标永久挂着、限流配额白白消耗
            dropped++;
            removeOne(fb);
          } else {
            bumpTries(fb);
          }
        }
        setQueued(readQ().length); // 以磁盘现状为准（含重试期间新入队的条目）
        if (sent) toast.success(`${sent} 条排队中的反馈已送达`);
        if (dropped) toast.error(`${dropped} 条排队反馈无法送达，已移出队列——方便的话请重新提交一次`);
      } catch { /* ignore */ }
    };
    void retry();
  }, []);

  const submit = async () => {
    const text = content.trim();
    if (text.length < 2) {
      toast.error("多写两个字吧，太短了收不到重点");
      return;
    }
    setSending(true);
    const fb: PendingFeedback = {
      type,
      content: text,
      contact: contact.trim(),
      page: window.location.pathname,
    };
    const r = await send(fb);
    setSending(false);
    if (r === "ok") {
      setContent("");
      setContact("");
      setOpen(false);
      toast.success("已收到，谢谢——每一条都有人看。");
    } else if (r === "fatal") {
      /* 服务端明确拒收（内容太长等）：排队重试永远不会成功，直接告诉用户 */
      toast.error("这次没能提交（服务端拒收）——请精简内容后再试一次。");
    } else if (enqueue(fb)) {
      setContent("");
      setContact("");
      setOpen(false);
      toast.error("暂时没发出去，已存本地，稍后会自动重试。");
    } else {
      /* 入队也失败（存储配额满/被禁）：内容留在输入框，让用户自己复制，绝不静默丢弃 */
      toast.error("发送失败，本地也存不下——内容还留在输入框，请手动复制保存。");
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-[13px] font-medium text-ink-dim transition-all hover:bg-black/[0.035] hover:text-ink cursor-pointer"
        )}
      >
        <MessageSquarePlus className="size-[18px]" strokeWidth={1.75} />
        反馈
        {queued > 0 && (
          <span className="ml-auto rounded-full bg-warn/[0.12] px-1.5 text-[10px] text-warn">
            {queued}
          </span>
        )}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="反馈">
        <div className="space-y-4">
          <p className="text-sm text-ink-dim">
            用着哪里别扭、想要什么功能、发现了 bug——直接说。反馈直达作者。
          </p>
          <div className="flex gap-2">
            {TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  "rounded-[10px] border px-3.5 py-2 text-xs transition cursor-pointer",
                  type === t
                    ? "border-accent/30 bg-accent/[0.08] font-medium text-accent"
                    : "border-border bg-white text-ink-dim hover:text-ink"
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <Textarea
            rows={5}
            placeholder="说出来（会作为 issue 记录，作者是能看到的）…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <input
            className="h-10 w-full rounded-[10px] border border-border bg-white px-3.5 text-sm outline-none transition focus:border-accent/50 focus:ring-[3px] focus:ring-accent/[0.12]"
            placeholder="联系方式（可选）：邮箱 / 微信 / GitHub，方便回复你"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
          <div className="flex justify-end">
            <Button onClick={submit} loading={sending}>
              发送
            </Button>
          </div>
          {queued > 0 && (
            <Card className="border-warn/25 bg-warn/[0.05] p-3 text-xs text-warn">
              有 {queued} 条反馈存在本地待重发（网络恢复后自动送达）。
            </Card>
          )}
        </div>
      </Modal>
    </>
  );
}
