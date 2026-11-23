import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/* ============ 流式增量批处理（回归锁） ============
 * 背景：client.ts 按 SSE 事件逐条触发 onDelta，旧实现每条 delta 都对整个已累计
 * 正文做拼接 + 两个全文正则 + stripMetaSentences 全文重处理，再触发 LiveRun 的
 * 全文 Markdown 重解析——单帧成本随已生成长度线性增长，整体 O(n²)：长回答
 * （30-40KB + 数千条 delta）累计数十秒主线程工作量，正文追赶不上流。
 * 修复：delta 攒进缓冲，80ms 时间窗合并后再 strip+patch；重置/收尾/异常路径
 * 都处理缓冲，保证终态消息拿到完整正文。 */

const HOME = readFileSync(join(process.cwd(), "src/components/agent-home.tsx"), "utf8");

describe("send() 的流式增量批处理", () => {
  it("onDelta 只攒缓冲 + 时间窗冲刷，剥离逻辑移到 flushDelta 统一做", () => {
    expect(HOME).toContain("deltaBuf += d;");
    expect(HOME).toContain("setTimeout(flushDelta, 80)");
    expect(HOME).toContain("const flushDelta = () => {");
    /* 全文正则与 stripMetaSentences 只在 flushDelta 里出现一次 */
    expect((HOME.match(/stripMetaSentences\(noFence\)/g) ?? []).length).toBe(1);
  });

  it("收尾与异常路径先冲刷缓冲：终态消息不能丢尾段", () => {
    const tryFlush = HOME.indexOf("flushDelta(); // 收尾前冲刷");
    const catchFlush = HOME.indexOf("flushDelta(); // 异常路径先冲刷缓冲");
    expect(tryFlush).toBeGreaterThan(-1);
    expect(catchFlush).toBeGreaterThan(tryFlush);
    /* 异常路径按 partialAnswer 保留半截回答，冲刷必须发生在读取之前 */
    expect(catchFlush).toBeLessThan(HOME.indexOf("const cur = useRuntimeStore.getState().views[sid]?.run;", catchFlush));
  });

  it("onResetDelta 同时清缓冲：重开段落时旧片段不会被拼回新段开头", () => {
    const start = HOME.indexOf("onResetDelta:");
    const end = HOME.indexOf("onDelta:", start);
    const body = HOME.slice(start, end);
    expect(body).toContain('deltaBuf = "";');
    expect(body).toContain("clearTimeout(deltaTimer)");
  });
});
