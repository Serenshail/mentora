import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "../ai/client";

/* ============ NDJSON 完成标记回归锁 ============
 * 服务端在 finally 里必发 {"t":"end"}。此前客户端读到流结束就 return full，
 * 半截回答（网关超时/平台强切）被当成成功：聊天里是残句，结构化任务里
 * 变成「无法解析 JSON」的假错误，真因（连接断了）被掩盖。 */

function ndjsonResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

const ask = { messages: [{ role: "user" as const, content: "hi" }], onDelta: () => {} };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamChat 完成标记", () => {
  it("收到 end 正常返回全文", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjsonResponse(['{"t":"d","v":"你"}\n', '{"t":"d","v":"好"}\n', '{"t":"p"}\n', '{"t":"end"}\n'])
      )
    );
    await expect(streamChat(ask)).resolves.toBe("你好");
  });

  it("流结束却没有 end 标记必须抛错，不把半截当成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjsonResponse(['{"t":"d","v":"半截回答"}\n']))
    );
    await expect(streamChat(ask)).rejects.toThrow(/连接中断/);
  });
});
