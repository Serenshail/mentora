import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { capChatHistoryByBytes } from "../use-chat";
import type { ChatMsg } from "@/lib/types";

/* ============ 阅读对话历史按字节裁剪的回归锁 ============
 * 背景：sendReadingQuestion 每轮把整份 storedBook.chat 作为 history 原样发给 /api/chat。
 * store 侧 BOOK_CHAT_MAX=300 只限条数不限字节——读书教练的长回复（中文 3 字节/字、
 * 含 markdown）会把请求体顶过服务端 1MB 硬闸（api/chat/route.ts readTextBodyWithLimit
 * 直接 413「请求体过大」）。此后每一轮发送与「继续回答」重试都固定 413，历史只增不减、
 * 书页与书架均无清空书聊天的动作——页面永久不可用。
 * 修复：发送前按字节从最新往回裁剪（本地消息不受影响），预算 600KB，给 args
 * （bookCtx 还带全部洞见文本）、系统提示词与 JSON 转义膨胀留 ≥40% 余量。 */

const msg = (i: number, content: string): ChatMsg => ({
  id: `m${i}`,
  role: i % 2 === 0 ? "user" : "assistant",
  content,
  at: new Date().toISOString(),
});

/** 约 bytes 字节的中文文本（中文 UTF-8 3 字节/字） */
const zh = (chars: number) => "书".repeat(chars);

describe("capChatHistoryByBytes：按字节从最新往回保留", () => {
  it("总字节超预算时裁剪：保留的字节 ≤ 预算（含单条 64B 包装开销）", () => {
    // 200 条 × 4000 字 ≈ 2.4MB，预算 600KB
    const history = Array.from({ length: 200 }, (_, i) => msg(i, zh(4000)));
    const kept = capChatHistoryByBytes(history, 600_000);
    expect(kept.length).toBeLessThan(history.length);
    const totalBytes = kept.reduce((n, m) => n + new TextEncoder().encode(m.content).length, 0);
    // 600KB + 每条 64B 开销 + 单条自身超限的容差
    expect(totalBytes).toBeLessThanOrEqual(600_000 + 64 * (kept.length + 1));
  });

  it("裁剪保留的是最新消息（最后一条必在，且顺序不变）", () => {
    const history = Array.from({ length: 50 }, (_, i) => msg(i, zh(2000)));
    const kept = capChatHistoryByBytes(history, 100_000);
    expect(kept.at(-1)?.id).toBe(history.at(-1)?.id);
    expect(kept.at(0)?.id).toBe(history[history.length - kept.length]?.id);
    for (let i = 1; i < kept.length; i++) {
      // 顺序保持：按原索引严格递增
      expect(history.indexOf(kept[i])).toBe(history.indexOf(kept[i - 1]) + 1);
    }
  });

  it("小历史原样返回（不丢任何消息）", () => {
    const history = [msg(0, zh(100)), msg(1, zh(100)), msg(2, zh(100))];
    const kept = capChatHistoryByBytes(history, 600_000);
    expect(kept.map((m) => m.id)).toEqual(history.map((m) => m.id));
  });

  it("最新一条自己超预算也必须保留（空历史会被上游 400 拒绝）", () => {
    const history = [msg(0, zh(400_000)), msg(1, zh(400_000))];
    const kept = capChatHistoryByBytes(history, 1);
    expect(kept.length).toBe(1);
    expect(kept[0].id).toBe(history[1].id);
  });

  it("空历史原样返回", () => {
    expect(capChatHistoryByBytes([], 600_000)).toEqual([]);
  });
});

describe("接线：reading 页发送链路必须走字节裁剪", () => {
  const PAGE = readFileSync(join(process.cwd(), "src/app/read/[id]/page.tsx"), "utf8");

  it("sendReadingQuestion 的 history 不再整份透传 storedBook.chat", () => {
    expect(PAGE).toContain("capChatHistoryByBytes(storedBook.chat)");
  });

  it("从 use-chat 导入裁剪函数", () => {
    expect(PAGE).toMatch(/import \{ useChat, useHydrated, capChatHistoryByBytes \} from "@\/lib\/use-chat"/);
  });
});
