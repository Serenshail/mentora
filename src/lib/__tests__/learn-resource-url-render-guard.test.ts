import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* ============ 资源链接渲染侧协议校验（回归锁） ============
 * 背景：写入侧 sanitizeResUrls（只放行 http(s)）仅挂在两条生成写入路径；到达
 * 渲染 <a href={r.url} target="_blank"> 的值还可能来自 agent 工具
 * update_plan_resources 直写、旧版本写入后经云同步回流、refineResources 失败时
 * 的原样返回。原生 <a> 没有 react-markdown 的 urlTransform 防护。
 *
 * 修复：渲染前对 rankResources 结果做同口径过闸——非 http(s) 的 url 置 undefined，
 * 条目降级为纯文本（进 offline 组渲染），不再生成可点击的 <a>。 */

const PAGE = readFileSync(
  fileURLToPath(new URL("../../app/learn/[id]/page.tsx", import.meta.url)),
  "utf8"
);

const dayPanel = PAGE.slice(PAGE.indexOf("function DayPanel"));
const guard = dayPanel.slice(
  dayPanel.indexOf("const ranked = rankResources(day.resources)"),
  dayPanel.indexOf("const online =")
);

describe("learn/[id]：资源渲染侧与写入侧同口径过闸", () => {
  it("ranked 结果先做 /^https?:\\/\\//i 校验，非法协议降级为纯文本条目", () => {
    expect(guard).toContain('/^https?:\\/\\//i.test(r.url)');
    expect(guard).toContain("{ ...r, url: undefined }");
  });

  it("写入侧 sanitizeResUrls 仍在（双闸并存，不回退）", () => {
    const sanitize = PAGE.slice(
      PAGE.indexOf("function sanitizeResUrls"),
      PAGE.indexOf("function genCtx")
    );
    expect(sanitize).toContain('/^https?:\\/\\//i.test(r.url)');
  });

  it("在线/离线分组以过闸后的 ranked 计算（非法 url 不进 <a href>）", () => {
    const group = dayPanel.slice(
      dayPanel.indexOf("const online ="),
      dayPanel.indexOf("const row =")
    );
    expect(group).toMatch(/online = ranked\.filter\(\(r\) => r\.url\)/);
    expect(group).toMatch(/offline = ranked\.filter\(\(r\) => !r\.url\)/);
  });
});
