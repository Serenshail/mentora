"use client";

import { useEffect, useState } from "react";
import { Button, Card, Modal, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MessageSquarePlus } from "lucide-react";

const TYPES = ["建议", "问题", "其他"] as const;
const QUEUE_KEY = "mentora-feedback-queue";

interface PendingFeedback {
  type: string;
  content: string;
  contact: string;
  page: string;
}

/** 侧栏底部入口 + 提交模态框。失败自动排队，下次打开重试。 */
export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<(typeof TYPES)[number]>("建议");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState(0);

  const enqueue = (fb: PendingFeedback) => {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
      q.push(fb);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
      setQueued(q.length);
    } catch { /* ignore */ }
  };

  const send = async (fb: PendingFeedback): Promise<boolean> => {
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fb),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  // 打开应用时重试排队中的反馈
  useEffect(() => {
    const retry = async () => {
      try {
        const q: PendingFeedback[] = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
        if (q.length === 0) return;
        const remain: PendingFeedback[] = [];
        for (const fb of q) {
          if (!(await send(fb))) remain.push(fb);
        }
        localStorage.setItem(QUEUE_KEY, JSON.stringify(remain));
        setQueued(remain.length);
        if (remain.length < q.length) {
          toast.success(`${q.length - remain.length} 条排队中的反馈已送达`);
        }
      } catch { /* ignore */ }
    };
    void retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const ok = await send(fb);
    setSending(false);
    if (ok) {
      setContent("");
      setContact("");
      setOpen(false);
      toast.success("已收到，谢谢——每一条都有人看。");
    } else {
      enqueue(fb);
      setContent("");
      setContact("");
      setOpen(false);
      toast.error("暂时没发出去，已存本地，稍后会自动重试。");
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
