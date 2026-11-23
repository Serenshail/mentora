"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input, Modal, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MessageSquarePlus } from "lucide-react";

const TYPES = ["建议", "问题", "其他"] as const;
const QUEUE_KEY = "mentora-feedback-queue";
const QUEUE_LIMIT = 20; // 本地队列上限：防止无限堆积
const MAX_TRIES = 5; // 单条重试上限：到了就止损移出（临时故障连续 5 次没好，多半不会自己好）
/* 每次挂载最多投递的排队条数。服务端是持久令牌桶 capacity:5、refill 2/min（feedback/
 * route.ts 头部），且与本端点用户的直接提交共用同一 IP 配额——挂载时把整个队列
 * 连发会正面撞上自家限流（第 6 条起全 429）。限量投递 + 429 不计 tries（见 retry），
 * 队列再长也分批送达，不会在被自家限流耗光 tries 后被止损删除、内容从未送达。 */
const RETRY_BATCH = 3;

/* 会话内 tries 兜底：bumpTries 的 localStorage 写入在配额满/被禁时静默失败，计数只
 * 留在内存、磁盘上每次挂载都读到旧值——MAX_TRIES 止损失效，同一页面会话里每挂载
 * 一轮就重发一批。以内容指纹为键挂在模块作用域：组件反复挂载/卸载仍存活，止损在
 * 会话内必然生效；磁盘写得进时磁盘值优先（跨刷新也生效），写不进时由这里兜底。 */
const sessionTries = new Map<string, number>();
const itemKey = (fb: PendingFeedback) => `${fb.type}|${fb.page}|${fb.contact}|${fb.content}`;

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

  /* 四态：ok / 永久失败（内容类 400，重发也没用）/ 限流（自家令牌桶空，不算失败）/
   * 临时失败（网络、5xx、配置缺失） */
  const send = async (fb: PendingFeedback): Promise<"ok" | "fatal" | "retry" | "rate-limited"> => {
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fb),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return "ok";
      /* 429 单列：那是重试循环自己撞上家的每 IP 令牌桶（feedback/route.ts 头部），
       * 不是这条反馈有问题——不能消耗它的生命周期 tries（见 retry 的
       * rate-limited 分支：不计失败、剩余条目留给下次挂载）。 */
      if (res.status === 429) return "rate-limited";
      /* 仅 400（内容太短/太长等）是用户侧确定性失败：重发也不会成功，留在队列
       * 只会每次开页重发、耗光限流额度、角标永久挂着。503 是服务端缺 GITHUB_TOKEN
       * 的部署配置问题（route.ts 仅在 !token 时返回），运营者随时可修好；归入 retry
       * 排队等下次挂载重发，绝不永久删除这条单向反馈（同理任何其他 5xx/网络错）。 */
      if (res.status === 400) return "fatal";
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
    /* 按条删除，不整表覆盖：重试窗口内用户新入队的条目才不会被旧快照抹掉。
     * 返回是否真的写进了盘——存储满时移出失败，调用方要靠 sessionTries 记住止损。 */
    const removeOne = (fb: PendingFeedback): boolean => {
      const cur = readQ();
      const i = cur.findIndex((x) => sameItem(x, fb));
      if (i < 0) return true; // 盘上已无此条，视为已移出
      cur.splice(i, 1);
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(cur));
        setQueued(cur.length);
        return true;
      } catch {
        return false;
      }
    };
    /* 磁盘 best-effort；写失败由 sessionTries 兜底（见文件头注释），止损不再失效 */
    const bumpTries = (fb: PendingFeedback) => {
      const cur = readQ();
      const i = cur.findIndex((x) => sameItem(x, fb));
      if (i < 0) return;
      cur[i] = { ...cur[i], tries: (cur[i].tries ?? 0) + 1 };
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(cur));
      } catch { /* sessionTries 兜底 */ }
    };
    const retry = async () => {
      try {
        const q = readQ();
        if (q.length === 0) return;
        let dropped = 0;
        let sent = 0;
        /* 只投前 RETRY_BATCH 条：余量留给下次挂载，不跟自家令牌桶硬碰 */
        for (const fb of q.slice(0, RETRY_BATCH)) {
          const key = itemKey(fb);
          const memTries = sessionTries.get(key) ?? 0;
          const effTries = Math.max(fb.tries ?? 0, memTries);
          /* 会话内已判死、但上次移出没能写进盘（存储满）：只重试移出，
             不再消耗投递额度，也不再弹「无法送达」 */
          if (memTries >= MAX_TRIES) {
            if (removeOne(fb)) sessionTries.delete(key);
            continue;
          }
          const r = await send(fb);
          if (r === "ok") {
            sent++;
            removeOne(fb);
            sessionTries.delete(key);
          } else if (r === "fatal") {
            dropped++;
            removeOne(fb);
          } else if (r === "rate-limited") {
            /* 撞上自家限流（服务端令牌桶空了）：不算这条失败、不耗 tries，
               剩余条目留给下次挂载——回填 2/min 后自然能继续送 */
            break;
          } else if (effTries + 1 >= MAX_TRIES) {
            // 重试多次仍失败：止损移出，不让角标永久挂着、限流配额白白消耗
            dropped++;
            if (removeOne(fb)) sessionTries.delete(key);
            else sessionTries.set(key, MAX_TRIES); // 移出没写进盘：会话内记死，下轮只重试移出
          } else {
            bumpTries(fb);
            sessionTries.set(key, effTries + 1);
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
                aria-pressed={type === t}
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
          {/* 复用共享 Input（ui.tsx）：移动端 16px 字号防 iOS Safari 聚焦自动放大视口，
              手抄的 text-sm(14px) 会触发缩放跳动；触达高度 h-11 也由共享组件提供 */}
          <Input
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
